import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  HIRE_MULTIMODAL_OBSERVATION_LEGACY_POLICY_VERSION,
  HIRE_MULTIMODAL_OBSERVATION_MAX_DURATION_MS,
  HIRE_MULTIMODAL_OBSERVATION_MAX_EVENTS,
  HIRE_MULTIMODAL_OBSERVATION_MAX_REVISIONS,
  HIRE_MULTIMODAL_OBSERVATION_POLICY_VERSION,
  HIRE_MULTIMODAL_OBSERVATION_V2_POLICY_VERSION,
  HireMultimodalObservationClientEventSchema,
  HireMultimodalObservationIsoDateTimeSchema,
  HireMultimodalObservationSpeechVideoCorroborationSchema,
  canonicalHireMultimodalObservationJson,
  hireMultimodalObservationDigestPayload,
  type HireMultimodalObservationEvent,
  type HireMultimodalObservationReport,
} from '@shared/contracts/hireMultimodalObservationBridge'
import { HIRE_RUNTIME_WRITE_DRAIN_MS } from '@shared/contracts/hireRuntimeWriteFence'
import {
  HIRE_AI_CONSENT_VERSION,
  HIRE_AI_V5_CONSENT_VERSION,
  supportsHireDisplayCapture,
  supportsHireMultimodalObservations,
} from '@hire-multimodal-boundary'
import { HireRuntimeBinding } from '../models/HireRuntimeBinding'
import { HireRuntimeMultimodalObservationOutbox } from '../models/HireRuntimeMultimodalObservationOutbox'
import { isHireRuntimeMultimodalObservationRetentionPurged } from './multimodalObservationRetentionService'
import { connectHireRuntimeDB } from './runtimeBoundary'

const MAX_CAMERA_SAMPLES = 10_000
const MAX_VISIBILITY_SPANS = 200
const SUSTAINED_CAMERA_AWAY_MS = 4_000
const SUSTAINED_SPEECH_VIDEO_UNVERIFIED_MS = 3_000
const CONTIGUOUS_SAMPLE_GAP_MS = 1_000
// The browser reporter deliberately emits the coarse VAD/face proxy every
// three seconds. Its sequence needs a slightly larger tolerance than camera
// samples, while still splitting an interrupted observation into a new span.
const CONTIGUOUS_SPEECH_VIDEO_SAMPLE_GAP_MS = 3_500
const MIN_VISIBILITY_EVENT_MS = 1_000

const AvailabilitySchema = z.object({ available: z.boolean() }).strict()

/**
 * Browser-originating data is limited to known platform events and coarse
 * VAD/face-presence booleans. The runtime derives corroboration labels; it
 * never persists raw audio, video, landmarks, or transcripts.
 */
export const HireMultimodalIntegrityCaptureSchema = z
  .object({
    browserFocus: AvailabilitySchema,
    fullscreen: AvailabilitySchema,
    cameraTrack: AvailabilitySchema,
    microphoneTrack: AvailabilitySchema,
    // V5 clients already in flight predate display sharing. Keep their
    // otherwise-valid integrity snapshot parseable and neutral.
    displayShare: AvailabilitySchema.default({ available: false }),
    events: z
      .array(HireMultimodalObservationClientEventSchema)
      .max(HIRE_MULTIMODAL_OBSERVATION_MAX_EVENTS),
    speechVideoCorroboration:
      HireMultimodalObservationSpeechVideoCorroborationSchema,
  })
  .strict()

export const HireMultimodalCaptureSchema = z
  .object({
    sessionId: z.string().regex(/^[a-f0-9]{24}$/i),
    /** A retry must resend the same immutable snapshot/revision. */
    revision: z
      .number()
      .int()
      .min(1)
      .max(HIRE_MULTIMODAL_OBSERVATION_MAX_REVISIONS)
      .default(1),
    /** Stable client stamp makes a pagehide retry idempotent. */
    observedAt: HireMultimodalObservationIsoDateTimeSchema.optional(),
    cameraSamples: z
      .array(
        z
          .object({
            atMs: z.number().int().min(0).max(HIRE_MULTIMODAL_OBSERVATION_MAX_DURATION_MS),
            gazeX: z.number().finite().min(-1).max(1),
            gazeY: z.number().finite().min(-1).max(1),
            headYaw: z.number().finite().min(-180).max(180),
            headPitch: z.number().finite().min(-180).max(180),
          })
          .strict(),
      )
      .max(MAX_CAMERA_SAMPLES),
    browserVisibility: z
      .object({
        available: z.boolean(),
        hiddenSpans: z
          .array(
            z
              .object({
                startMs: z.number().int().min(0).max(HIRE_MULTIMODAL_OBSERVATION_MAX_DURATION_MS),
                endMs: z.number().int().min(0).max(HIRE_MULTIMODAL_OBSERVATION_MAX_DURATION_MS),
              })
              .strict()
              .refine((value) => value.endMs >= value.startMs),
          )
          .max(MAX_VISIBILITY_SPANS),
      })
      .strict(),
    integrity: HireMultimodalIntegrityCaptureSchema.default({
      browserFocus: { available: false },
      fullscreen: { available: false },
      cameraTrack: { available: false },
      microphoneTrack: { available: false },
      displayShare: { available: false },
      events: [],
      speechVideoCorroboration: { available: false, samples: [] },
    }),
  })
  .strict()

export type HireMultimodalCapture = z.output<typeof HireMultimodalCaptureSchema>
export type HireMultimodalCaptureInput = z.input<typeof HireMultimodalCaptureSchema>
export type HireRuntimeObservationReport = HireMultimodalObservationReport

function hash(value: unknown): string {
  return createHash('sha256')
    .update(canonicalHireMultimodalObservationJson(value))
    .digest('hex')
}

function cameraLooksAway(sample: HireMultimodalCapture['cameraSamples'][number]): boolean {
  return (
    Math.hypot(sample.gazeX, sample.gazeY) >= 0.75 ||
    Math.abs(sample.headYaw) >= 30 ||
    Math.abs(sample.headPitch) >= 25
  )
}

function sustainedCameraAwayEvents(
  samples: HireMultimodalCapture['cameraSamples'],
): HireMultimodalObservationEvent[] {
  const sorted = [...samples].sort((left, right) => left.atMs - right.atMs)
  const events: HireMultimodalObservationEvent[] = []
  let startMs: number | null = null
  let lastMs: number | null = null
  const endRun = () => {
    if (
      startMs !== null &&
      lastMs !== null &&
      lastMs - startMs >= SUSTAINED_CAMERA_AWAY_MS
    ) {
      events.push({
        kind: 'sustained_camera_away',
        source: 'camera',
        startMs,
        endMs: lastMs,
      })
    }
    startMs = null
    lastMs = null
  }
  for (const sample of sorted) {
    const away = cameraLooksAway(sample)
    const contiguous =
      lastMs !== null && sample.atMs - lastMs <= CONTIGUOUS_SAMPLE_GAP_MS
    if (!away || (startMs !== null && !contiguous)) endRun()
    if (away) {
      if (startMs === null) startMs = sample.atMs
      lastMs = sample.atMs
    }
  }
  endRun()
  return events.slice(0, HIRE_MULTIMODAL_OBSERVATION_MAX_EVENTS)
}

function browserVisibilityEvents(
  spans: HireMultimodalCapture['browserVisibility']['hiddenSpans'],
): HireMultimodalObservationEvent[] {
  const sorted = [...spans]
    .filter((span) => span.endMs - span.startMs >= MIN_VISIBILITY_EVENT_MS)
    .sort((left, right) => left.startMs - right.startMs)
  const events: HireMultimodalObservationEvent[] = []
  for (const span of sorted) {
    const prior = events[events.length - 1]
    if (
      prior?.kind === 'browser_window_not_visible' &&
      span.startMs <= prior.endMs + 250
    ) {
      prior.endMs = Math.max(prior.endMs, span.endMs)
      continue
    }
    events.push({
      kind: 'browser_window_not_visible',
      source: 'browser_visibility',
      startMs: span.startMs,
      endMs: span.endMs,
    })
  }
  return events.slice(0, HIRE_MULTIMODAL_OBSERVATION_MAX_EVENTS)
}

function speechVideoUnverifiedEvents(
  input: HireMultimodalCapture['integrity']['speechVideoCorroboration'],
): HireMultimodalObservationEvent[] {
  if (!input.available) return []
  const sorted = [...input.samples].sort((left, right) => left.atMs - right.atMs)
  const events: HireMultimodalObservationEvent[] = []
  let startMs: number | null = null
  let lastMs: number | null = null
  const endRun = () => {
    if (
      startMs !== null &&
      lastMs !== null &&
      lastMs - startMs >= SUSTAINED_SPEECH_VIDEO_UNVERIFIED_MS
    ) {
      events.push({
        kind: 'speech_video_unverified',
        source: 'speech_video_corroboration',
        startMs,
        endMs: lastMs,
      })
    }
    startMs = null
    lastMs = null
  }
  for (const sample of sorted) {
    // An unavailable mouth-motion proxy is intentionally neutral for legacy
    // snapshots. A mismatch needs active local speech plus either no current
    // face or an explicit current frame without facial speech motion.
    const unverified =
      sample.voiceActive &&
      (!sample.facePresent || sample.facialSpeechActive === false)
    const contiguous =
      lastMs !== null &&
      sample.atMs - lastMs <= CONTIGUOUS_SPEECH_VIDEO_SAMPLE_GAP_MS
    if (!unverified || (startMs !== null && !contiguous)) endRun()
    if (unverified) {
      if (startMs === null) startMs = sample.atMs
      lastMs = sample.atMs
    }
  }
  endRun()
  return events.slice(0, HIRE_MULTIMODAL_OBSERVATION_MAX_EVENTS)
}

function captureState(
  available: boolean,
  samples?: number,
  minimumSamples = 3,
): 'captured' | 'unavailable' | 'insufficient_signal' {
  if (!available) return 'unavailable'
  if (samples !== undefined && samples < minimumSamples) return 'insufficient_signal'
  return 'captured'
}

function mergeEvents(
  ...groups: HireMultimodalObservationEvent[][]
): HireMultimodalObservationEvent[] {
  const seen = new Set<string>()
  const events: HireMultimodalObservationEvent[] = []
  const ordered = groups.flat().sort(
    (left, right) => left.startMs - right.startMs || left.endMs - right.endMs,
  )
  for (const event of ordered) {
    const key = `${event.kind}:${event.source}:${event.startMs}:${event.endMs}`
    if (seen.has(key)) continue
    seen.add(key)
    const prior = [...events].reverse().find(
      (candidate) =>
        candidate.kind === event.kind &&
        candidate.source === event.source,
    )
    // Browser visibility and the start-gate listener may observe the same
    // short loss independently. Coalesce only same-kind/source intervals;
    // fullscreen/device events remain separate timeline entries.
    if (prior && event.startMs <= prior.endMs + 250) {
      prior.endMs = Math.max(prior.endMs, event.endMs)
      continue
    }
    events.push({ ...event })
  }
  return events.slice(0, HIRE_MULTIMODAL_OBSERVATION_MAX_EVENTS)
}

/**
 * speech_video_unverified means locally active speech could not be
 * corroborated by a current face frame. It is never a speaker identity result.
 */
export function deriveHireRuntimeObservationReport(
  rawCapture: HireMultimodalCaptureInput,
): HireRuntimeObservationReport {
  const capture = HireMultimodalCaptureSchema.parse(rawCapture)
  const camera = capture.cameraSamples.length === 0
    ? 'unavailable'
    : capture.cameraSamples.length < 10
      ? 'insufficient_signal'
      : 'captured'
  const browserVisibility = capture.browserVisibility.available
    ? 'captured'
    : 'unavailable'
  const speechVideoCorroboration = captureState(
    capture.integrity.speechVideoCorroboration.available,
    capture.integrity.speechVideoCorroboration.samples.length,
    // A t=0/t=3000 pair proves a full three-second bounded interval at the
    // reporter's cadence. Requiring a third sample would discard that exact
    // threshold case despite enough evidence to derive the neutral event.
    2,
  )
  const events = mergeEvents(
    camera === 'captured' ? sustainedCameraAwayEvents(capture.cameraSamples) : [],
    browserVisibility === 'captured'
      ? browserVisibilityEvents(capture.browserVisibility.hiddenSpans)
      : [],
    capture.integrity.events,
    speechVideoCorroboration === 'captured'
      ? speechVideoUnverifiedEvents(capture.integrity.speechVideoCorroboration)
      : [],
  )
  const browserFocus = captureState(capture.integrity.browserFocus.available)
  const fullscreen = captureState(capture.integrity.fullscreen.available)
  const cameraTrack = captureState(capture.integrity.cameraTrack.available)
  const microphoneTrack = captureState(capture.integrity.microphoneTrack.available)
  const displayShare = captureState(capture.integrity.displayShare.available)
  return {
    status: [
      camera,
      browserVisibility,
      browserFocus,
      fullscreen,
      cameraTrack,
      microphoneTrack,
      displayShare,
      speechVideoCorroboration,
    ].includes('captured')
      ? 'completed'
      : 'insufficient_signal',
    capture: {
      camera,
      browserVisibility,
      browserFocus,
      fullscreen,
      cameraTrack,
      microphoneTrack,
      displayShare,
      speechVideoCorroboration,
    },
    events,
  }
}

export type HireRuntimeMultimodalObservationCaptureOutcome =
  | 'accepted'
  | 'disabled'
  | 'already_captured'
  | 'conflict'

function observationPolicyVersion(consentVersion: string): string {
  if (consentVersion === HIRE_AI_CONSENT_VERSION) {
    return HIRE_MULTIMODAL_OBSERVATION_POLICY_VERSION
  }
  if (consentVersion === HIRE_AI_V5_CONSENT_VERSION) {
    return HIRE_MULTIMODAL_OBSERVATION_V2_POLICY_VERSION
  }
  return HIRE_MULTIMODAL_OBSERVATION_LEGACY_POLICY_VERSION
}

export async function captureHireRuntimeMultimodalObservation(input: {
  workspaceId: string
  principalId: string
  capture: HireMultimodalCaptureInput
  now?: Date
}): Promise<HireRuntimeMultimodalObservationCaptureOutcome> {
  const capture = HireMultimodalCaptureSchema.parse(input.capture)
  await connectHireRuntimeDB()
  const now = input.now ?? new Date()
  const binding = await HireRuntimeBinding.findOne({
    workspaceId: input.workspaceId,
    principalId: input.principalId,
    runtimeSessionId: capture.sessionId,
    status: { $in: ['active', 'completed'] },
    revokedAt: { $exists: false },
    purgePersonalData: { $ne: true },
  })
  if (!binding) throw new Error('Runtime multimodal capture crossed its binding')
  if (!binding.runtimeSessionId) {
    throw new Error('Runtime multimodal capture has no session')
  }
  // V5 is the first receipt that explicitly covers the core validation payload.
  // Entire-display validation is a V6-only expansion and is never enabled for
  // an already-running V5 attempt.
  // The control bridge still accepts exact historic receipt pairs only for
  // already-staged V1 observations during rollout; no old attempt is silently
  // upgraded into this newer collection path.
  if (!supportsHireMultimodalObservations(binding.consentVersion)) return 'disabled'
  const containsDisplayCapture =
    capture.integrity.displayShare.available ||
    capture.integrity.events.some(
      (event) =>
        event.kind === 'screen_share_wrong_surface' ||
        event.kind === 'screen_share_interrupted' ||
        event.kind === 'screen_recording_interrupted',
    )
  if (
    containsDisplayCapture &&
    !supportsHireDisplayCapture(binding.consentVersion)
  ) {
    return 'disabled'
  }
  const retentionCoordinates = {
    workspaceId: binding.workspaceId,
    applicationId: binding.applicationId,
    roundId: binding.roundId,
  }
  if (await isHireRuntimeMultimodalObservationRetentionPurged(retentionCoordinates)) {
    return 'disabled'
  }
  const derivedReport = deriveHireRuntimeObservationReport(capture)
  const report = supportsHireDisplayCapture(binding.consentVersion)
    ? derivedReport
    : {
        ...derivedReport,
        capture: (({ displayShare: _displayShare, ...historicCapture }) =>
          historicCapture)(derivedReport.capture),
      }
  const captureReserved = await HireRuntimeBinding.updateOne(
    {
      _id: binding._id,
      workspaceId: binding.workspaceId,
      applicationId: binding.applicationId,
      roundId: binding.roundId,
      principalId: binding.principalId,
      runtimeSessionId: binding.runtimeSessionId,
      status: { $in: ['active', 'completed'] },
      revokedAt: { $exists: false },
      purgePersonalData: { $ne: true },
    },
    {
      $max: {
        runtimeWriteDrainUntil: new Date(
          now.getTime() + HIRE_RUNTIME_WRITE_DRAIN_MS,
        ),
      },
    },
  )
  if (captureReserved.matchedCount !== 1) return 'disabled'
  const observedAt = capture.observedAt ?? now.toISOString()
  const observationDigest = hash(hireMultimodalObservationDigestPayload({
    observedAt,
    report,
  }))
  const eventId = hash(
    `${binding.roundId.toString()}:${binding.runtimeSessionId.toString()}:${capture.revision}:${observationDigest}`,
  )
  const coordinate = {
    ...retentionCoordinates,
    runtimeSessionId: binding.runtimeSessionId,
    revision: capture.revision,
  }
  const staged = await HireRuntimeMultimodalObservationOutbox.findOneAndUpdate(
    coordinate,
    {
      $setOnInsert: {
        ...coordinate,
        applicationId: binding.applicationId,
        principalId: binding.principalId,
        attempt: Math.max(1, binding.attemptCount),
        consentVersion: binding.consentVersion,
        policyVersion: observationPolicyVersion(binding.consentVersion),
        eventId,
        observationDigest,
        observedAt: new Date(observedAt),
        report,
        status: 'pending',
        publishAttemptCount: 0,
      },
    },
    { upsert: true, new: true },
  )
  // A same-revision/same-snapshot retry is accepted idempotently. A changed
  // snapshot cannot overwrite a prior published or queued revision.
  if (
    !staged ||
    staged.eventId !== eventId ||
    staged.observationDigest !== observationDigest
  ) {
    return 'conflict'
  }
  if (await isHireRuntimeMultimodalObservationRetentionPurged(retentionCoordinates)) {
    const removed = await HireRuntimeMultimodalObservationOutbox.deleteMany(
      retentionCoordinates,
    )
    if (!removed.acknowledged) {
      throw new Error('Runtime observation retention fence did not acknowledge cleanup')
    }
    return 'disabled'
  }
  return staged.status === 'pending' ? 'accepted' : 'already_captured'
}

export const __hireRuntimeMultimodalCapture = {
  cameraLooksAway,
  sustainedCameraAwayEvents,
  browserVisibilityEvents,
  speechVideoUnverifiedEvents,
  mergeEvents,
  deriveHireRuntimeObservationReport,
  observationPolicyVersion,
}
