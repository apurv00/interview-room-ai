// ─── Multimodal Interview Analysis Types ─────────────────────────────────────

// ─── Whisper Transcription ───────────────────────────────────────────────────

export interface WhisperWord {
  word: string
  start: number  // seconds from recording start
  end: number
  confidence: number
}

export interface WhisperSegment {
  id: number
  start: number
  end: number
  text: string
  words: WhisperWord[]
}

// ─── Prosody Features (derived from Whisper timestamps) ─────────────────────

export interface ProsodySegment {
  startSec: number
  endSec: number
  wpm: number
  fillerWords: Array<{ word: string; timestampSec: number }>
  pauseDurationSec: number         // total pause time in this segment
  confidenceMarker: 'high' | 'medium' | 'low'
  questionIndex?: number
}

// ─── Facial Landmarks (captured client-side by MediaPipe) ───────────────────

export interface FacialFrame {
  ts: number                       // seconds from recording start
  gazeX: number                    // normalized -1 to 1 (0 = center)
  gazeY: number
  headPoseYaw: number              // degrees
  headPosePitch: number
  expression: 'neutral' | 'smile' | 'frown' | 'surprise' | 'focused'
  eyeContactScore: number          // 0–1 (1 = looking at camera)

  // Full MediaPipe blendshape vector (52 ARKit-style dimensions, each 0–1).
  // Optional for backwards compatibility with sessions recorded before April 2026.
  // Used by the post-interview fusion pipeline to provide a richer facial signal
  // than the 5-class `expression` label alone.
  blendshapes?: Record<string, number>
}

// ─── Aggregated Facial Metrics (per question window, or per fixed-width window) ──

export interface FacialSegment {
  startSec: number
  endSec: number
  avgEyeContact: number            // 0–1
  dominantExpression: string
  headStability: number            // 0–1 (1 = very stable)
  gestureLevel: 'minimal' | 'moderate' | 'expressive'
  questionIndex?: number

  // Blendshape summary statistics for this window — present when the source
  // FacialFrames carried blendshapes. Consumed by the dual-pipeline
  // comparison experiment (#4) to test whether a richer facial representation
  // produces measurably different coaching signals than the categorical label.
  meanBlendshapes?: Record<string, number>
  maxBlendshapes?: Record<string, number>
}

// ─── Timeline Events (fused output) ─────────────────────────────────────────

export type TimelineEventType = 'strength' | 'improvement' | 'observation' | 'coaching_tip'
export type TimelineSignalSource = 'audio' | 'facial' | 'content' | 'fused'
export type TimelineSeverity = 'positive' | 'neutral' | 'attention'

export interface TimelineEvent {
  startSec: number
  endSec: number
  type: TimelineEventType
  signal: TimelineSignalSource
  title: string
  description: string
  severity?: TimelineSeverity
  questionIndex?: number
}

// ─── Fusion Summary ─────────────────────────────────────────────────────────

export interface FusionSummary {
  // 0–100, or null when no valid facial data was captured (privacy-mode
  // sessions, camera muted mid-interview, MediaPipe produced zero usable
  // frames). null is the honest "we don't know" — the fusion LLM used
  // to fabricate plausible 65-80 scores here when the server sent no
  // facialSignals block. Readers must render "N/A" (or similar) when
  // null; `app/feedback/[sessionId]/page.tsx:1324,1328` handles both.
  overallBodyLanguageScore: number | null
  eyeContactScore: number | null
  confidenceProgression: string     // narrative description
  topMoments: TimelineEvent[]       // best 3 moments
  improvementMoments: TimelineEvent[] // top 3 areas to improve
  coachingTips: string[]            // 3–5 actionable tips
}

// ─── Analysis Job ────────────────────────────────────────────────────────────

export type AnalysisStatus = 'pending' | 'processing' | 'completed' | 'failed'

export interface MultimodalAnalysisData {
  sessionId: string
  userId: string
  status: AnalysisStatus

  // Whisper output
  whisperTranscript?: WhisperSegment[]

  // Derived audio features
  prosodySegments?: ProsodySegment[]

  // Facial pipeline output (raw frames stored in R2 if large)
  facialFramesR2Key?: string
  facialSegments?: FacialSegment[]
  /**
   * Fine-grained facial time series — the same aggregator re-run over fixed
   * N-second windows (default 1s) instead of per-question boundaries. Used
   * for higher-resolution signal plots in the replay UI and as the direct
   * input to the dual-pipeline comparison experiment.
   */
  facialTimeseries?: FacialSegment[]

  // Fusion output
  timeline?: TimelineEvent[]
  fusionSummary?: FusionSummary

  // Cost tracking
  whisperCostUsd?: number
  claudeCostUsd?: number
  totalCostUsd?: number
  processingDurationMs?: number

  error?: string
  completedAt?: Date
  createdAt?: Date
  updatedAt?: Date
}
