import { createHash } from 'node:crypto'
import { z } from 'zod'
import { HIRE_RUNTIME_WRITE_DRAIN_MS } from '@shared/contracts/hireRuntimeWriteFence'
import {
  HIRE_MULTIMODAL_OBSERVATION_CONSENT_VERSION,
  HIRE_MULTIMODAL_OBSERVATION_POLICY_VERSION,
  canonicalHireMultimodalObservationJson,
  hireMultimodalObservationDigestPayload,
} from '@shared/contracts/hireMultimodalObservationBridge'
import {
  HireRuntimeBinding,
  type IHireRuntimeBinding,
} from '../models/HireRuntimeBinding'
import {
  HireRuntimeMultimodalObservationOutbox,
  type HireRuntimeObservationEventKind,
} from '../models/HireRuntimeMultimodalObservationOutbox'
import { isHireRuntimeMultimodalObservationRetentionPurged } from './multimodalObservationRetentionService'
import { connectHireRuntimeDB } from './runtimeBoundary'

const MAX_DURATION_MS = 30 * 60 * 1_000
const MAX_CAMERA_SAMPLES = 10_000
const MAX_VISIBILITY_SPANS = 200
const MAX_REPORT_EVENTS = 100
const SUSTAINED_CAMERA_AWAY_MS = 4_000
const CONTIGUOUS_SAMPLE_GAP_MS = 1_000
const MIN_VISIBILITY_EVENT_MS = 1_000

export const HireMultimodalCaptureSchema = z
  .object({
    sessionId: z.string().regex(/^[a-f0-9]{24}$/i),
    cameraSamples: z
      .array(
        z
          .object({
            atMs: z.number().int().min(0).max(MAX_DURATION_MS),
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
                startMs: z.number().int().min(0).max(MAX_DURATION_MS),
                endMs: z.number().int().min(0).max(MAX_DURATION_MS),
              })
              .strict()
              .refine((value) => value.endMs >= value.startMs),
          )
          .max(MAX_VISIBILITY_SPANS),
      })
      .strict(),
  })
  .strict()

export type HireMultimodalCapture = z.infer<typeof HireMultimodalCaptureSchema>

export interface HireRuntimeObservationReport {
  status: 'completed' | 'insufficient_signal'
  capture: {
    camera: 'captured' | 'unavailable' | 'insufficient_signal'
    browserVisibility: 'captured' | 'unavailable' | 'insufficient_signal'
  }
  events: Array<{
    kind: HireRuntimeObservationEventKind
    source: 'camera' | 'browser_visibility'
    startMs: number
    endMs: number
  }>
}

function hash(value: unknown): string {
  return createHash('sha256')
    .update(canonicalHireMultimodalObservationJson(value))
    .digest('hex')
}

function cameraLooksAway(sample: HireMultimodalCapture['cameraSamples'][number]): boolean {
  // This is a fixed binary cue, deliberately not a confidence/body-language
  // score. The server owns the threshold so a browser cannot manufacture an
  // event by sending a label instead of the bounded source samples.
  return (
    Math.hypot(sample.gazeX, sample.gazeY) >= 0.75 ||
    Math.abs(sample.headYaw) >= 30 ||
    Math.abs(sample.headPitch) >= 25
  )
}

function sustainedCameraAwayEvents(
  samples: HireMultimodalCapture['cameraSamples'],
): HireRuntimeObservationReport['events'] {
  const sorted = [...samples].sort((left, right) => left.atMs - right.atMs)
  const events: HireRuntimeObservationReport['events'] = []
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
  return events.slice(0, MAX_REPORT_EVENTS)
}

function browserVisibilityEvents(
  spans: HireMultimodalCapture['browserVisibility']['hiddenSpans'],
): HireRuntimeObservationReport['events'] {
  const sorted = [...spans]
    .filter((span) => span.endMs - span.startMs >= MIN_VISIBILITY_EVENT_MS)
    .sort((left, right) => left.startMs - right.startMs)
  const events: HireRuntimeObservationReport['events'] = []
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
  return events.slice(0, MAX_REPORT_EVENTS)
}

export function deriveHireRuntimeObservationReport(
  capture: HireMultimodalCapture,
): HireRuntimeObservationReport {
  const camera =
    capture.cameraSamples.length === 0
      ? 'unavailable'
      : capture.cameraSamples.length < 10
        ? 'insufficient_signal'
        : 'captured'
  const browserVisibility = !capture.browserVisibility.available
    ? 'unavailable'
    : 'captured'
  const events = [
    ...(camera === 'captured'
      ? sustainedCameraAwayEvents(capture.cameraSamples)
      : []),
    ...(browserVisibility === 'captured'
      ? browserVisibilityEvents(capture.browserVisibility.hiddenSpans)
      : []),
  ]
    .sort((left, right) => left.startMs - right.startMs)
    .slice(0, MAX_REPORT_EVENTS)
  return {
    status:
      camera === 'captured' || browserVisibility === 'captured'
        ? 'completed'
        : 'insufficient_signal',
    capture: { camera, browserVisibility },
    events,
  }
}

export async function captureHireRuntimeMultimodalObservation(input: {
  workspaceId: string
  principalId: string
  capture: HireMultimodalCapture
  now?: Date
}): Promise<'accepted' | 'disabled' | 'already_published'> {
  await connectHireRuntimeDB()
  const now = input.now ?? new Date()
  const binding = await HireRuntimeBinding.findOne({
    workspaceId: input.workspaceId,
    principalId: input.principalId,
    runtimeSessionId: input.capture.sessionId,
    status: { $in: ['active', 'completed'] },
    revokedAt: { $exists: false },
    purgePersonalData: { $ne: true },
  })
  if (!binding) throw new Error('Runtime multimodal capture crossed its binding')
  if (!binding.runtimeSessionId) {
    throw new Error('Runtime multimodal capture has no session')
  }
  if (binding.consentVersion !== HIRE_MULTIMODAL_OBSERVATION_CONSENT_VERSION) {
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
  const report = deriveHireRuntimeObservationReport(input.capture)
  // Reclaim the binding's write-drain horizon immediately before the outbox
  // write. If privacy revocation won while the browser request was in flight,
  // this conditional update fails. If this request wins first, revocation sees
  // the horizon and waits until this report is either staged then purged, or
  // the request has failed—never acknowledging a late residual observation.
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
  const observedAt = now.toISOString()
  const observationDigest = hash(hireMultimodalObservationDigestPayload({
    observedAt,
    report,
  }))
  const eventId = hash(
    `${binding.roundId.toString()}:${binding.runtimeSessionId.toString()}:${1}:${observationDigest}`,
  )
  const coordinate = {
    ...retentionCoordinates,
    runtimeSessionId: binding.runtimeSessionId,
    revision: 1,
  }
  const published = await HireRuntimeMultimodalObservationOutbox.exists({
    ...coordinate,
    status: { $in: ['published', 'stale'] },
  })
  if (published) return 'already_published'
  await HireRuntimeMultimodalObservationOutbox.findOneAndUpdate(
    coordinate,
    {
      $setOnInsert: {
        ...coordinate,
        applicationId: binding.applicationId,
        principalId: binding.principalId,
        attempt: Math.max(1, binding.attemptCount),
        consentVersion: binding.consentVersion,
        policyVersion: HIRE_MULTIMODAL_OBSERVATION_POLICY_VERSION,
        eventId,
        observationDigest,
        observedAt: now,
        report,
        status: 'pending',
        publishAttemptCount: 0,
      },
    },
    { upsert: true, new: true },
  )
  // The retention endpoint writes its tombstone before deleting the outbox.
  // Recheck after staging so either interleaving wins safely: if retention was
  // already present, this late browser request removes its own staged report.
  if (await isHireRuntimeMultimodalObservationRetentionPurged(retentionCoordinates)) {
    const removed = await HireRuntimeMultimodalObservationOutbox.deleteMany(
      retentionCoordinates,
    )
    if (!removed.acknowledged) {
      throw new Error('Runtime observation retention fence did not acknowledge cleanup')
    }
    return 'disabled'
  }
  return 'accepted'
}

export const __hireRuntimeMultimodalCapture = {
  cameraLooksAway,
  sustainedCameraAwayEvents,
  browserVisibilityEvents,
  deriveHireRuntimeObservationReport,
}
