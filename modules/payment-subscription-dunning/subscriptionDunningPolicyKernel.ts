import {
  SUBSCRIPTION_DUNNING_MAX_GRACE_MS,
  SUBSCRIPTION_DUNNING_POLICY_VERSION,
  SUBSCRIPTION_DUNNING_PROVISIONAL_STATES,
  SubscriptionDunningObservationSchema,
  type SubscriptionDunningObservation,
  type SubscriptionDunningPolicyDecision,
  type SubscriptionDunningProvisionalState,
  type SubscriptionDunningReasonCode,
} from './contracts'

export const SUBSCRIPTION_DUNNING_POLICY_ERROR_CODES = [
  'invalid_input',
  'invalid_clock',
  'clock_overflow',
] as const
export type SubscriptionDunningPolicyErrorCode =
  (typeof SUBSCRIPTION_DUNNING_POLICY_ERROR_CODES)[number]

export class SubscriptionDunningPolicyError extends Error {
  constructor(
    readonly code: SubscriptionDunningPolicyErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SubscriptionDunningPolicyError'
  }
}

function failure(
  code: SubscriptionDunningPolicyErrorCode,
  message: string,
  cause?: unknown,
): SubscriptionDunningPolicyError {
  return new SubscriptionDunningPolicyError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  )
}

function exactDate(value: unknown, label: string): Date {
  if (
    !(value instanceof Date) ||
    !Number.isFinite(value.getTime())
  ) {
    throw failure('invalid_clock', `${label} is invalid`)
  }
  return new Date(value)
}

export function normalizeSubscriptionDunningGraceMs(
  value: unknown,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0
  ) {
    throw failure(
      'invalid_input',
      'Configured grace must be a non-negative safe integer',
    )
  }
  return Math.min(
    value as number,
    SUBSCRIPTION_DUNNING_MAX_GRACE_MS,
  )
}

function addMilliseconds(
  date: Date,
  milliseconds: number,
): Date {
  const timestamp = date.getTime() + milliseconds
  if (!Number.isFinite(timestamp)) {
    throw failure('clock_overflow', 'Grace boundary overflowed')
  }
  return new Date(timestamp)
}

function decision(input: {
  classification: SubscriptionDunningPolicyDecision['classification']
  reason: SubscriptionDunningReasonCode
  configuredGraceMs: number
  paidAccessEndsAt: Date
  graceEndsAt?: Date
  nextActionAt?: Date
  provisionalInterviewState?:
    SubscriptionDunningPolicyDecision['provisionalInterviewState']
}): SubscriptionDunningPolicyDecision {
  return Object.freeze({
    policyVersion: SUBSCRIPTION_DUNNING_POLICY_VERSION,
    classification: input.classification,
    reason: input.reason,
    configuredGraceMs: input.configuredGraceMs,
    paidAccessEndsAt: new Date(input.paidAccessEndsAt),
    graceEndsAt: input.graceEndsAt
      ? new Date(input.graceEndsAt)
      : null,
    nextActionAt: input.nextActionAt
      ? new Date(input.nextActionAt)
      : null,
    provisionalInterviewState:
      input.provisionalInterviewState ?? 'not_offered',
  })
}

function review(input: {
  reason: SubscriptionDunningReasonCode
  configuredGraceMs: number
  paidAccessEndsAt: Date
  graceEndsAt?: Date
  provisionalInterviewState?:
    SubscriptionDunningProvisionalState
}): SubscriptionDunningPolicyDecision {
  return decision({
    classification: 'review',
    reason: input.reason,
    configuredGraceMs: input.configuredGraceMs,
    paidAccessEndsAt: input.paidAccessEndsAt,
    graceEndsAt: input.graceEndsAt,
    provisionalInterviewState:
      input.provisionalInterviewState,
  })
}

function provisionalState(
  value: unknown,
): SubscriptionDunningProvisionalState {
  if (
    typeof value !== 'string' ||
    !SUBSCRIPTION_DUNNING_PROVISIONAL_STATES.includes(
      value as SubscriptionDunningProvisionalState,
    )
  ) {
    throw failure(
      'invalid_input',
      'Provisional interview summary is invalid',
    )
  }
  return value as SubscriptionDunningProvisionalState
}

function provisionalAfterCapture(
  state: SubscriptionDunningProvisionalState,
): SubscriptionDunningProvisionalState {
  return (
    state === 'consumed' ||
    state === 'tracked_goodwill'
  )
    ? 'counted_against_cycle'
    : state
}

function provisionalAfterUncapturedEnd(
  state: SubscriptionDunningProvisionalState,
): SubscriptionDunningProvisionalState {
  if (state === 'consumed') return 'tracked_goodwill'
  if (state === 'available') return 'revoked'
  if (state === 'reserved') return 'review'
  return state
}

/**
 * Pure policy classifier only. It cannot grant access, move a User to Basic,
 * contact Razorpay, stage communication, or reserve an interview. In
 * particular, `pending_grace_candidate` is evidence for a future separately
 * gated entitlement authority, not access authority by itself.
 */
export function classifySubscriptionDunning(input: {
  readonly observation: unknown
  readonly now: Date
  readonly configuredGraceMs: unknown
  readonly provisionalInterviewState?: unknown
}): SubscriptionDunningPolicyDecision {
  let observation: SubscriptionDunningObservation
  try {
    observation = SubscriptionDunningObservationSchema.parse(
      input.observation,
    )
  } catch (error) {
    throw failure(
      'invalid_input',
      'Subscription dunning observation is invalid',
      error,
    )
  }
  const now = exactDate(input.now, 'Policy clock')
  const observedAt = new Date(observation.statusObservedAt)
  if (observedAt > now) {
    throw failure(
      'invalid_clock',
      'Status observation cannot be in the future',
    )
  }
  const paidStart = new Date(observation.paidPeriod.start)
  const paidEnd = new Date(observation.paidPeriod.end)
  if (paidStart > now) {
    throw failure(
      'invalid_clock',
      'Renewal dunning paid period cannot start in the future',
    )
  }
  const configuredGraceMs =
    normalizeSubscriptionDunningGraceMs(
      input.configuredGraceMs,
    )
  const provisionalInterviewState = provisionalState(
    input.provisionalInterviewState ?? 'not_offered',
  )
  const graceEndsAt = addMilliseconds(
    paidEnd,
    configuredGraceMs,
  )

  if (observation.clockAuthority === 'legacy_unknown') {
    return review({
      reason: 'legacy_clock_unknown',
      configuredGraceMs,
      paidAccessEndsAt: paidEnd,
      provisionalInterviewState,
    })
  }
  if (observation.accessOverride === 'deletion_pending') {
    return review({
      reason: 'deletion_pending',
      configuredGraceMs,
      paidAccessEndsAt: paidEnd,
      provisionalInterviewState,
    })
  }
  if (observation.accessOverride === 'admin_grant') {
    return review({
      reason: 'admin_authority_active',
      configuredGraceMs,
      paidAccessEndsAt: paidEnd,
      provisionalInterviewState,
    })
  }
  if (
    observation.accessOverride === 'replacement_paid_cycle'
  ) {
    return decision({
      classification: 'recovered',
      reason: 'replacement_paid_cycle_active',
      configuredGraceMs,
      paidAccessEndsAt: paidEnd,
      provisionalInterviewState,
    })
  }

  if (observation.providerStatus === 'active') {
    if (!observation.renewalCycleCaptured) {
      return review({
        reason: 'active_without_renewal_capture',
        configuredGraceMs,
        paidAccessEndsAt: paidEnd,
        provisionalInterviewState,
      })
    }
    return decision({
      classification: 'recovered',
      reason: 'renewal_cycle_captured',
      configuredGraceMs,
      paidAccessEndsAt: paidEnd,
      provisionalInterviewState:
        provisionalAfterCapture(provisionalInterviewState),
    })
  }

  if (observation.providerStatus === 'pending') {
    if (observation.firstPendingObservedAt === null) {
      return review({
        reason: 'pending_clock_missing',
        configuredGraceMs,
        paidAccessEndsAt: paidEnd,
        graceEndsAt,
        provisionalInterviewState,
      })
    }
    if (now < paidEnd) {
      return decision({
        classification: 'paid_period',
        reason: 'pending_during_paid_period',
        configuredGraceMs,
        paidAccessEndsAt: paidEnd,
        graceEndsAt,
        nextActionAt: paidEnd,
        provisionalInterviewState,
      })
    }
    if (!observation.remoteRetryingConfirmed) {
      return review({
        reason: 'remote_retrying_unconfirmed',
        configuredGraceMs,
        paidAccessEndsAt: paidEnd,
        graceEndsAt,
        provisionalInterviewState,
      })
    }
    if (now < graceEndsAt) {
      return decision({
        classification: 'pending_grace_candidate',
        reason: 'pending_grace_active',
        configuredGraceMs,
        paidAccessEndsAt: paidEnd,
        graceEndsAt,
        nextActionAt: graceEndsAt,
        provisionalInterviewState,
      })
    }
    return decision({
      classification: 'pending_fallback_due',
      reason: 'pending_grace_expired',
      configuredGraceMs,
      paidAccessEndsAt: paidEnd,
      graceEndsAt,
      nextActionAt: now,
      provisionalInterviewState:
        provisionalAfterUncapturedEnd(
          provisionalInterviewState,
        ),
    })
  }

  if (observation.providerStatus === 'halted') {
    return now < paidEnd
      ? decision({
          classification: 'paid_period',
          reason: 'halted_during_paid_period',
          configuredGraceMs,
          paidAccessEndsAt: paidEnd,
          nextActionAt: paidEnd,
          provisionalInterviewState,
        })
      : decision({
          classification: 'halted_fallback_due',
          reason: 'halted_after_paid_period',
          configuredGraceMs,
          paidAccessEndsAt: paidEnd,
          nextActionAt: now,
          provisionalInterviewState:
            provisionalAfterUncapturedEnd(
              provisionalInterviewState,
            ),
        })
  }

  if (observation.providerStatus === 'paused') {
    return now < paidEnd
      ? decision({
          classification: 'paid_period',
          reason: 'mandate_paused_during_paid_period',
          configuredGraceMs,
          paidAccessEndsAt: paidEnd,
          nextActionAt: paidEnd,
          provisionalInterviewState,
        })
      : decision({
          classification: 'paused_action_required',
          reason: 'mandate_paused_after_paid_period',
          configuredGraceMs,
          paidAccessEndsAt: paidEnd,
          nextActionAt: now,
          provisionalInterviewState:
            provisionalAfterUncapturedEnd(
              provisionalInterviewState,
            ),
        })
  }

  if (
    observation.providerStatus === 'cancelled' ||
    observation.providerStatus === 'completed' ||
    observation.providerStatus === 'expired'
  ) {
    return now < paidEnd
      ? decision({
          classification: 'paid_period',
          reason: 'terminal_during_paid_period',
          configuredGraceMs,
          paidAccessEndsAt: paidEnd,
          nextActionAt: paidEnd,
          provisionalInterviewState,
        })
      : decision({
          classification: 'terminal_fallback_due',
          reason: 'terminal_after_paid_period',
          configuredGraceMs,
          paidAccessEndsAt: paidEnd,
          nextActionAt: now,
          provisionalInterviewState:
            provisionalAfterUncapturedEnd(
              provisionalInterviewState,
            ),
        })
  }

  if (observation.providerStatus === 'review') {
    return review({
      reason: 'provider_state_review',
      configuredGraceMs,
      paidAccessEndsAt: paidEnd,
      provisionalInterviewState,
    })
  }

  return review({
    reason: 'activation_state_with_paid_period',
    configuredGraceMs,
    paidAccessEndsAt: paidEnd,
    provisionalInterviewState,
  })
}
