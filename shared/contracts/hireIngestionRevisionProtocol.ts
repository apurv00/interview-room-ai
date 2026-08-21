export const HIRE_INGESTION_REVISION_PROTOCOL_VERSION = '2' as const
export const HIRE_INGESTION_REVISION_PROTOCOL_HEADER =
  'x-hire-ingestion-revision-protocol' as const
export const HIRE_INGESTION_REVISION_DRAIN_MS = 6 * 60 * 1_000

export type HireIngestionRevisionProtocolMode =
  | 'disabled'
  | 'draining'
  | 'required'

export type HireIngestionRevisionProtocolDecision =
  | { ok: true }
  | {
      ok: false
      reason: 'disabled' | 'draining' | 'invalid_configuration' | 'version_mismatch'
    }

type HireIngestionRevisionEnvironment = Record<string, string | undefined>

export type HireIngestionRevisionProtocolState = {
  protocolVersion: typeof HIRE_INGESTION_REVISION_PROTOCOL_VERSION
  mode: HireIngestionRevisionProtocolMode | 'invalid'
  explicitlyConfigured: boolean
  drainMarkerValid: boolean
  drainWindowSatisfied: boolean
  releaseReady: boolean
}

/**
 * Fail-closed deployment interlock for the reservation/index cutover. A
 * production control deployment may accept v2 traffic only after the old
 * route generation has been disabled for longer than its maximum request.
 */
export function evaluateHireIngestionRevisionProtocol(input: {
  requestVersion: string | null | undefined
  environment?: HireIngestionRevisionEnvironment
  now?: Date
}): HireIngestionRevisionProtocolDecision {
  const environment = input.environment ?? process.env
  const production = environment.NODE_ENV === 'production'
  const configuredMode = environment.HIRE_INGESTION_REVISION_PROTOCOL_MODE
  const mode = configuredMode ?? (production ? 'disabled' : 'required')
  if (!['disabled', 'draining', 'required'].includes(mode)) {
    return { ok: false, reason: 'invalid_configuration' }
  }
  if (mode === 'disabled') return { ok: false, reason: 'disabled' }
  if (mode === 'draining') return { ok: false, reason: 'draining' }

  if (production) {
    const rawStartedAt =
      environment.HIRE_INGESTION_REVISION_PROTOCOL_DRAIN_STARTED_AT
    const startedAt = rawStartedAt ? new Date(rawStartedAt) : undefined
    const now = input.now ?? new Date()
    if (
      !startedAt ||
      !Number.isFinite(startedAt.getTime()) ||
      startedAt.getTime() > now.getTime() - HIRE_INGESTION_REVISION_DRAIN_MS
    ) {
      return { ok: false, reason: 'invalid_configuration' }
    }
  }

  return input.requestVersion === HIRE_INGESTION_REVISION_PROTOCOL_VERSION
    ? { ok: true }
    : { ok: false, reason: 'version_mismatch' }
}

/** Redacted deployment evidence for authenticated release-health checks. */
export function hireIngestionRevisionProtocolState(
  environment: HireIngestionRevisionEnvironment = process.env,
  now = new Date(),
): HireIngestionRevisionProtocolState {
  const configuredMode = environment.HIRE_INGESTION_REVISION_PROTOCOL_MODE
  const defaultMode = environment.NODE_ENV === 'production' ? 'disabled' : 'required'
  const candidateMode = configuredMode ?? defaultMode
  const mode: HireIngestionRevisionProtocolState['mode'] =
    ['disabled', 'draining', 'required'].includes(candidateMode)
      ? candidateMode as HireIngestionRevisionProtocolMode
      : 'invalid'
  const rawStartedAt = environment.HIRE_INGESTION_REVISION_PROTOCOL_DRAIN_STARTED_AT
  const startedAt = rawStartedAt ? new Date(rawStartedAt) : null
  const drainMarkerValid = Boolean(
    startedAt &&
      Number.isFinite(startedAt.getTime()) &&
      startedAt.getTime() <= now.getTime(),
  )
  const drainWindowSatisfied = Boolean(
    drainMarkerValid &&
      startedAt &&
      startedAt.getTime() <= now.getTime() - HIRE_INGESTION_REVISION_DRAIN_MS,
  )
  const decision = evaluateHireIngestionRevisionProtocol({
    requestVersion: HIRE_INGESTION_REVISION_PROTOCOL_VERSION,
    environment,
    now,
  })
  return {
    protocolVersion: HIRE_INGESTION_REVISION_PROTOCOL_VERSION,
    mode,
    explicitlyConfigured: configuredMode !== undefined,
    drainMarkerValid,
    drainWindowSatisfied,
    releaseReady: decision.ok,
  }
}
