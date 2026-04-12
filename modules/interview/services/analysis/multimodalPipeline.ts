import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { MultimodalAnalysis } from '@shared/db/models/MultimodalAnalysis'
import { User } from '@shared/db/models/User'
import { getDownloadPresignedUrl } from '@shared/storage/r2'
import { trackUsage } from '@shared/services/usageTracking'
import { aiLogger } from '@shared/logger'
import { isFeatureEnabled } from '@shared/featureFlags'
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
  /**
   * Camera webm key — present for normal sessions, absent for privacy-mode
   * sessions where the candidate opted out of video storage. The pipeline
   * transcribes whichever audio source is available (see `audioRecordingR2Key`).
   */
  recordingR2Key?: string
  /** Optional audio-only key used in preference to the camera webm for Whisper
   * transcription, since Groq Whisper rejects files >25MB. Required when
   * `recordingR2Key` is absent (privacy mode). */
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
  /**
   * Fine-grained facial timeseries — the aggregator re-run with fixed 1-second
   * windows and blendshape statistics enabled. Persisted for the replay UI's
   * high-resolution signal plots and as direct input to the dual-pipeline
   * comparison experiment.
   */
  facialTimeseries: Array<Record<string, unknown>>
}

// Fixed-width window used for the facial timeseries. 1s chosen to match the
// per-second resolution the replay UI's signal chart expects; a 10-min
// interview produces ~600 windows × ~100B ≈ 60KB in Mongo.
export const FACIAL_TIMESERIES_WINDOW_SEC = 1

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
  // Privacy-mode sessions skip the camera webm upload but still ship the
  // small audio-only track, which is all Whisper needs. Require at least
  // one audio source.
  if (!session.recordingR2Key && !session.audioRecordingR2Key) {
    throw new Error('Session has no recording or audio track')
  }

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
 * Three paths, in order of preference:
 *   1. `liveTranscriptWords` (Deepgram fast path) — synthesised word-level
 *      segments. Primary path. No API call, no cost, instant.
 *   2. `sessionTranscript` fallback — for sessions without Deepgram words,
 *      build coarse segments from the stored transcript entries. No word-level
 *      timestamps but everything downstream still works. Avoids the slow
 *      Whisper call when running on a constrained function timeout.
 *   3. Whisper API (slow path) — 60-120s. Only used if no transcript source
 *      is available (effectively never with the fallback in place).
 */
export async function stepTranscribeAndDownload(
  recordingR2Key: string | undefined,
  facialLandmarksR2Key?: string,
  audioRecordingR2Key?: string,
  liveTranscriptWords?: LiveTranscriptWord[],
  sessionTranscript?: Array<{ speaker: string; text: string; timestamp: number }>
): Promise<{ whisper: TranscribeResult; facialFrames: FacialFrame[] }> {
  // Path 1: Fast path — live Deepgram words (primary, no cost, instant)
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

  // Path 2: Legacy text fallback — use stored transcript entries as segments.
  // No word-level timestamps, but downstream prosody + fusion only need
  // segment-level start/end/text. Saves 60-120s of Whisper time, important
  // when running inline within a Vercel function timeout.
  if (sessionTranscript && sessionTranscript.length > 0) {
    const facialFrames = await downloadFacialFrames(facialLandmarksR2Key)
    const synthetic = synthesiseWhisperResultFromTranscript(sessionTranscript)
    aiLogger.info(
      { source: 'session-transcript', entries: sessionTranscript.length, durationSec: synthetic.durationSeconds },
      'Multimodal analysis using session transcript fallback (Whisper skipped)'
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

  // Path 3: Whisper API (slow path, 60-120s).
  // Prefer the audio-only key — it's ~1–2MB vs 30–80MB for the camera webm,
  // keeping us under Groq's 25MB upload limit.
  const whisperKey = audioRecordingR2Key || recordingR2Key
  if (!whisperKey) {
    throw new Error('No audio source available for transcription')
  }
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

/**
 * Legacy fallback: build WhisperSegment[] from session transcript entries.
 * No word-level timestamps — each candidate transcript entry becomes a segment
 * spanning from its timestamp to the next entry's timestamp. Words are
 * synthesised by even distribution within the segment duration. Used when
 * no liveTranscriptWords are present, to avoid the 60-120s Whisper call
 * that doesn't fit in a tight inline budget.
 */
function synthesiseWhisperResultFromTranscript(
  transcript: Array<{ speaker: string; text: string; timestamp: number }>
): { segments: WhisperSegment[]; durationSeconds: number } {
  const candidateEntries = transcript
    .filter((e) => e.speaker === 'candidate' || e.speaker === 'user')
    .sort((a, b) => a.timestamp - b.timestamp)

  if (candidateEntries.length === 0) {
    return { segments: [], durationSeconds: 0 }
  }

  // Normalise timestamps to seconds relative to the first candidate utterance.
  const t0 = candidateEntries[0].timestamp
  const segments: WhisperSegment[] = candidateEntries.map((entry, i) => {
    const start = Math.max(0, (entry.timestamp - t0) / 1000)
    const nextTimestamp = i + 1 < candidateEntries.length ? candidateEntries[i + 1].timestamp : entry.timestamp + 5000
    const end = Math.max(start + 1, (nextTimestamp - t0) / 1000)
    const wordTokens = entry.text.split(/\s+/).filter(Boolean)
    const perWord = wordTokens.length > 0 ? (end - start) / wordTokens.length : 0
    const words: WhisperWord[] = wordTokens.map((w, wi) => ({
      word: w,
      start: start + wi * perWord,
      end: start + (wi + 1) * perWord,
      confidence: 1,
    }))
    return {
      id: i,
      start,
      end,
      text: entry.text,
      words,
    }
  })

  const durationSeconds = segments.length > 0 ? segments[segments.length - 1].end : 0
  return { segments, durationSeconds }
}

/** Step 3: Extract prosody + aggregate facial signals.
 *  @param skipTimeseries — when true, skip the per-second facial timeseries
 *  generation (saves 3-5s). Used in inline mode where the 60s budget is tight.
 *  The replay UI will show "Timeseries unavailable" but core analysis works. */
export function stepProcessSignals(
  whisperSegments: Array<Record<string, unknown>>,
  facialFrames: FacialFrame[],
  questionBoundaries: number[],
  totalDurationSec: number,
  skipTimeseries: boolean = false
): ProcessedSignals {
  const prosodySegments = extractProsody(
    whisperSegments as unknown as Parameters<typeof extractProsody>[0],
    questionBoundaries,
    totalDurationSec
  )

  // Per-question boundaries — compact output for the fusion prompt.
  // Always includes blendshape stats when available.
  const facialSegments = aggregateFacialData(
    facialFrames,
    questionBoundaries,
    totalDurationSec,
    { includeBlendshapeStats: true }
  )

  // Fixed 1s windows — fine-grained timeseries for the replay UI.
  // Skipped in inline mode to save 3-5s of CPU time.
  const facialTimeseries = skipTimeseries
    ? []
    : aggregateFacialData(
        facialFrames,
        questionBoundaries,
        totalDurationSec,
        { windowSec: FACIAL_TIMESERIES_WINDOW_SEC, includeBlendshapeStats: true }
      )

  return {
    prosodySegments: prosodySegments as unknown as Array<Record<string, unknown>>,
    facialSegments: facialSegments as unknown as Array<Record<string, unknown>>,
    facialTimeseries: facialTimeseries as unknown as Array<Record<string, unknown>>,
  }
}

/** Step 4: Run Claude fusion analysis */
export async function stepRunFusion(
  prosodySegments: Array<Record<string, unknown>>,
  facialSegments: Array<Record<string, unknown>>,
  evaluations: Array<Record<string, unknown>>,
  transcript: Array<Record<string, unknown>>,
  config: Record<string, unknown>,
  options: { includeBlendshapes?: boolean; whisperSegments?: Array<Record<string, unknown>> } = {}
) {
  // Extract low-confidence words from whisper segments for fusion analysis
  let lowConfidenceWords: Array<{ word: string; start: number; confidence: number }> | undefined
  if (options.whisperSegments) {
    const allWords: Array<{ word: string; start: number; confidence: number }> = []
    for (const seg of options.whisperSegments) {
      const words = (seg.words as Array<{ word: string; start: number; confidence: number }>) || []
      for (const w of words) {
        if (typeof w.confidence === 'number' && w.confidence < 0.85) {
          allWords.push({ word: w.word, start: w.start, confidence: Math.round(w.confidence * 100) / 100 })
        }
      }
    }
    if (allWords.length > 0) {
      lowConfidenceWords = allWords.sort((a, b) => a.confidence - b.confidence).slice(0, 20)
    }
  }

  return await runFusionAnalysis({
    prosodySegments: prosodySegments as unknown as Parameters<typeof runFusionAnalysis>[0]['prosodySegments'],
    facialSegments: facialSegments as unknown as Parameters<typeof runFusionAnalysis>[0]['facialSegments'],
    evaluations: evaluations as unknown as Parameters<typeof runFusionAnalysis>[0]['evaluations'],
    transcript: transcript as unknown as Parameters<typeof runFusionAnalysis>[0]['transcript'],
    config: config as unknown as Parameters<typeof runFusionAnalysis>[0]['config'],
    includeBlendshapes: options.includeBlendshapes === true,
    lowConfidenceWords,
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
    facialTimeseries: Array<Record<string, unknown>>
    timeline: Array<Record<string, unknown>>
    fusionSummary: Record<string, unknown>
    baselineTimeline?: Array<Record<string, unknown>>
    baselineFusionSummary?: Record<string, unknown>
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
      facialTimeseries: data.facialTimeseries,
      timeline: data.timeline,
      fusionSummary: data.fusionSummary,
      ...(data.baselineTimeline && { baselineTimeline: data.baselineTimeline }),
      ...(data.baselineFusionSummary && { baselineFusionSummary: data.baselineFusionSummary }),
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
  userId: string,
  options?: { inline?: boolean }
): Promise<void> {
  const startTime = Date.now()
  const isInline = options?.inline === true

  try {
    const session = await stepFetchSession(sessionId)
    const { whisper, facialFrames } = await stepTranscribeAndDownload(
      session.recordingR2Key,
      session.facialLandmarksR2Key,
      session.audioRecordingR2Key,
      session.liveTranscriptWords,
      session.transcript
    )
    const signals = stepProcessSignals(
      whisper.segments,
      facialFrames,
      session.questionBoundaries,
      whisper.durationSeconds,
      isInline // skip facial timeseries in inline mode to save 3-5s
    )

    // ─── Dual-pipeline gating (#4, Option B) ──────────────────────────
    // Run the fusion twice — once with blendshape stats in the facial
    // block, once without — only when:
    //   1. The research_comparison feature flag is on, AND
    //   2. The session owner has opted in via researchDonationConsent, AND
    //   3. The aggregator actually produced blendshape stats (i.e. the
    //      session has post-April-2026 frames carrying blendshapes).
    // Otherwise run the enhanced variant once and persist it as usual.
    //
    // NEVER run dual-pipeline in inline mode — the 60s Vercel timeout
    // cannot accommodate two sequential Claude calls.
    const dualRun = isInline
      ? false
      : await shouldRunDualPipeline(userId, signals.facialSegments)

    // Enhanced variant (what the user sees)
    const enhanced = await stepRunFusion(
      signals.prosodySegments,
      signals.facialSegments,
      session.evaluations,
      session.transcript as unknown as Array<Record<string, unknown>>,
      session.config,
      { includeBlendshapes: true }
    )

    // Baseline variant (categorical expression only) — only run when
    // dual-pipeline gating passed. Same prosody + content + transcript
    // inputs; only the facial block changes.
    let baseline: Awaited<ReturnType<typeof stepRunFusion>> | null = null
    if (dualRun) {
      baseline = await stepRunFusion(
        signals.prosodySegments,
        signals.facialSegments,
        session.evaluations,
        session.transcript as unknown as Array<Record<string, unknown>>,
        session.config,
        { includeBlendshapes: false }
      )
      aiLogger.info(
        {
          sessionId,
          enhancedPromptBytes: enhanced.promptLength,
          baselinePromptBytes: baseline.promptLength,
          promptByteDelta: enhanced.promptLength - baseline.promptLength,
          enhancedBodyLanguage: enhanced.fusionSummary.overallBodyLanguageScore,
          baselineBodyLanguage: baseline.fusionSummary.overallBodyLanguageScore,
          enhancedEyeContact: enhanced.fusionSummary.eyeContactScore,
          baselineEyeContact: baseline.fusionSummary.eyeContactScore,
        },
        'Dual-pipeline comparison run completed'
      )
    }

    await stepPersistResults(sessionId, userId, {
      whisperSegments: whisper.segments,
      prosodySegments: signals.prosodySegments,
      facialSegments: signals.facialSegments,
      facialTimeseries: signals.facialTimeseries,
      timeline: enhanced.timeline as unknown as Array<Record<string, unknown>>,
      fusionSummary: enhanced.fusionSummary as unknown as Record<string, unknown>,
      baselineTimeline: baseline
        ? (baseline.timeline as unknown as Array<Record<string, unknown>>)
        : undefined,
      baselineFusionSummary: baseline
        ? (baseline.fusionSummary as unknown as Record<string, unknown>)
        : undefined,
      facialLandmarksR2Key: session.facialLandmarksR2Key,
      whisperCostUsd: whisper.costUsd,
      // Sum token counts across both runs when dual-pipeline ran so cost
      // tracking reflects the actual Claude spend.
      fusionInputTokens: enhanced.inputTokens + (baseline?.inputTokens || 0),
      fusionOutputTokens: enhanced.outputTokens + (baseline?.outputTokens || 0),
      startTime,
    })
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error'
    aiLogger.error({ err, sessionId }, 'Multimodal analysis pipeline failed')
    await stepMarkFailed(sessionId, errorMessage, startTime)
    throw err
  }
}

/**
 * Decide whether to run the dual-pipeline comparison for this session.
 * Requires the feature flag, opted-in user consent, and at least one facial
 * segment carrying blendshape summary statistics (otherwise the enhanced
 * and baseline variants would receive identical inputs and the comparison
 * would be meaningless).
 */
export async function shouldRunDualPipeline(
  userId: string,
  facialSegments: Array<Record<string, unknown>>
): Promise<boolean> {
  if (!isFeatureEnabled('research_comparison')) return false
  if (facialSegments.length === 0) return false

  const hasBlendshapeStats = facialSegments.some(
    (s) => s.meanBlendshapes && typeof s.meanBlendshapes === 'object'
  )
  if (!hasBlendshapeStats) return false

  try {
    const user = await User.findById(userId).select('privacyConsent').lean()
    return user?.privacyConsent?.researchDonationConsent === true
  } catch {
    return false
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
