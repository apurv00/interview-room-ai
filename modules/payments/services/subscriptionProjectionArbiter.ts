import {
  classifyPlanChangeControlLineage,
  type PlanChangeControlLineage,
} from '../models/PlanChangeRequest'
import type { ProviderMode } from '../types/catalog'

export const SUBSCRIPTION_PROJECTION_DECISIONS = [
  'project',
  'financial_history_only',
  'financial_review',
  'noop_verify',
  'review',
] as const
export type SubscriptionProjectionDecisionKind =
  (typeof SUBSCRIPTION_PROJECTION_DECISIONS)[number]

export const SUBSCRIPTION_PROJECTION_PROJECT_REASON_CODES = [
  'acquisition_cycle_projects',
  'plan_change_target_activates',
  'current_target_cycle_projects',
] as const
export type SubscriptionProjectionProjectReasonCode =
  (typeof SUBSCRIPTION_PROJECTION_PROJECT_REASON_CODES)[number]

export const SUBSCRIPTION_PROJECTION_HISTORY_REASON_CODES = [
  'acquisition_historical_cycle',
  'old_cycle_before_boundary',
  'target_historical_cycle',
] as const
export type SubscriptionProjectionHistoryReasonCode =
  (typeof SUBSCRIPTION_PROJECTION_HISTORY_REASON_CODES)[number]

export const SUBSCRIPTION_PROJECTION_FINANCIAL_REVIEW_REASON_CODES = [
  'old_cycle_starts_at_or_after_boundary',
  'old_cycle_overlaps_boundary',
  'current_period_overlap',
] as const
export type SubscriptionProjectionFinancialReviewReasonCode =
  (typeof SUBSCRIPTION_PROJECTION_FINANCIAL_REVIEW_REASON_CODES)[number]

export const SUBSCRIPTION_PROJECTION_NOOP_REASON_CODES = [
  'acquisition_replay_verified',
  'acquisition_history_replay_verified',
  'old_history_replay_verified',
  'old_financial_review_replay_verified',
  'applied_target_replay_verified',
  'target_history_replay_verified',
  'target_financial_review_replay_verified',
] as const
export type SubscriptionProjectionNoopReasonCode =
  (typeof SUBSCRIPTION_PROJECTION_NOOP_REASON_CODES)[number]

export const SUBSCRIPTION_PROJECTION_REVIEW_REASON_CODES = [
  'invalid_cycle_evidence',
  'cycle_subscription_binding_mismatch',
  'cycle_replay_conflict',
  'acquisition_lineage_mismatch',
  'plan_change_evidence_invalid',
  'unknown_subscription_lineage',
  'target_lineage_mismatch',
  'target_activation_boundary_mismatch',
  'target_activation_status_mismatch',
  'target_applied_state_mismatch',
  'projection_replay_mismatch',
  'current_period_record_missing',
  'target_current_period_missing',
  'subscription_status_not_projectable',
  'user_projection_authority_mismatch',
] as const
export type SubscriptionProjectionReviewReasonCode =
  (typeof SUBSCRIPTION_PROJECTION_REVIEW_REASON_CODES)[number]

export const SUBSCRIPTION_PROJECTION_REASON_CODES = [
  ...SUBSCRIPTION_PROJECTION_PROJECT_REASON_CODES,
  ...SUBSCRIPTION_PROJECTION_HISTORY_REASON_CODES,
  ...SUBSCRIPTION_PROJECTION_FINANCIAL_REVIEW_REASON_CODES,
  ...SUBSCRIPTION_PROJECTION_NOOP_REASON_CODES,
  ...SUBSCRIPTION_PROJECTION_REVIEW_REASON_CODES,
] as const
export type SubscriptionProjectionReasonCode =
  (typeof SUBSCRIPTION_PROJECTION_REASON_CODES)[number]

export type SubscriptionProjectionLineage =
  | 'acquisition'
  | 'target'
  | 'old'
  | 'unknown'

export interface SubscriptionProjectionEffects {
  readonly createFinancialRecords: boolean
  readonly updateSubscriptionPeriod: boolean
  readonly updateUserProjection: boolean
  readonly transitionPlanChange: boolean
}

export type SubscriptionProjectionDecision =
  | {
      decision: 'project'
      lineage: 'acquisition' | 'target'
      reason: SubscriptionProjectionProjectReasonCode
      effects: SubscriptionProjectionEffects
    }
  | {
      decision: 'financial_history_only'
      lineage: 'acquisition' | 'target' | 'old'
      reason: SubscriptionProjectionHistoryReasonCode
      effects: SubscriptionProjectionEffects
    }
  | {
      decision: 'financial_review'
      lineage: 'target' | 'old'
      reason: SubscriptionProjectionFinancialReviewReasonCode
      effects: SubscriptionProjectionEffects
    }
  | {
      decision: 'noop_verify'
      lineage: 'acquisition' | 'target' | 'old'
      reason: SubscriptionProjectionNoopReasonCode
      effects: SubscriptionProjectionEffects
    }
  | {
      decision: 'review'
      lineage: SubscriptionProjectionLineage
      reason: SubscriptionProjectionReviewReasonCode
      effects: SubscriptionProjectionEffects
    }

export type ProjectionCheckoutPurpose =
  | 'acquisition'
  | 'replacement'
  | 'resubscribe'
export type ProjectionLeaseLane = 'a' | 'b'
export type ProjectionCheckoutStatus =
  | 'created'
  | 'remote_created'
  | 'checkout_opened'
  | 'authorization_pending'
  | 'payment_captured'
  | 'fulfilled'
  | 'abandoned'
  | 'failed'
  | 'cancelled'
  | 'review'
export type ProjectionSubscriptionStatus =
  | 'created'
  | 'authenticated'
  | 'activation_pending'
  | 'active'
  | 'pending'
  | 'halted'
  | 'paused'
  | 'cancelled'
  | 'completed'
  | 'expired'
  | 'review'
export type ProjectionPlanChangeStatus =
  | 'requested'
  | 'authorization_pending'
  | 'old_cancellation_pending'
  | 'reconciling'
  | 'scheduled'
  | 'applying'
  | 'compensating'
  | 'applied'
  | 'cancelled'
  | 'failed'
  | 'review'
export type ProjectionPlanChangeOperation =
  | 'tier_change'
  | 'resubscribe'
  | 'period_end_cancel'

export interface ProjectionCheckoutEvidence {
  id: string
  userId: string
  providerMode: ProviderMode
  purpose: ProjectionCheckoutPurpose
  planChangeRequestId?: string
  leaseLane: ProjectionLeaseLane
  planKey: 'plus' | 'pro'
  catalogVersion: string
  razorpaySubscriptionId: string
  requestedStartAtEpochSeconds?: number
  authorizationExpiresAtEpochSeconds: number
  status: ProjectionCheckoutStatus
}

export interface ProjectionSubscriptionEvidence {
  id: string
  userId: string
  providerMode: ProviderMode
  planKey: 'plus' | 'pro'
  catalogVersion: string
  razorpayPlanId: string
  razorpaySubscriptionId: string
  checkoutIntentId: string
  planChangeRequestId?: string
  replacesSubscriptionId?: string
  leaseLane: ProjectionLeaseLane
  requestedStartAtEpochSeconds?: number
  authorizationExpiresAtEpochSeconds: number
  status: ProjectionSubscriptionStatus
  currentPeriodKey?: string
  currentPeriodStartEpochSeconds?: number
  currentPeriodEndEpochSeconds?: number
}

export interface ProjectionCycleEvidence {
  providerMode: ProviderMode
  subscriptionId: string
  razorpaySubscriptionId: string
  userId: string
  planKey: 'plus' | 'pro'
  catalogVersion: string
  razorpayPlanId: string
  periodKey: string
  periodStartEpochSeconds: number
  periodEndEpochSeconds: number
  razorpayInvoiceId: string
  razorpayPaymentId: string
  capturedPaise: number
  currency: 'INR'
}

export type RecordedProjectionDisposition =
  | 'projected'
  | 'financial_history'
  | 'financial_review'

export interface ExistingProjectionCycleEvidence
  extends ProjectionCycleEvidence {
  disposition: RecordedProjectionDisposition
}

export interface UserSubscriptionProjectionEvidence {
  planKey: 'plus' | 'pro'
  entitlementSource: 'subscription'
  usagePeriodKey: string
  planExpiresAtEpochSeconds: number
}

export interface ProjectionPlanChangeEvidence {
  id: string
  userId: string
  actorUserId: string
  source: 'customer' | 'admin'
  controlLineage: PlanChangeControlLineage
  adminControl?: unknown
  providerMode: ProviderMode
  operation: ProjectionPlanChangeOperation
  fromPlanKey: 'plus' | 'pro'
  toPlanKey: 'free' | 'plus' | 'pro'
  targetCatalogVersion: string
  checkoutIntentId?: string
  fromSubscriptionId: string
  toSubscriptionId?: string
  fromRazorpaySubscriptionId: string
  toRazorpaySubscriptionId?: string
  targetRazorpayPlanId?: string
  activeFenceKey?: string
  requestedAtEpochSeconds: number
  requestedEffectiveAtEpochSeconds: number
  authorizationExpiresAtEpochSeconds?: number
  replacementAuthorizationPaymentId?: string
  replacementAuthorizedAtEpochSeconds?: number
  oldCancellationAcceptedAtEpochSeconds?: number
  oldCancellationEffectiveAtEpochSeconds?: number
  status: ProjectionPlanChangeStatus
  outcome?: 'applied' | 'cancelled' | 'failed' | 'superseded'
  effectiveAtEpochSeconds?: number
}

export interface SubscriptionProjectionArbiterInput {
  cycle: Readonly<ProjectionCycleEvidence>
  subscription: Readonly<ProjectionSubscriptionEvidence>
  checkout: Readonly<ProjectionCheckoutEvidence>
  planChange?: Readonly<ProjectionPlanChangeEvidence>
  existingCycle?: Readonly<ExistingProjectionCycleEvidence>
  userProjection?: Readonly<UserSubscriptionProjectionEvidence>
}

type PeriodRelation =
  | 'first'
  | 'same'
  | 'older'
  | 'newer'
  | 'overlap'

const OBJECT_ID_PATTERN = /^[a-fA-F0-9]{24}$/
const RAZORPAY_ID_PATTERNS = {
  subscription: /^sub_[A-Za-z0-9]+$/,
  plan: /^plan_[A-Za-z0-9]+$/,
  payment: /^pay_[A-Za-z0-9]+$/,
  invoice: /^inv_[A-Za-z0-9]+$/,
} as const
const BOUNDARY_FENCE_STATUSES: ReadonlySet<
  ProjectionPlanChangeStatus
> = new Set<ProjectionPlanChangeStatus>([
  'requested',
  'authorization_pending',
  'old_cancellation_pending',
  'reconciling',
  'scheduled',
  'applying',
  'compensating',
  'applied',
  'review',
])

const NO_EFFECTS: SubscriptionProjectionEffects = Object.freeze({
  createFinancialRecords: false,
  updateSubscriptionPeriod: false,
  updateUserProjection: false,
  transitionPlanChange: false,
})
const FINANCIAL_ONLY_EFFECTS: SubscriptionProjectionEffects = Object.freeze({
  createFinancialRecords: true,
  updateSubscriptionPeriod: false,
  updateUserProjection: false,
  transitionPlanChange: false,
})
const PROJECT_ACQUISITION_EFFECTS: SubscriptionProjectionEffects =
Object.freeze({
  createFinancialRecords: true,
  updateSubscriptionPeriod: true,
  updateUserProjection: true,
  transitionPlanChange: false,
})
const PROJECT_TARGET_ACTIVATION_EFFECTS: SubscriptionProjectionEffects =
Object.freeze({
  createFinancialRecords: true,
  updateSubscriptionPeriod: true,
  updateUserProjection: true,
  transitionPlanChange: true,
})
const PROJECT_CURRENT_TARGET_EFFECTS: SubscriptionProjectionEffects =
Object.freeze({
  createFinancialRecords: true,
  updateSubscriptionPeriod: true,
  updateUserProjection: true,
  transitionPlanChange: false,
})

function safeEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function nonEmpty(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= max &&
    value === value.trim()
  )
}

function exactOptional<T>(
  left: T | undefined,
  right: T | undefined,
): boolean {
  return left === right
}

function validPeriodTuple(
  subscription: Readonly<ProjectionSubscriptionEvidence>,
): boolean {
  const tuple = [
    subscription.currentPeriodKey,
    subscription.currentPeriodStartEpochSeconds,
    subscription.currentPeriodEndEpochSeconds,
  ]
  const present = tuple.filter((value) => value !== undefined).length
  if (present === 0) return true
  return (
    present === tuple.length &&
    nonEmpty(subscription.currentPeriodKey, 255) &&
    safeEpoch(subscription.currentPeriodStartEpochSeconds) &&
    safeEpoch(subscription.currentPeriodEndEpochSeconds) &&
    subscription.currentPeriodEndEpochSeconds >
      subscription.currentPeriodStartEpochSeconds
  )
}

function validCycle(
  cycle: Readonly<ProjectionCycleEvidence>,
): boolean {
  return (
    (cycle.providerMode === 'test' || cycle.providerMode === 'live') &&
    OBJECT_ID_PATTERN.test(cycle.subscriptionId) &&
    RAZORPAY_ID_PATTERNS.subscription.test(
      cycle.razorpaySubscriptionId,
    ) &&
    OBJECT_ID_PATTERN.test(cycle.userId) &&
    (cycle.planKey === 'plus' || cycle.planKey === 'pro') &&
    nonEmpty(cycle.catalogVersion, 100) &&
    RAZORPAY_ID_PATTERNS.plan.test(cycle.razorpayPlanId) &&
    nonEmpty(cycle.periodKey, 255) &&
    safeEpoch(cycle.periodStartEpochSeconds) &&
    safeEpoch(cycle.periodEndEpochSeconds) &&
    cycle.periodEndEpochSeconds > cycle.periodStartEpochSeconds &&
    RAZORPAY_ID_PATTERNS.invoice.test(cycle.razorpayInvoiceId) &&
    RAZORPAY_ID_PATTERNS.payment.test(cycle.razorpayPaymentId) &&
    positiveSafeInteger(cycle.capturedPaise) &&
    cycle.currency === 'INR'
  )
}

function validSubscription(
  subscription: Readonly<ProjectionSubscriptionEvidence>,
): boolean {
  return (
    OBJECT_ID_PATTERN.test(subscription.id) &&
    OBJECT_ID_PATTERN.test(subscription.userId) &&
    (
      subscription.providerMode === 'test' ||
      subscription.providerMode === 'live'
    ) &&
    (
      subscription.planKey === 'plus' ||
      subscription.planKey === 'pro'
    ) &&
    nonEmpty(subscription.catalogVersion, 100) &&
    RAZORPAY_ID_PATTERNS.plan.test(subscription.razorpayPlanId) &&
    RAZORPAY_ID_PATTERNS.subscription.test(
      subscription.razorpaySubscriptionId,
    ) &&
    OBJECT_ID_PATTERN.test(subscription.checkoutIntentId) &&
    (
      subscription.planChangeRequestId === undefined ||
      OBJECT_ID_PATTERN.test(subscription.planChangeRequestId)
    ) &&
    (
      subscription.replacesSubscriptionId === undefined ||
      OBJECT_ID_PATTERN.test(subscription.replacesSubscriptionId)
    ) &&
    (subscription.leaseLane === 'a' || subscription.leaseLane === 'b') &&
    (
      subscription.requestedStartAtEpochSeconds === undefined ||
      safeEpoch(subscription.requestedStartAtEpochSeconds)
    ) &&
    safeEpoch(subscription.authorizationExpiresAtEpochSeconds) &&
    (
      subscription.requestedStartAtEpochSeconds === undefined ||
      subscription.authorizationExpiresAtEpochSeconds <
        subscription.requestedStartAtEpochSeconds
    ) &&
    validPeriodTuple(subscription)
  )
}

function validCheckout(
  checkout: Readonly<ProjectionCheckoutEvidence>,
): boolean {
  return (
    OBJECT_ID_PATTERN.test(checkout.id) &&
    OBJECT_ID_PATTERN.test(checkout.userId) &&
    (checkout.providerMode === 'test' || checkout.providerMode === 'live') &&
    (
      checkout.purpose === 'acquisition' ||
      checkout.purpose === 'replacement' ||
      checkout.purpose === 'resubscribe'
    ) &&
    (
      checkout.planChangeRequestId === undefined ||
      OBJECT_ID_PATTERN.test(checkout.planChangeRequestId)
    ) &&
    (checkout.leaseLane === 'a' || checkout.leaseLane === 'b') &&
    (checkout.planKey === 'plus' || checkout.planKey === 'pro') &&
    nonEmpty(checkout.catalogVersion, 100) &&
    RAZORPAY_ID_PATTERNS.subscription.test(
      checkout.razorpaySubscriptionId,
    ) &&
    (
      checkout.requestedStartAtEpochSeconds === undefined ||
      safeEpoch(checkout.requestedStartAtEpochSeconds)
    ) &&
    safeEpoch(checkout.authorizationExpiresAtEpochSeconds) &&
    (
      checkout.requestedStartAtEpochSeconds === undefined ||
      checkout.authorizationExpiresAtEpochSeconds <
        checkout.requestedStartAtEpochSeconds
    )
  )
}

function cycleMatchesSubscription(
  cycle: Readonly<ProjectionCycleEvidence>,
  subscription: Readonly<ProjectionSubscriptionEvidence>,
): boolean {
  return (
    cycle.subscriptionId === subscription.id &&
    cycle.razorpaySubscriptionId ===
      subscription.razorpaySubscriptionId &&
    cycle.userId === subscription.userId &&
    cycle.providerMode === subscription.providerMode &&
    cycle.planKey === subscription.planKey &&
    cycle.catalogVersion === subscription.catalogVersion &&
    cycle.razorpayPlanId === subscription.razorpayPlanId
  )
}

function exactExistingCycle(
  cycle: Readonly<ProjectionCycleEvidence>,
  existing: Readonly<ExistingProjectionCycleEvidence>,
): boolean {
  return (
    cycle.providerMode === existing.providerMode &&
    cycle.subscriptionId === existing.subscriptionId &&
    cycle.razorpaySubscriptionId ===
      existing.razorpaySubscriptionId &&
    cycle.userId === existing.userId &&
    cycle.planKey === existing.planKey &&
    cycle.catalogVersion === existing.catalogVersion &&
    cycle.razorpayPlanId === existing.razorpayPlanId &&
    cycle.periodKey === existing.periodKey &&
    cycle.periodStartEpochSeconds ===
      existing.periodStartEpochSeconds &&
    cycle.periodEndEpochSeconds === existing.periodEndEpochSeconds &&
    cycle.razorpayInvoiceId === existing.razorpayInvoiceId &&
    cycle.razorpayPaymentId === existing.razorpayPaymentId &&
    cycle.capturedPaise === existing.capturedPaise &&
    cycle.currency === existing.currency
  )
}

function planChangeShapeValid(
  planChange: Readonly<ProjectionPlanChangeEvidence>,
): boolean {
  const classifiedControlLineage =
    classifyPlanChangeControlLineage(planChange)
  const isCancellation =
    planChange.operation === 'period_end_cancel'
  const operationMatchesPlans =
    (
      planChange.operation === 'tier_change' &&
      planChange.fromPlanKey !== planChange.toPlanKey
    ) ||
    (
      planChange.operation === 'resubscribe' &&
      planChange.fromPlanKey === planChange.toPlanKey
    ) ||
    (
      isCancellation &&
      planChange.toPlanKey === 'free'
    )
  const hasAuthorizationId =
    planChange.replacementAuthorizationPaymentId !== undefined
  const hasAuthorizationTime =
    planChange.replacementAuthorizedAtEpochSeconds !== undefined
  const hasCancellationAcceptance =
    planChange.oldCancellationAcceptedAtEpochSeconds !== undefined
  const hasCancellationBoundary =
    planChange.oldCancellationEffectiveAtEpochSeconds !== undefined
  const authorizationTupleValid =
    hasAuthorizationId === hasAuthorizationTime &&
    (
      !hasAuthorizationId ||
      (
        RAZORPAY_ID_PATTERNS.payment.test(
          planChange.replacementAuthorizationPaymentId as string,
        ) &&
        safeEpoch(
          planChange.replacementAuthorizedAtEpochSeconds,
        ) &&
        safeEpoch(planChange.authorizationExpiresAtEpochSeconds) &&
        (
          planChange.replacementAuthorizedAtEpochSeconds as number
        ) >= planChange.requestedAtEpochSeconds &&
        (
          planChange.replacementAuthorizedAtEpochSeconds as number
        ) < (
          planChange.authorizationExpiresAtEpochSeconds as number
        ) &&
        (
          planChange.authorizationExpiresAtEpochSeconds as number
        ) < planChange.requestedEffectiveAtEpochSeconds
      )
    )
  const cancellationTupleValid =
    hasCancellationAcceptance === hasCancellationBoundary &&
    (
      !hasCancellationAcceptance ||
      (
        safeEpoch(planChange.oldCancellationAcceptedAtEpochSeconds) &&
        planChange.oldCancellationAcceptedAtEpochSeconds >=
          planChange.requestedAtEpochSeconds &&
        planChange.oldCancellationAcceptedAtEpochSeconds <=
          planChange.requestedEffectiveAtEpochSeconds &&
        planChange.oldCancellationEffectiveAtEpochSeconds ===
          planChange.requestedEffectiveAtEpochSeconds
      )
    )
  const scheduledOrLater =
    planChange.status === 'scheduled' ||
    planChange.status === 'applying' ||
    planChange.status === 'applied'
  const terminal =
    planChange.status === 'applied' ||
    planChange.status === 'cancelled' ||
    planChange.status === 'failed'
  const expectedActiveFence =
    `${planChange.providerMode}:${planChange.userId}`
  const authorityValid =
    OBJECT_ID_PATTERN.test(planChange.actorUserId) &&
    classifiedControlLineage === planChange.controlLineage &&
    (
      terminal
        ? planChange.activeFenceKey === undefined
        : planChange.activeFenceKey === expectedActiveFence
    )
  const statusEvidenceValid =
    (
      !scheduledOrLater ||
      (
        isCancellation
          ? hasCancellationAcceptance
          : (
              hasAuthorizationId &&
              (
                planChange.operation === 'resubscribe' ||
                hasCancellationAcceptance
              )
            )
      )
    ) &&
    (
      planChange.status === 'applied'
        ? (
            planChange.outcome === 'applied' &&
            planChange.effectiveAtEpochSeconds ===
              planChange.requestedEffectiveAtEpochSeconds
          )
        : planChange.status === 'cancelled'
          ? (
              (
                planChange.outcome === 'cancelled' ||
                planChange.outcome === 'superseded'
              ) &&
              planChange.effectiveAtEpochSeconds === undefined
            )
          : planChange.status === 'failed'
            ? (
                planChange.outcome === 'failed' &&
                planChange.effectiveAtEpochSeconds === undefined
              )
            : (
            planChange.outcome === undefined &&
            planChange.effectiveAtEpochSeconds === undefined
              )
    )
  return (
    OBJECT_ID_PATTERN.test(planChange.id) &&
    OBJECT_ID_PATTERN.test(planChange.userId) &&
    authorityValid &&
    (
      planChange.providerMode === 'test' ||
      planChange.providerMode === 'live'
    ) &&
    operationMatchesPlans &&
    nonEmpty(planChange.targetCatalogVersion, 100) &&
    OBJECT_ID_PATTERN.test(planChange.fromSubscriptionId) &&
    RAZORPAY_ID_PATTERNS.subscription.test(
      planChange.fromRazorpaySubscriptionId,
    ) &&
    (
      isCancellation
        ? (
            planChange.checkoutIntentId === undefined &&
            planChange.toSubscriptionId === undefined &&
            planChange.toRazorpaySubscriptionId === undefined &&
            planChange.targetRazorpayPlanId === undefined &&
            !hasAuthorizationId
          )
        : (
            OBJECT_ID_PATTERN.test(
              planChange.checkoutIntentId as string,
            ) &&
            OBJECT_ID_PATTERN.test(
              planChange.toSubscriptionId as string,
            ) &&
            planChange.fromSubscriptionId !==
              planChange.toSubscriptionId &&
            RAZORPAY_ID_PATTERNS.subscription.test(
              planChange.toRazorpaySubscriptionId as string,
            ) &&
            planChange.fromRazorpaySubscriptionId !==
              planChange.toRazorpaySubscriptionId &&
            RAZORPAY_ID_PATTERNS.plan.test(
              planChange.targetRazorpayPlanId as string,
            )
          )
    ) &&
    safeEpoch(planChange.requestedAtEpochSeconds) &&
    safeEpoch(planChange.requestedEffectiveAtEpochSeconds) &&
    planChange.requestedEffectiveAtEpochSeconds >=
      planChange.requestedAtEpochSeconds &&
    authorizationTupleValid &&
    cancellationTupleValid &&
    statusEvidenceValid
  )
}

function exactAcquisitionLineage(
  subscription: Readonly<ProjectionSubscriptionEvidence>,
  checkout: Readonly<ProjectionCheckoutEvidence>,
): boolean {
  return (
    checkout.purpose === 'acquisition' &&
    checkout.planChangeRequestId === undefined &&
    checkout.leaseLane === 'a' &&
    checkout.requestedStartAtEpochSeconds === undefined &&
    subscription.planChangeRequestId === undefined &&
    subscription.replacesSubscriptionId === undefined &&
    subscription.leaseLane === 'a' &&
    subscription.requestedStartAtEpochSeconds === undefined &&
    subscription.checkoutIntentId === checkout.id &&
    subscription.userId === checkout.userId &&
    subscription.providerMode === checkout.providerMode &&
    subscription.planKey === checkout.planKey &&
    subscription.catalogVersion === checkout.catalogVersion &&
    subscription.razorpaySubscriptionId ===
      checkout.razorpaySubscriptionId &&
    subscription.authorizationExpiresAtEpochSeconds ===
      checkout.authorizationExpiresAtEpochSeconds
  )
}

function exactTargetLineage(input: {
  subscription: Readonly<ProjectionSubscriptionEvidence>
  checkout: Readonly<ProjectionCheckoutEvidence>
  planChange: Readonly<ProjectionPlanChangeEvidence>
  cycle: Readonly<ProjectionCycleEvidence>
}): boolean {
  const { subscription, checkout, planChange, cycle } = input
  if (planChange.operation === 'period_end_cancel') return false
  const expectedPurpose =
    planChange.operation === 'tier_change'
      ? 'replacement'
      : 'resubscribe'
  return (
    planChange.controlLineage === 'customer' &&
    planChange.source === 'customer' &&
    planChange.actorUserId === planChange.userId &&
    planChange.userId === subscription.userId &&
    planChange.providerMode === subscription.providerMode &&
    planChange.checkoutIntentId === checkout.id &&
    planChange.toSubscriptionId === subscription.id &&
    planChange.toRazorpaySubscriptionId ===
      subscription.razorpaySubscriptionId &&
    planChange.toPlanKey === subscription.planKey &&
    planChange.targetCatalogVersion === subscription.catalogVersion &&
    planChange.targetRazorpayPlanId === subscription.razorpayPlanId &&
    checkout.userId === subscription.userId &&
    checkout.providerMode === subscription.providerMode &&
    checkout.purpose === expectedPurpose &&
    checkout.planChangeRequestId === planChange.id &&
    checkout.planKey === planChange.toPlanKey &&
    checkout.catalogVersion === planChange.targetCatalogVersion &&
    checkout.razorpaySubscriptionId ===
      planChange.toRazorpaySubscriptionId &&
    checkout.requestedStartAtEpochSeconds ===
      planChange.requestedEffectiveAtEpochSeconds &&
    checkout.authorizationExpiresAtEpochSeconds ===
      planChange.authorizationExpiresAtEpochSeconds &&
    subscription.checkoutIntentId === checkout.id &&
    subscription.planChangeRequestId === planChange.id &&
    subscription.replacesSubscriptionId ===
      planChange.fromSubscriptionId &&
    subscription.leaseLane === checkout.leaseLane &&
    subscription.requestedStartAtEpochSeconds ===
      planChange.requestedEffectiveAtEpochSeconds &&
    subscription.authorizationExpiresAtEpochSeconds ===
      planChange.authorizationExpiresAtEpochSeconds &&
    planChange.replacementAuthorizationPaymentId !==
      cycle.razorpayPaymentId
  )
}

function exactOldLineage(
  subscription: Readonly<ProjectionSubscriptionEvidence>,
  planChange: Readonly<ProjectionPlanChangeEvidence>,
): boolean {
  return (
    planChange.controlLineage === 'customer' &&
    planChange.source === 'customer' &&
    planChange.actorUserId === planChange.userId &&
    planChange.userId === subscription.userId &&
    planChange.providerMode === subscription.providerMode &&
    planChange.fromSubscriptionId === subscription.id &&
    planChange.fromRazorpaySubscriptionId ===
      subscription.razorpaySubscriptionId &&
    planChange.fromPlanKey === subscription.planKey
  )
}

function periodRelation(
  cycle: Readonly<ProjectionCycleEvidence>,
  subscription: Readonly<ProjectionSubscriptionEvidence>,
): PeriodRelation {
  const currentStart = subscription.currentPeriodStartEpochSeconds
  const currentEnd = subscription.currentPeriodEndEpochSeconds
  if (currentStart === undefined || currentEnd === undefined) {
    return 'first'
  }
  if (
    cycle.periodStartEpochSeconds === currentStart &&
    cycle.periodEndEpochSeconds === currentEnd &&
    cycle.periodKey === subscription.currentPeriodKey
  ) {
    return 'same'
  }
  if (cycle.periodEndEpochSeconds <= currentStart) return 'older'
  if (cycle.periodStartEpochSeconds >= currentEnd) return 'newer'
  return 'overlap'
}

function projectionCoversOrSupersedesCycle(input: {
  cycle: Readonly<ProjectionCycleEvidence>
  subscription: Readonly<ProjectionSubscriptionEvidence>
  userProjection?: Readonly<UserSubscriptionProjectionEvidence>
}): boolean {
  const { cycle, subscription, userProjection } = input
  const currentKey = subscription.currentPeriodKey
  const currentStart = subscription.currentPeriodStartEpochSeconds
  const currentEnd = subscription.currentPeriodEndEpochSeconds
  if (
    currentKey === undefined ||
    currentStart === undefined ||
    currentEnd === undefined ||
    !userProjection ||
    userProjection.planKey !== subscription.planKey ||
    userProjection.entitlementSource !== 'subscription' ||
    userProjection.usagePeriodKey !== currentKey ||
    userProjection.planExpiresAtEpochSeconds !== currentEnd
  ) {
    return false
  }
  const sameCycle =
    currentKey === cycle.periodKey &&
    currentStart === cycle.periodStartEpochSeconds &&
    currentEnd === cycle.periodEndEpochSeconds
  const newerCycle = currentStart >= cycle.periodEndEpochSeconds
  return sameCycle || newerCycle
}

function review(
  lineage: SubscriptionProjectionLineage,
  reason: SubscriptionProjectionReviewReasonCode,
): SubscriptionProjectionDecision {
  return {
    decision: 'review',
    lineage,
    reason,
    effects: NO_EFFECTS,
  }
}

function projectedReplay(input: {
  lineage: 'acquisition' | 'target'
  reason: 'acquisition_replay_verified' | 'applied_target_replay_verified'
  cycle: Readonly<ProjectionCycleEvidence>
  subscription: Readonly<ProjectionSubscriptionEvidence>
  userProjection?: Readonly<UserSubscriptionProjectionEvidence>
}): SubscriptionProjectionDecision {
  if (!projectionCoversOrSupersedesCycle(input)) {
    return review(input.lineage, 'projection_replay_mismatch')
  }
  return {
    decision: 'noop_verify',
    lineage: input.lineage,
    reason: input.reason,
    effects: NO_EFFECTS,
  }
}

function classifyCurrentSubscription(input: {
  lineage: 'acquisition' | 'target'
  cycle: Readonly<ProjectionCycleEvidence>
  subscription: Readonly<ProjectionSubscriptionEvidence>
  existingCycle?: Readonly<ExistingProjectionCycleEvidence>
  userProjection?: Readonly<UserSubscriptionProjectionEvidence>
}): SubscriptionProjectionDecision {
  const {
    lineage,
    cycle,
    subscription,
    existingCycle,
    userProjection,
  } = input
  const relation = periodRelation(cycle, subscription)

  if (existingCycle) {
    if (existingCycle.disposition === 'projected') {
      return projectedReplay({
        lineage,
        reason: lineage === 'acquisition'
          ? 'acquisition_replay_verified'
          : 'applied_target_replay_verified',
        cycle,
        subscription,
        userProjection,
      })
    }
    if (existingCycle.disposition === 'financial_history') {
      if (relation !== 'older') {
        return review(lineage, 'cycle_replay_conflict')
      }
      return {
        decision: 'noop_verify',
        lineage,
        reason: lineage === 'acquisition'
          ? 'acquisition_history_replay_verified'
          : 'target_history_replay_verified',
        effects: NO_EFFECTS,
      }
    }
    if (lineage !== 'target' || relation !== 'overlap') {
      return review(lineage, 'cycle_replay_conflict')
    }
    return {
      decision: 'noop_verify',
      lineage,
      reason: 'target_financial_review_replay_verified',
      effects: NO_EFFECTS,
    }
  }

  if (subscription.status !== 'active') {
    return review(lineage, 'subscription_status_not_projectable')
  }
  if (relation === 'same') {
    return review(lineage, 'current_period_record_missing')
  }
  if (relation === 'older') {
    return {
      decision: 'financial_history_only',
      lineage,
      reason: lineage === 'acquisition'
        ? 'acquisition_historical_cycle'
        : 'target_historical_cycle',
      effects: FINANCIAL_ONLY_EFFECTS,
    }
  }
  if (relation === 'overlap') {
    if (lineage === 'acquisition') {
      return review(lineage, 'cycle_replay_conflict')
    }
    return {
      decision: 'financial_review',
      lineage,
      reason: 'current_period_overlap',
      effects: FINANCIAL_ONLY_EFFECTS,
    }
  }
  return {
    decision: 'project',
    lineage,
    reason: lineage === 'acquisition'
      ? 'acquisition_cycle_projects'
      : 'current_target_cycle_projects',
    effects: lineage === 'acquisition'
      ? PROJECT_ACQUISITION_EFFECTS
      : PROJECT_CURRENT_TARGET_EFFECTS,
  }
}

function classifyOldSubscription(input: {
  cycle: Readonly<ProjectionCycleEvidence>
  planChange: Readonly<ProjectionPlanChangeEvidence>
  existingCycle?: Readonly<ExistingProjectionCycleEvidence>
}): SubscriptionProjectionDecision {
  const { cycle, planChange, existingCycle } = input
  const boundary = planChange.requestedEffectiveAtEpochSeconds
  const before = cycle.periodEndEpochSeconds <= boundary
  const startsAtOrAfter = cycle.periodStartEpochSeconds >= boundary
  const expectedDisposition: RecordedProjectionDisposition = before
    ? 'financial_history'
    : 'financial_review'

  if (existingCycle) {
    if (existingCycle.disposition !== expectedDisposition) {
      return review('old', 'cycle_replay_conflict')
    }
    return {
      decision: 'noop_verify',
      lineage: 'old',
      reason: before
        ? 'old_history_replay_verified'
        : 'old_financial_review_replay_verified',
      effects: NO_EFFECTS,
    }
  }
  if (before) {
    return {
      decision: 'financial_history_only',
      lineage: 'old',
      reason: 'old_cycle_before_boundary',
      effects: FINANCIAL_ONLY_EFFECTS,
    }
  }
  return {
    decision: 'financial_review',
    lineage: 'old',
    reason: startsAtOrAfter
      ? 'old_cycle_starts_at_or_after_boundary'
      : 'old_cycle_overlaps_boundary',
    effects: FINANCIAL_ONLY_EFFECTS,
  }
}

function classifyTargetSubscription(input: {
  cycle: Readonly<ProjectionCycleEvidence>
  subscription: Readonly<ProjectionSubscriptionEvidence>
  checkout: Readonly<ProjectionCheckoutEvidence>
  planChange: Readonly<ProjectionPlanChangeEvidence>
  existingCycle?: Readonly<ExistingProjectionCycleEvidence>
  userProjection?: Readonly<UserSubscriptionProjectionEvidence>
}): SubscriptionProjectionDecision {
  const {
    cycle,
    subscription,
    checkout,
    planChange,
    existingCycle,
    userProjection,
  } = input
  if (!exactTargetLineage({ cycle, subscription, checkout, planChange })) {
    return review('target', 'target_lineage_mismatch')
  }

  if (planChange.status === 'applied') {
    if (checkout.status !== 'fulfilled') {
      return review('target', 'target_applied_state_mismatch')
    }
    if (
      cycle.periodStartEpochSeconds ===
        planChange.requestedEffectiveAtEpochSeconds
    ) {
      if (
        !existingCycle ||
        existingCycle.disposition !== 'projected'
      ) {
        return review('target', 'target_applied_state_mismatch')
      }
      return projectedReplay({
        lineage: 'target',
        reason: 'applied_target_replay_verified',
        cycle,
        subscription,
        userProjection,
      })
    }
    if (
      subscription.currentPeriodStartEpochSeconds === undefined ||
      subscription.currentPeriodEndEpochSeconds === undefined
    ) {
      return review('target', 'target_current_period_missing')
    }
    return classifyCurrentSubscription({
      lineage: 'target',
      cycle,
      subscription,
      existingCycle,
      userProjection,
    })
  }

  if (
    planChange.status !== 'scheduled'
  ) {
    return review('target', 'target_activation_status_mismatch')
  }
  if (checkout.status !== 'authorization_pending') {
    return review('target', 'target_activation_status_mismatch')
  }
  if (
    cycle.periodStartEpochSeconds !==
      planChange.requestedEffectiveAtEpochSeconds
  ) {
    return review('target', 'target_activation_boundary_mismatch')
  }
  if (existingCycle) {
    return review('target', 'target_applied_state_mismatch')
  }
  if (
    subscription.currentPeriodKey !== undefined ||
    subscription.currentPeriodStartEpochSeconds !== undefined ||
    subscription.currentPeriodEndEpochSeconds !== undefined
  ) {
    return review('target', 'target_applied_state_mismatch')
  }
  if (
    !userProjection ||
    userProjection.entitlementSource !== 'subscription' ||
    userProjection.planKey !== planChange.fromPlanKey ||
    userProjection.planExpiresAtEpochSeconds !==
      planChange.requestedEffectiveAtEpochSeconds
  ) {
    return review('target', 'user_projection_authority_mismatch')
  }
  if (subscription.status !== 'active') {
    return review('target', 'subscription_status_not_projectable')
  }
  return {
    decision: 'project',
    lineage: 'target',
    reason: 'plan_change_target_activates',
    effects: PROJECT_TARGET_ACTIVATION_EFFECTS,
  }
}

export function arbitrateSubscriptionCycleProjection(
  input: SubscriptionProjectionArbiterInput,
): SubscriptionProjectionDecision {
  const {
    cycle,
    subscription,
    checkout,
    planChange,
    existingCycle,
    userProjection,
  } = input

  if (
    !validCycle(cycle) ||
    !validSubscription(subscription) ||
    !validCheckout(checkout)
  ) {
    return review('unknown', 'invalid_cycle_evidence')
  }
  if (!cycleMatchesSubscription(cycle, subscription)) {
    return review('unknown', 'cycle_subscription_binding_mismatch')
  }
  if (
    subscription.checkoutIntentId !== checkout.id ||
    checkout.userId !== subscription.userId ||
    checkout.providerMode !== subscription.providerMode ||
    checkout.planKey !== subscription.planKey ||
    checkout.catalogVersion !== subscription.catalogVersion ||
    checkout.razorpaySubscriptionId !==
      subscription.razorpaySubscriptionId
  ) {
    return review('unknown', 'cycle_subscription_binding_mismatch')
  }
  if (existingCycle && !exactExistingCycle(cycle, existingCycle)) {
    return review('unknown', 'cycle_replay_conflict')
  }

  if (planChange) {
    if (!planChangeShapeValid(planChange)) {
      return review('unknown', 'plan_change_evidence_invalid')
    }
    const appearsTarget =
      subscription.id === planChange.toSubscriptionId ||
      subscription.razorpaySubscriptionId ===
        planChange.toRazorpaySubscriptionId ||
      checkout.planChangeRequestId === planChange.id
    const appearsOld =
      subscription.id === planChange.fromSubscriptionId ||
      subscription.razorpaySubscriptionId ===
        planChange.fromRazorpaySubscriptionId

    if (appearsTarget && appearsOld) {
      return review('unknown', 'unknown_subscription_lineage')
    }
    if (appearsTarget) {
      return classifyTargetSubscription({
        cycle,
        subscription,
        checkout,
        planChange,
        existingCycle,
        userProjection,
      })
    }
    if (appearsOld) {
      if (!exactOldLineage(subscription, planChange)) {
        return review('old', 'plan_change_evidence_invalid')
      }
      if (BOUNDARY_FENCE_STATUSES.has(planChange.status)) {
        return classifyOldSubscription({
          cycle,
          planChange,
          existingCycle,
        })
      }
      if (exactAcquisitionLineage(subscription, checkout)) {
        return classifyCurrentSubscription({
          lineage: 'acquisition',
          cycle,
          subscription,
          existingCycle,
          userProjection,
        })
      }
      return review('unknown', 'acquisition_lineage_mismatch')
    }
    return review('unknown', 'unknown_subscription_lineage')
  }

  if (!exactAcquisitionLineage(subscription, checkout)) {
    return review('unknown', 'acquisition_lineage_mismatch')
  }
  return classifyCurrentSubscription({
    lineage: 'acquisition',
    cycle,
    subscription,
    existingCycle,
    userProjection,
  })
}
