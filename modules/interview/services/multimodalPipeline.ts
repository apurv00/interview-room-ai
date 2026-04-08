import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { MultimodalAnalysis } from '@shared/db/models/MultimodalAnalysis'
import { getDownloadPresignedUrl } from '@shared/storage/r2'
import { trackUsage } from '@shared/services/usageTracking'
import { aiLogger } from '@shared/logger'
import { transcribeRecording } from './whisperService'
import { extractProsody } from './prosodyService'
import { aggregateFacialData } from './facialAggregator'
import { runFusionAnalysis } from './fusionService'
import type {
  FacialFrame,
  WhisperSegment,
  WhisperWord,
} from '@shared/types/multimodal'
import type { AuthUser } from '@shared/middleware/withAuth'

interface LiveTranscriptWord {
  word: string
  start: number
  end: number
  confidence: number
}

// ─── Step result types ──────────────────────────────────────────────────────

export interface SessionData {
  sessionId: string
  recordingR2Key: string
  /** Optional audio-only key used in preference to the camera webm for Whisper
   * transcription, since Groq Whisper rejects files >25MB. */
  audioRecordingR2Key?: string
  facialLandmarksR2Key?: string
  /** Deepgram-captured words from the live interview with audio-timeline
   * relative timestamps. When present, the pipeline skips Whisper entirely
   * and uses these directly — no network call, no 25MB limit, no cost. */
  liveTranscriptWords?: LiveTranscriptWord[]
  transcript: Array<{ speaker: string; text: string; timestamp: number; questionIndex?: number | null }>
  evaluations: Array<Record<string, unknown>>
  config: Record<string, unknown>
  questionBoundaries: number[]
}

export interface TranscribeResult {
  segments: Array<Record<string, unknown>>
  durationSeconds: number
  costUsd: number
}

export interface ProcessedSignals {
  prosodySegments: Array<Record<string, unknown>>
  facialSegments: Array<Record<string, unknown>>
}

// ─── Pipeline steps (each can be called independently for testing) ─────────

/** Step 1: Fetch session data and validate */
export async function stepFetchSession(sessionId: string): Promise<SessionData> {
  await connectDB()

  await MultimodalAnalysis.findOneAndUpdate(
    { sessionId },
    { status: 'processing' }
  )

  const session = await InterviewSession.findById(sessionId)
  if (!session) throw new Error(`Session ${sessionId} not found`)
  if (!session.recordingR2Key) throw new Error('Session has no recording')

  const questionBoundaries = (session.transcript || [])
    .filter((t) => t.speaker === 'interviewer')
    .map((t) => t.timestamp)

  return {
    sessionId,
    recordingR2Key: session.recordingR2Key,
    audioRecordingR2Key: session.audioRecordingR2Key,
    facialLandmarksR2Key: session.facialLandmarksR2Key,
    liveTranscriptWords: (session.liveTranscriptWords as LiveTranscriptWord[] | undefined) ?? undefined,
    transcript: session.transcript || [],
    evaluations: session.evaluations as unknown as Array<Record<string, unknown>>,
    config: session.config as unknown as Record<string, unknown>,
    questionBoundaries,
  }
}

/** Step 2: Transcribe recording + download facial data (parallel).
 *
 * When `liveTranscriptWords` is present (captured from Deepgram during the
 * interview), Whisper is skipped entirely — no API call, no download, no
 * cost. This is the primary path for all sessions recorded after the
 * Deepgram-dedup change landed. Legacy sessions fall back to Whisper.
 */
export async function stepTranscribeAndDownload(
  recordingR2Key: string,
  facialLandmarksR2Key?: string,
  audioRecordingR2Key?: string,
  liveTranscriptWords?: LiveTranscriptWord[]
): Promise<{ whisper: TranscribeResult; facialFrames: FacialFrame[] }> {
  // Fast path: synthesise the Whisper-shaped result from the live words.
  if (liveTranscriptWords && liveTranscriptWords.length > 0) {
    const facialFrames = await downloadFacialFrames(facialLandmarksR2Key)
    const synthetic = synthesiseWhisperResultFromLiveWords(liveTranscriptWords)
    aiLogger.info(
      { source: 'live-deepgram', words: liveTranscriptWords.length, durationSec: synthetic.durationSeconds },
      'Multimodal analysis using live transcript (Whisper skipped)'
    )
    return {
      whisper: {
        segments: synthetic.segments as unknown as Array<Record<string, unknown>>,
        durationSeconds: synthetic.durationSeconds,
        costUsd: 0,
      },
      facialFrames: facialFrames as unknown as FacialFrame[],
    }
  }

  // Fallback: post-hoc Whisper on the audio-only track (or camera webm
  // for pre-#183 sessions). Kept for backward compatibility.
  const whisperKey = audioRecordingR2Key || recordingR2Key
  const [whisperResult, facialFrames] = await Promise.all([
    transcribeRecording(whisperKey),
    downloadFacialFrames(facialLandmarksR2Key),
  ])

  return {
    whisper: {
      segments: whisperResult.segments as unknown as Array<Record<string, unknown>>,
      durationSeconds: whisperResult.durationSeconds,
      costUsd: whisperResult.costUsd,
    },
    facialFrames: facialFrames as unknown as FacialFrame[],
  }
}

/**
 * Shape live Deepgram words into the WhisperSegment structure that the
 * prosody extractor and replay UI already consume. Produces a single
 * "segment" per continuous talking chunk — we split when the gap between
 * consecutive words exceeds 1.5s, which matches how Whisper itself
 * segments utterances. No external call, no cost.
 */
function synthesiseWhisperResultFromLiveWords(words: LiveTranscriptWord[]): {
  segments: WhisperSegment[]
  durationSeconds: number
} {
  if (words.length === 0) return { segments: [], durationSeconds: 0 }

  // Sort defensively — words should already be ordered by start time, but
  // out-of-order pushes across reconnects could break the invariant.
  const sorted = [...words].sort((a, b) => a.start - b.start)

  const SEGMENT_GAP_SEC = 1.5
  const segments: WhisperSegment[] = []
  let currentStart = sorted[0].start
  let currentWords: WhisperWord[] = []

  for (let i = 0; i < sorted.length; i++) {
    const w = sorted[i]
    const prev = sorted[i - 1]
    if (prev && w.start - prev.end > SEGMENT_GAP_SEC) {
      // Flush the current segment.
      segments.push({
        id: segments.length,
        start: currentStart,
        end: prev.end,
        text: currentWords.map((x) => x.word).join(' ').trim(),
        words: currentWords,
      })
      currentStart = w.start
      currentWords = []
    }
    currentWords.push({
      word: w.word,
      start: w.start,
      end: w.end,
      confidence: w.confidence,
    })
  }

  // Flush trailing segment.
  if (currentWords.length > 0) {
    segments.push({
      id: segments.length,
      start: currentStart,
      end: currentWords[currentWords.length - 1].end,
      text: currentWords.map((x) => x.word).join(' ').trim(),
      words: currentWords,
    })
  }

  const durationSeconds = sorted[sorted.length - 1].end
  return { segments, durationSeconds }
}

/** Step 3: Extract prosody + aggregate facial signals */
export function stepProcessSignals(
  whisperSegments: Array<Record<string, unknown>>,
  facialFrames: FacialFrame[],
  questionBoundaries: number[],
  totalDurationSec: number
): ProcessedSignals {
  const prosodySegments = extractProsody(
    whisperSegments as unknown as Parameters<typeof extractProsody>[0],
    questionBoundaries,
    totalDurationSec
  )

  const facialSegments = aggregateFacialData(
    facialFrames,
    questionBoundaries,
    totalDurationSec
  )

  return {
    prosodySegments: prosodySegments as unknown as Array<Record<string, unknown>>,
    facialSegments: facialSegments as unknown as Array<Record<string, unknown>>,
  }
}

/** Step 4: Run Claude fusion analysis */
export async function stepRunFusion(
  prosodySegments: Array<Record<string, unknown>>,
  facialSegments: Array<Record<string, unknown>>,
  evaluations: Array<Record<string, unknown>>,
  transcript: Array<Record<string, unknown>>,
  config: Record<string, unknown>
) {
  return await runFusionAnalysis({
    prosodySegments: prosodySegments as unknown as Parameters<typeof runFusionAnalysis>[0]['prosodySegments'],
    facialSegments: facialSegments as unknown as Parameters<typeof runFusionAnalysis>[0]['facialSegments'],
    evaluations: evaluations as unknown as Parameters<typeof runFusionAnalysis>[0]['evaluations'],
    transcript: transcript as unknown as Parameters<typeof runFusionAnalysis>[0]['transcript'],
    config: config as unknown as Parameters<typeof runFusionAnalysis>[0]['config'],
  })
}

/** Step 5: Persist results and track usage */
export async function stepPersistResults(
  sessionId: string,
  userId: string,
  data: {
    whisperSegments: Array<Record<string, unknown>>
    prosodySegments: Array<Record<string, unknown>>
    facialSegments: Array<Record<string, unknown>>
    timeline: Array<Record<string, unknown>>
    fusionSummary: Record<string, unknown>
    facialLandmarksR2Key?: string
    whisperCostUsd: number
    fusionInputTokens: number
    fusionOutputTokens: number
    startTime: number
  }
): Promise<void> {
  await connectDB()

  const claudeCostUsd = parseFloat(
    ((data.fusionInputTokens / 1000) * 0.001 + (data.fusionOutputTokens / 1000) * 0.005).toFixed(4)
  )
  const totalCostUsd = parseFloat((data.whisperCostUsd + claudeCostUsd).toFixed(4))
  const processingDurationMs = Date.now() - data.startTime

  await MultimodalAnalysis.findOneAndUpdate(
    { sessionId },
    {
      status: 'completed',
      whisperTranscript: data.whisperSegments,
      prosodySegments: data.prosodySegments,
      facialSegments: data.facialSegments,
      timeline: data.timeline,
      fusionSummary: data.fusionSummary,
      facialFramesR2Key: data.facialLandmarksR2Key || undefined,
      whisperCostUsd: data.whisperCostUsd,
      claudeCostUsd,
      totalCostUsd,
      processingDurationMs,
      completedAt: new Date(),
    }
  )

  const mockUser: AuthUser = { id: userId, email: '', role: 'candidate', plan: 'free' }
  await trackUsage({
    user: mockUser,
    type: 'api_call_whisper',
    sessionId,
    inputTokens: 0,
    outputTokens: 0,
    modelUsed: 'whisper-large-v3-turbo',
    durationMs: processingDurationMs,
    success: true,
  }).catch(() => {})

  await trackUsage({
    user: mockUser,
    type: 'api_call_multimodal_fusion',
    sessionId,
    inputTokens: data.fusionInputTokens,
    outputTokens: data.fusionOutputTokens,
    modelUsed: 'claude-haiku-4-5-20251001',
    durationMs: processingDurationMs,
    success: true,
  }).catch(() => {})

  aiLogger.info(
    { sessionId, processingDurationMs, totalCostUsd, timelineEvents: data.timeline.length },
    'Multimodal analysis pipeline completed'
  )
}

/** Mark pipeline as failed */
export async function stepMarkFailed(
  sessionId: string,
  error: string,
  startTime: number
): Promise<void> {
  await connectDB()
  await MultimodalAnalysis.findOneAndUpdate(
    { sessionId },
    { status: 'failed', error, processingDurationMs: Date.now() - startTime }
  )
}

// ─── Full pipeline ──────────────────────────────────────────────────────────

/**
 * Run the full multimodal analysis pipeline for a completed interview.
 * Called inline from POST /api/analysis/start (no external worker).
 */
export async function runMultimodalPipeline(
  sessionId: string,
  userId: string
): Promise<void> {
  const startTime = Date.now()

  try {
    const session = await stepFetchSession(sessionId)
    const { whisper, facialFrames } = await stepTranscribeAndDownload(
      session.recordingR2Key,
      session.facialLandmarksR2Key,
      session.audioRecordingR2Key,
      session.liveTranscriptWords
    )
    const signals = stepProcessSignals(
      whisper.segments,
      facialFrames,
      session.questionBoundaries,
      whisper.durationSeconds
    )
    const fusionResult = await stepRunFusion(
      signals.prosodySegments,
      signals.facialSegments,
      session.evaluations,
      session.transcript as unknown as Array<Record<string, unknown>>,
      session.config
    )
    await stepPersistResults(sessionId, userId, {
      whisperSegments: whisper.segments,
      prosodySegments: signals.prosodySegments,
      facialSegments: signals.facialSegments,
      timeline: fusionResult.timeline as unknown as Array<Record<string, unknown>>,
      fusionSummary: fusionResult.fusionSummary as unknown as Record<string, unknown>,
      facialLandmarksR2Key: session.facialLandmarksR2Key,
      whisperCostUsd: whisper.costUsd,
      fusionInputTokens: fusionResult.inputTokens,
      fusionOutputTokens: fusionResult.outputTokens,
      startTime,
    })
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error'
    aiLogger.error({ err, sessionId }, 'Multimodal analysis pipeline failed')
    await stepMarkFailed(sessionId, errorMessage, startTime)
    throw err
  }
}

async function downloadFacialFrames(r2Key?: string): Promise<FacialFrame[]> {
  if (!r2Key) return []

  try {
    const url = await getDownloadPresignedUrl(r2Key, 300)
    const response = await fetch(url)
    if (!response.ok) return []
    return (await response.json()) as FacialFrame[]
  } catch (err) {
    aiLogger.warn({ err, r2Key }, 'Failed to download facial frames — continuing without')
    return []
  }
}
