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
}

// ─── Aggregated Facial Metrics (per question window) ────────────────────────

export interface FacialSegment {
  startSec: number
  endSec: number
  avgEyeContact: number            // 0–1
  dominantExpression: string
  headStability: number            // 0–1 (1 = very stable)
  gestureLevel: 'minimal' | 'moderate' | 'expressive'
  questionIndex?: number
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
  overallBodyLanguageScore: number  // 0–100
  eyeContactScore: number           // 0–100
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
