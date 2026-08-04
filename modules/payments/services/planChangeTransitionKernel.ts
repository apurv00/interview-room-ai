import type {
  PlanChangeRequestOperation,
  PlanChangeRequestStatus,
} from '../models/PlanChangeRequest'

export type PlanChangeTransitionInvariantCode =
  | 'event_not_allowed'
  | 'invalid_evidence'
  | 'missing_evidence'
  | 'operation_mismatch'
  | 'terminal_state'
  | 'unsafe_cancellation'

export interface ReplacementAuthorizationEvidence {
  paymentId: string
  authorizedAt: Date
}

export interface OldCancellationEvidence {
  acceptedAt: Date
  effectiveAt: Date
}

export interface TargetCycleEvidence {
  paymentId: string
  capturedAt: Date
  periodKey: string
}

export interface EffectiveBoundaryEvidence {
  reachedAt: Date
}

export interface NoProviderEffectsEvidence {
  verifiedAt: Date
  source: 'operator_reconciliation' | 'provider_fetch'
}

export interface ReplacementTerminationEvidence {
  cancellationAcceptedAt: Date
  terminalVerifiedAt: Date
}

export interface PlanChangeStageEvidence {
  replacementAuthorization?: ReplacementAuthorizationEvidence
  oldCancellation?: OldCancellationEvidence
  targetCycle?: TargetCycleEvidence
  effectiveBoundary?: EffectiveBoundaryEvidence
}

export type PlanChangeRecoveryStatus =
  | 'authorization_pending'
  | 'old_cancellation_pending'
  | 'scheduled'
  | 'applying'
  | 'compensating'

export type PlanChangeTransitionEvent =
  | { type: 'start_authorization' }
  | {
      type: 'replacement_authorized'
      evidence: ReplacementAuthorizationEvidence
    }
  | { type: 'start_old_cancellation' }
  | {
      type: 'old_cancellation_accepted'
      evidence: OldCancellationEvidence
    }
  | {
      type: 'target_cycle_captured'
      evidence: TargetCycleEvidence
    }
  | {
      type: 'cancellation_boundary_reached'
      evidence: EffectiveBoundaryEvidence
    }
  | { type: 'projection_committed'; committedAt: Date }
  | { type: 'provider_uncertain' }
  | {
      type: 'recovery_resolved'
      resumeAt: PlanChangeRecoveryStatus
      evidence?: PlanChangeStageEvidence
    }
  | { type: 'review_required' }
  | {
      type: 'review_resolved'
      resumeAt: PlanChangeRecoveryStatus
      evidence?: PlanChangeStageEvidence
    }
  | {
      type: 'compensation_required'
      reason: 'provider_failure' | 'projection_conflict'
    }
  | {
      type: 'user_cancel_requested'
      noProviderEffects?: NoProviderEffectsEvidence
    }
  | {
      type: 'compensation_completed'
      outcome: 'cancelled' | 'failed'
      evidence: ReplacementTerminationEvidence
    }
  | {
      type: 'failure_confirmed'
      evidence: NoProviderEffectsEvidence
    }

export interface PlanChangeTransitionInput {
  operation: PlanChangeRequestOperation
  currentStatus: PlanChangeRequestStatus
  event: PlanChangeTransitionEvent
}

export class PlanChangeTransitionInvariantError extends Error {
  readonly code: PlanChangeTransitionInvariantCode
  readonly operation: PlanChangeRequestOperation
  readonly currentStatus: PlanChangeRequestStatus
  readonly eventType: PlanChangeTransitionEvent['type']

  constructor(
    code: PlanChangeTransitionInvariantCode,
    input: PlanChangeTransitionInput,
    message: string,
  ) {
    super(message)
    this.name = 'PlanChangeTransitionInvariantError'
    this.code = code
    this.operation = input.operation
    this.currentStatus = input.currentStatus
    this.eventType = input.event.type
  }
}

const TERMINAL_STATUSES: ReadonlySet<PlanChangeRequestStatus> =
  new Set<PlanChangeRequestStatus>([
    'applied',
    'cancelled',
    'failed',
  ])

function reject(
  code: PlanChangeTransitionInvariantCode,
  input: PlanChangeTransitionInput,
  message: string,
): never {
  throw new PlanChangeTransitionInvariantError(code, input, message)
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime())
}

function assertPaymentId(
  input: PlanChangeTransitionInput,
  value: string,
): void {
  if (!/^pay_[A-Za-z0-9]+$/.test(value)) {
    reject('invalid_evidence', input, 'Payment evidence is malformed')
  }
}

function assertAuthorization(
  input: PlanChangeTransitionInput,
  evidence: ReplacementAuthorizationEvidence | undefined,
): void {
  if (!evidence) {
    reject(
      'missing_evidence',
      input,
      'Replacement authorization evidence is required',
    )
  }
  assertPaymentId(input, evidence.paymentId)
  if (!validDate(evidence.authorizedAt)) {
    reject(
      'invalid_evidence',
      input,
      'Replacement authorization time is invalid',
    )
  }
}

function assertOldCancellation(
  input: PlanChangeTransitionInput,
  evidence: OldCancellationEvidence | undefined,
): void {
  if (!evidence) {
    reject(
      'missing_evidence',
      input,
      'Old-mandate cancellation evidence is required',
    )
  }
  if (
    !validDate(evidence.acceptedAt) ||
    !validDate(evidence.effectiveAt) ||
    evidence.effectiveAt < evidence.acceptedAt
  ) {
    reject(
      'invalid_evidence',
      input,
      'Old-mandate cancellation evidence is invalid',
    )
  }
}

function assertTargetCycle(
  input: PlanChangeTransitionInput,
  evidence: TargetCycleEvidence | undefined,
): void {
  if (!evidence) {
    reject(
      'missing_evidence',
      input,
      'Captured target-cycle evidence is required',
    )
  }
  assertPaymentId(input, evidence.paymentId)
  if (
    !validDate(evidence.capturedAt) ||
    evidence.periodKey.trim().length === 0
  ) {
    reject(
      'invalid_evidence',
      input,
      'Captured target-cycle evidence is invalid',
    )
  }
}

function assertEffectiveBoundary(
  input: PlanChangeTransitionInput,
  evidence: EffectiveBoundaryEvidence | undefined,
): void {
  if (!evidence) {
    reject(
      'missing_evidence',
      input,
      'Effective-boundary evidence is required',
    )
  }
  if (!validDate(evidence.reachedAt)) {
    reject(
      'invalid_evidence',
      input,
      'Effective-boundary evidence is invalid',
    )
  }
}

function assertNoProviderEffects(
  input: PlanChangeTransitionInput,
  evidence: NoProviderEffectsEvidence | undefined,
): void {
  if (!evidence) {
    reject(
      'missing_evidence',
      input,
      'Verified absence of provider effects is required',
    )
  }
  if (!validDate(evidence.verifiedAt)) {
    reject(
      'invalid_evidence',
      input,
      'No-provider-effects evidence is invalid',
    )
  }
}

function assertReplacementTermination(
  input: PlanChangeTransitionInput,
  evidence: ReplacementTerminationEvidence,
): void {
  if (
    !validDate(evidence.cancellationAcceptedAt) ||
    !validDate(evidence.terminalVerifiedAt) ||
    evidence.terminalVerifiedAt < evidence.cancellationAcceptedAt
  ) {
    reject(
      'invalid_evidence',
      input,
      'Replacement termination evidence is invalid',
    )
  }
}

function assertPaidTarget(
  input: PlanChangeTransitionInput,
): asserts input is PlanChangeTransitionInput & {
  operation: 'tier_change' | 'resubscribe'
} {
  if (input.operation === 'period_end_cancel') {
    reject(
      'operation_mismatch',
      input,
      'Period-end cancellation has no replacement authorization or cycle',
    )
  }
}

function assertResumeEvidence(
  input: PlanChangeTransitionInput,
  resumeAt: PlanChangeRecoveryStatus,
  evidence: PlanChangeStageEvidence | undefined,
): void {
  switch (resumeAt) {
    case 'authorization_pending':
      assertPaidTarget(input)
      return
    case 'old_cancellation_pending':
      if (input.operation === 'resubscribe') {
        reject(
          'operation_mismatch',
          input,
          'Resubscribe never cancels an old mandate',
        )
      }
      if (input.operation === 'tier_change') {
        assertAuthorization(input, evidence?.replacementAuthorization)
      }
      return
    case 'scheduled':
      if (input.operation !== 'period_end_cancel') {
        assertAuthorization(input, evidence?.replacementAuthorization)
      }
      if (input.operation !== 'resubscribe') {
        assertOldCancellation(input, evidence?.oldCancellation)
      }
      return
    case 'applying':
      if (input.operation === 'period_end_cancel') {
        assertOldCancellation(input, evidence?.oldCancellation)
        assertEffectiveBoundary(input, evidence?.effectiveBoundary)
      } else {
        assertAuthorization(input, evidence?.replacementAuthorization)
        if (input.operation === 'tier_change') {
          assertOldCancellation(input, evidence?.oldCancellation)
        }
        assertTargetCycle(input, evidence?.targetCycle)
      }
      return
    case 'compensating':
      assertPaidTarget(input)
  }
}

function transitionUserCancellation(
  input: PlanChangeTransitionInput,
  event: Extract<
    PlanChangeTransitionEvent,
    { type: 'user_cancel_requested' }
  >,
): PlanChangeRequestStatus {
  if (input.currentStatus === 'requested') {
    assertNoProviderEffects(input, event.noProviderEffects)
    return 'cancelled'
  }
  if (
    input.operation === 'period_end_cancel' &&
    (
      input.currentStatus === 'reconciling' ||
      input.currentStatus === 'review'
    ) &&
    event.noProviderEffects
  ) {
    assertNoProviderEffects(input, event.noProviderEffects)
    return 'cancelled'
  }
  if (input.operation === 'period_end_cancel') {
    reject(
      'unsafe_cancellation',
      input,
      'An accepted or ambiguous old-mandate cancellation cannot be undone; create a separate resubscribe request',
    )
  }
  if (input.currentStatus === 'compensating') {
    return 'compensating'
  }
  if (
    input.currentStatus === 'authorization_pending' ||
    input.currentStatus === 'old_cancellation_pending' ||
    input.currentStatus === 'scheduled' ||
    input.currentStatus === 'reconciling' ||
    input.currentStatus === 'review'
  ) {
    return 'compensating'
  }
  reject(
    'event_not_allowed',
    input,
    'The plan change can no longer enter user-cancellation compensation',
  )
}

/**
 * Pure transition kernel for the PlanChangeRequest saga.
 *
 * Events are trusted claims only after the caller has verified their attached
 * provider or persistence evidence. This kernel prevents operation-specific
 * stages from being skipped; Mongo orchestration remains responsible for
 * atomically storing the same evidence alongside the returned status.
 */
export function transitionPlanChangeStatus(
  input: PlanChangeTransitionInput,
): PlanChangeRequestStatus {
  if (TERMINAL_STATUSES.has(input.currentStatus)) {
    reject(
      'terminal_state',
      input,
      `Terminal status ${input.currentStatus} cannot transition`,
    )
  }

  const event = input.event
  switch (event.type) {
    case 'start_authorization':
      assertPaidTarget(input)
      if (input.currentStatus === 'requested') {
        return 'authorization_pending'
      }
      break
    case 'replacement_authorized':
      assertPaidTarget(input)
      assertAuthorization(input, event.evidence)
      if (input.currentStatus === 'authorization_pending') {
        return input.operation === 'tier_change'
          ? 'old_cancellation_pending'
          : 'scheduled'
      }
      break
    case 'start_old_cancellation':
      if (
        input.operation === 'period_end_cancel' &&
        input.currentStatus === 'requested'
      ) {
        return 'old_cancellation_pending'
      }
      break
    case 'old_cancellation_accepted':
      if (input.operation === 'resubscribe') {
        reject(
          'operation_mismatch',
          input,
          'Resubscribe never cancels an old mandate',
        )
      }
      assertOldCancellation(input, event.evidence)
      if (input.currentStatus === 'old_cancellation_pending') {
        return 'scheduled'
      }
      break
    case 'target_cycle_captured':
      assertPaidTarget(input)
      assertTargetCycle(input, event.evidence)
      if (input.currentStatus === 'scheduled') {
        return 'applying'
      }
      break
    case 'cancellation_boundary_reached':
      if (input.operation !== 'period_end_cancel') {
        reject(
          'operation_mismatch',
          input,
          'Paid replacement activation requires a captured target cycle',
        )
      }
      assertEffectiveBoundary(input, event.evidence)
      if (input.currentStatus === 'scheduled') {
        return 'applying'
      }
      break
    case 'projection_committed':
      if (!validDate(event.committedAt)) {
        reject(
          'invalid_evidence',
          input,
          'Projection commit time is invalid',
        )
      }
      if (input.currentStatus === 'applying') {
        return 'applied'
      }
      break
    case 'provider_uncertain':
      if (input.currentStatus === 'reconciling') {
        return 'reconciling'
      }
      if (
        input.currentStatus === 'authorization_pending' ||
        input.currentStatus === 'old_cancellation_pending' ||
        input.currentStatus === 'scheduled' ||
        input.currentStatus === 'applying' ||
        input.currentStatus === 'compensating'
      ) {
        return 'reconciling'
      }
      break
    case 'recovery_resolved':
      if (input.currentStatus === 'reconciling') {
        assertResumeEvidence(
          input,
          event.resumeAt,
          event.evidence,
        )
        return event.resumeAt
      }
      break
    case 'review_required':
      if (input.currentStatus === 'review') {
        return 'review'
      }
      return 'review'
    case 'review_resolved':
      if (input.currentStatus === 'review') {
        assertResumeEvidence(
          input,
          event.resumeAt,
          event.evidence,
        )
        return event.resumeAt
      }
      break
    case 'compensation_required':
      assertPaidTarget(input)
      if (
        input.currentStatus === 'authorization_pending' ||
        input.currentStatus === 'old_cancellation_pending' ||
        input.currentStatus === 'scheduled' ||
        input.currentStatus === 'reconciling' ||
        input.currentStatus === 'review'
      ) {
        return 'compensating'
      }
      break
    case 'user_cancel_requested':
      return transitionUserCancellation(input, event)
    case 'compensation_completed':
      assertPaidTarget(input)
      assertReplacementTermination(input, event.evidence)
      if (input.currentStatus === 'compensating') {
        return event.outcome
      }
      break
    case 'failure_confirmed':
      assertNoProviderEffects(input, event.evidence)
      if (
        input.currentStatus === 'requested' ||
        input.currentStatus === 'authorization_pending' ||
        input.currentStatus === 'reconciling' ||
        input.currentStatus === 'review' ||
        (
          input.operation === 'period_end_cancel' &&
          input.currentStatus === 'old_cancellation_pending'
        )
      ) {
        return 'failed'
      }
      break
  }

  return reject(
    'event_not_allowed',
    input,
    `${event.type} is not allowed from ${input.currentStatus} for ${input.operation}`,
  )
}
