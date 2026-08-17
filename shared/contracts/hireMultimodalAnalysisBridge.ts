import { z } from 'zod'
import {
  IsoDateTimeSchema,
  MongoObjectIdStringSchema,
  Sha256HexSchema,
} from './hireEngineBridge'
import { HIRE_RUNTIME_MAX_FENCED_BODY_BYTES } from './hireRuntimeWriteFence'

/**
 * Hire's recorded-interview analysis bridge is intentionally distinct from
 * the consumer coaching bridge. It transports a private landmark artifact
 * and immutable interview timing input; it never carries a hiring decision.
 */
export const HIRE_MULTIMODAL_ANALYSIS_BRIDGE_SCHEMA_VERSION = 1 as const
export const HIRE_MULTIMODAL_ANALYSIS_POLICY_VERSION =
  'hire-recorded-interview-analysis-v1'

export const HIRE_MULTIMODAL_ANALYSIS_MAX_DURATION_MS = 30 * 60 * 1_000
export const HIRE_MULTIMODAL_ANALYSIS_MAX_FRAMES = 10_000
export const HIRE_MULTIMODAL_ANALYSIS_MAX_BLENDSHAPES = 80
export const HIRE_MULTIMODAL_ANALYSIS_MAX_TRANSCRIPT_ENTRIES = 5_000
export const HIRE_MULTIMODAL_ANALYSIS_MAX_LIVE_WORDS = 25_000
/**
 * This crosses the Hire runtime write fence, so it must never exceed the
 * proxy's buffered-body budget. The browser transport helper below samples
 * a valid frame stream when necessary rather than risking a late 413.
 */
export const HIRE_MULTIMODAL_ANALYSIS_CAPTURE_MAX_BODY_BYTES =
  HIRE_RUNTIME_MAX_FENCED_BODY_BYTES
export const HIRE_MULTIMODAL_ANALYSIS_MAX_ARTIFACT_BYTES =
  HIRE_MULTIMODAL_ANALYSIS_CAPTURE_MAX_BODY_BYTES

export const HIRE_MULTIMODAL_EXPRESSIONS = [
  'neutral',
  'smile',
  'frown',
  'surprise',
  'focused',
] as const

export const HireMultimodalAnalysisFacialFrameSchema = z
  .object({
    /** Recording-relative seconds, aligned with audio word timings. */
    ts: z.number().finite().min(0).max(HIRE_MULTIMODAL_ANALYSIS_MAX_DURATION_MS / 1_000),
    gazeX: z.number().finite().min(-1).max(1),
    gazeY: z.number().finite().min(-1).max(1),
    headPoseYaw: z.number().finite().min(-180).max(180),
    headPosePitch: z.number().finite().min(-180).max(180),
    expression: z.enum(HIRE_MULTIMODAL_EXPRESSIONS),
    eyeContactScore: z.number().finite().min(0).max(1),
    blendshapes: z
      .record(
        z.string().trim().min(1).max(64),
        z.number().finite().min(0).max(1),
      )
      .refine(
        (value) => Object.keys(value).length <= HIRE_MULTIMODAL_ANALYSIS_MAX_BLENDSHAPES,
        'Too many blendshape dimensions',
      )
      .optional(),
  })
  .strict()

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Preserve useful frames when an occasional MediaPipe value is malformed.
 * The raw-frame cap is checked first so a hostile oversized request never
 * obtains unbounded server-side sanitation work.
 */
export function sanitizeHireMultimodalAnalysisFrames(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  if (value.length > HIRE_MULTIMODAL_ANALYSIS_MAX_FRAMES) return value
  const frames: unknown[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') {
      frames.push(raw)
      continue
    }
    const frame = raw as Record<string, unknown>
    const required = [
      frame.ts,
      frame.gazeX,
      frame.gazeY,
      frame.headPoseYaw,
      frame.headPosePitch,
      frame.eyeContactScore,
    ]
    if (!required.every(isFiniteNumber)) continue
    if (
      frame.blendshapes !== undefined &&
      (!frame.blendshapes ||
        typeof frame.blendshapes !== 'object' ||
        !Object.values(frame.blendshapes as Record<string, unknown>).every(isFiniteNumber))
    ) {
      continue
    }
    frames.push({
      ...frame,
      ts: clamp(frame.ts as number, 0, HIRE_MULTIMODAL_ANALYSIS_MAX_DURATION_MS / 1_000),
      gazeX: clamp(frame.gazeX as number, -1, 1),
      gazeY: clamp(frame.gazeY as number, -1, 1),
    })
  }
  return frames
}

/** Browser → isolated Hire runtime payload. Raw landmarks never pass through
 * the control-plane HTTP ingress; the runtime stages them in its private R2
 * namespace first. */
export const HireMultimodalAnalysisCaptureSchema = z
  .object({
    sessionId: MongoObjectIdStringSchema,
    frames: z.preprocess(
      sanitizeHireMultimodalAnalysisFrames,
      z.array(HireMultimodalAnalysisFacialFrameSchema).max(
        HIRE_MULTIMODAL_ANALYSIS_MAX_FRAMES,
      ),
    ),
  })
  .strict()

export const HireMultimodalAnalysisArtifactSchema = z
  .object({
    kind: z.literal('landmarks'),
    sourceKey: z
      .string()
      .min(1)
      .max(1_024)
      .refine(
        (value) => !value.includes('..') && !value.startsWith('/'),
        'Unsafe object key',
      ),
    contentType: z.literal('application/json'),
    sizeBytes: z.number().int().min(1).max(HIRE_MULTIMODAL_ANALYSIS_MAX_ARTIFACT_BYTES),
    sha256: Sha256HexSchema,
  })
  .strict()

export const HireMultimodalAnalysisTranscriptEntrySchema = z
  .object({
    speaker: z.enum(['interviewer', 'candidate']),
    text: z.string().max(20_000),
    timestampMs: z.number().int().min(0).max(HIRE_MULTIMODAL_ANALYSIS_MAX_DURATION_MS),
    questionIndex: z.number().int().min(0).max(500).nullable().optional(),
  })
  .strict()

export const HireMultimodalAnalysisLiveWordSchema = z
  .object({
    word: z.string().trim().min(1).max(200),
    startMs: z.number().int().min(0).max(HIRE_MULTIMODAL_ANALYSIS_MAX_DURATION_MS),
    endMs: z.number().int().min(0).max(HIRE_MULTIMODAL_ANALYSIS_MAX_DURATION_MS),
    confidence: z.number().finite().min(0).max(1),
  })
  .strict()
  .superRefine((word, context) => {
    if (word.endMs < word.startMs) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endMs'],
        message: 'Word must not end before it starts',
      })
    }
  })

/** Isolated runtime → Hire control payload. It contains only timing text and
 * a checksum-addressed source artifact; no candidate identity or object URL. */
export const HireMultimodalAnalysisIngestionSchema = z
  .object({
    schemaVersion: z.literal(HIRE_MULTIMODAL_ANALYSIS_BRIDGE_SCHEMA_VERSION),
    eventId: Sha256HexSchema,
    workspaceId: MongoObjectIdStringSchema,
    applicationId: MongoObjectIdStringSchema,
    roundId: MongoObjectIdStringSchema,
    runtimeSessionId: MongoObjectIdStringSchema,
    attempt: z.number().int().min(1).max(10),
    revision: z.literal(1),
    consentVersion: z.string().trim().min(1).max(80),
    policyVersion: z.literal(HIRE_MULTIMODAL_ANALYSIS_POLICY_VERSION),
    capturedAt: IsoDateTimeSchema,
    durationMs: z
      .number()
      .int()
      .min(1)
      .max(HIRE_MULTIMODAL_ANALYSIS_MAX_DURATION_MS),
    landmarks: HireMultimodalAnalysisArtifactSchema,
    transcript: z
      .array(HireMultimodalAnalysisTranscriptEntrySchema)
      .max(HIRE_MULTIMODAL_ANALYSIS_MAX_TRANSCRIPT_ENTRIES),
    liveTranscriptWords: z
      .array(HireMultimodalAnalysisLiveWordSchema)
      .max(HIRE_MULTIMODAL_ANALYSIS_MAX_LIVE_WORDS)
      .default([]),
  })
  .strict()

export type HireMultimodalAnalysisFacialFrame = z.infer<
  typeof HireMultimodalAnalysisFacialFrameSchema
>
export type HireMultimodalAnalysisCapture = z.infer<
  typeof HireMultimodalAnalysisCaptureSchema
>
export type HireMultimodalAnalysisArtifact = z.infer<
  typeof HireMultimodalAnalysisArtifactSchema
>
export type HireMultimodalAnalysisIngestion = z.infer<
  typeof HireMultimodalAnalysisIngestionSchema
>

/** Exact UTF-8 bytes sent by `requestAccountBoundJson` for this capture. */
export function hireMultimodalAnalysisCaptureBodyBytes(
  capture: HireMultimodalAnalysisCapture,
): number {
  return new TextEncoder().encode(JSON.stringify(capture)).byteLength
}

function evenlySampleCaptureFrames<T>(frames: readonly T[], count: number): T[] {
  if (count >= frames.length) return [...frames]
  if (count <= 0) return []
  if (count === 1) return [frames[0]]
  return Array.from({ length: count }, (_unused, index) =>
    frames[Math.round((index * (frames.length - 1)) / (count - 1))],
  )
}

/**
 * Retain an evenly distributed, schema-valid sample if a full 30-minute
 * stream would exceed the runtime fence. This is a transport cap only: the
 * retained samples are still full landmark/blendshape frames, never a
 * coarser derived report.
 */
export function fitHireMultimodalAnalysisCaptureToBodyLimit(
  capture: HireMultimodalAnalysisCapture,
  maximumBytes = HIRE_MULTIMODAL_ANALYSIS_CAPTURE_MAX_BODY_BYTES,
): HireMultimodalAnalysisCapture {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error('Hire multimodal capture byte limit is invalid')
  }
  if (hireMultimodalAnalysisCaptureBodyBytes(capture) <= maximumBytes) {
    return capture
  }

  const source = capture.frames
  let low = 0
  let high = source.length
  let best: HireMultimodalAnalysisCapture = {
    sessionId: capture.sessionId,
    frames: [],
  }
  while (low <= high) {
    const count = Math.floor((low + high) / 2)
    const candidate: HireMultimodalAnalysisCapture = {
      sessionId: capture.sessionId,
      frames: evenlySampleCaptureFrames(source, count),
    }
    if (hireMultimodalAnalysisCaptureBodyBytes(candidate) <= maximumBytes) {
      best = candidate
      low = count + 1
    } else {
      high = count - 1
    }
  }

  // Uneven blendshape names can make frame byte-size non-monotonic across
  // samples. Trim the final candidate as a last, guaranteed-safe guard.
  while (
    best.frames.length > 0 &&
    hireMultimodalAnalysisCaptureBodyBytes(best) > maximumBytes
  ) {
    best = { ...best, frames: best.frames.slice(0, -1) }
  }
  if (hireMultimodalAnalysisCaptureBodyBytes(best) > maximumBytes) {
    throw new Error('Hire multimodal capture metadata exceeds the body limit')
  }
  return best
}

/** Deterministic JSON for event/digest idempotency across plane boundaries. */
export function canonicalHireMultimodalAnalysisJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalHireMultimodalAnalysisJson(entry)).join(',')}]`
  }
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalHireMultimodalAnalysisJson(record[key])}`,
    )
    .join(',')}}`
}

export function hireMultimodalAnalysisDigestPayload(
  input: Pick<
    HireMultimodalAnalysisIngestion,
    | 'capturedAt'
    | 'durationMs'
    | 'landmarks'
    | 'transcript'
    | 'liveTranscriptWords'
  >,
): Pick<
  HireMultimodalAnalysisIngestion,
  | 'capturedAt'
  | 'durationMs'
  | 'landmarks'
  | 'transcript'
  | 'liveTranscriptWords'
> {
  return {
    capturedAt: input.capturedAt,
    durationMs: input.durationMs,
    landmarks: input.landmarks,
    transcript: input.transcript,
    liveTranscriptWords: input.liveTranscriptWords,
  }
}
