import {
  INITIAL_BASIC_ENTITLEMENT_PROJECTION_VERSION,
  initialBasicEntitlementProjection,
} from '@shared/services/planConfig'

export const ENTITLEMENT_MIGRATION_PROJECTION_VERSION =
  INITIAL_BASIC_ENTITLEMENT_PROJECTION_VERSION

/**
 * A stored value in any of these fields is evidence that the user may already
 * have billing history. The migration must inventory the row, never turn the
 * plan label into proof of a paid entitlement.
 */
export const ENTITLEMENT_MIGRATION_BILLING_MARKER_FIELDS = [
  'stripeCustomerId',
  'razorpayCustomerId',
  'planExpiresAt',
] as const

/**
 * A missing entitlementVersion combined with any of these fields is a partial
 * or interrupted projection. Reinitializing it would risk resetting usage.
 */
export const ENTITLEMENT_MIGRATION_PARTIAL_PROJECTION_FIELDS = [
  'entitlementSource',
  'usagePeriodKey',
  'interviewsUsed',
  'interviewLimit',
  'premiumResumesUsed',
  'premiumResumeLimit',
  'usageResetAt',
  'freeBasicResumeId',
  'buyerState',
  'entitlementAuthority',
] as const

export const ENTITLEMENT_MIGRATION_REQUIRED_PROJECTION_FIELDS = [
  'entitlementSource',
  'usagePeriodKey',
  'interviewsUsed',
  'interviewLimit',
  'premiumResumesUsed',
  'premiumResumeLimit',
  'usageResetAt',
  'entitlementVersion',
] as const

export type EntitlementMigrationDecision =
  | 'initialize_v2_free'
  | 'manual_review'
  | 'already_initialized'

export type EntitlementMigrationReviewReason =
  | 'legacy_or_unversioned_plan_vocabulary'
  | 'non_free_plan_requires_payment_evidence'
  | 'unknown_or_missing_plan'
  | 'stripe_billing_marker'
  | 'razorpay_billing_marker'
  | 'expiry_billing_marker'
  | 'non_free_entitlement_source'
  | 'partial_entitlement_projection'
  | 'malformed_entitlement_projection'

export interface EntitlementMigrationUserSnapshot
  extends Readonly<Record<string, unknown>> {
  plan?: unknown
  planVocabularyVersion?: unknown
  entitlementVersion?: unknown
  entitlementSource?: unknown
}

export interface EntitlementMigrationClassification {
  decision: EntitlementMigrationDecision
  reasons: readonly EntitlementMigrationReviewReason[]
  billingMarkerFields: readonly string[]
  partialProjectionFields: readonly string[]
  malformedProjectionFields: readonly string[]
}

export interface FreeEntitlementMigrationProjection {
  entitlementSource: 'free'
  usagePeriodKey: string
  interviewsUsed: 0
  interviewLimit: number
  premiumResumesUsed: 0
  premiumResumeLimit: number
  usageResetAt: Date
  entitlementVersion: typeof ENTITLEMENT_MIGRATION_PROJECTION_VERSION
}

function hasStoredField(
  snapshot: EntitlementMigrationUserSnapshot,
  field: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(snapshot, field)
    && snapshot[field] !== undefined
}

function presentFields(
  snapshot: EntitlementMigrationUserSnapshot,
  fields: readonly string[],
): string[] {
  return fields.filter((field) => hasStoredField(snapshot, field))
}

function nonNegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function malformedProjectionFields(
  snapshot: EntitlementMigrationUserSnapshot,
): string[] {
  const validators: Record<
    (typeof ENTITLEMENT_MIGRATION_REQUIRED_PROJECTION_FIELDS)[number],
    (value: unknown) => boolean
  > = {
    entitlementSource: (value) =>
      value === 'free'
      || value === 'subscription'
      || value === 'admin_grant',
    usagePeriodKey: (value) =>
      typeof value === 'string' && value.trim().length > 0,
    interviewsUsed: nonNegativeSafeInteger,
    interviewLimit: nonNegativeSafeInteger,
    premiumResumesUsed: nonNegativeSafeInteger,
    premiumResumeLimit: nonNegativeSafeInteger,
    usageResetAt: (value) =>
      value instanceof Date && Number.isFinite(value.getTime()),
    entitlementVersion: (value) =>
      Number.isSafeInteger(value) && Number(value) > 0,
  }

  const malformed: string[] =
    ENTITLEMENT_MIGRATION_REQUIRED_PROJECTION_FIELDS.filter(
    (field) => !validators[field](snapshot[field]),
  )
  if (malformed.length > 0) return malformed

  const interviewsUsed = Number(snapshot.interviewsUsed)
  const interviewLimit = Number(snapshot.interviewLimit)
  const premiumResumesUsed = Number(snapshot.premiumResumesUsed)
  const premiumResumeLimit = Number(snapshot.premiumResumeLimit)
  if (interviewsUsed > interviewLimit) {
    malformed.push('interviewsUsed')
  }
  if (premiumResumesUsed > premiumResumeLimit) {
    malformed.push('premiumResumesUsed')
  }
  if (snapshot.entitlementSource === 'free') {
    if (snapshot.plan !== 'free') malformed.push('plan')
    if (snapshot.planVocabularyVersion !== 2) {
      malformed.push('planVocabularyVersion')
    }
    if (interviewLimit !== 1) malformed.push('interviewLimit')
    if (premiumResumeLimit !== 0) {
      malformed.push('premiumResumeLimit')
    }
    if (
      typeof snapshot.usagePeriodKey !== 'string'
      || !/^basic:\d{4}-(?:0[1-9]|1[0-2])$/.test(
        snapshot.usagePeriodKey,
      )
    ) {
      malformed.push('usagePeriodKey')
    }
  }
  return Array.from(new Set(malformed))
}

/**
 * Classify a raw User snapshot without consulting external state.
 *
 * The only automatically migratable shape is an untouched, explicitly-v2
 * free user. plus/pro/enterprise are labels for manual review, not evidence of
 * payment. Legacy/unversioned free users are also retained for manual review
 * because their vocabulary is not unequivocal.
 */
export function classifyEntitlementMigrationCandidate(
  snapshot: EntitlementMigrationUserSnapshot,
): EntitlementMigrationClassification {
  const billingMarkerFields = presentFields(
    snapshot,
    ENTITLEMENT_MIGRATION_BILLING_MARKER_FIELDS,
  )
  const partialProjectionFields = presentFields(
    snapshot,
    ENTITLEMENT_MIGRATION_PARTIAL_PROJECTION_FIELDS,
  )

  if (hasStoredField(snapshot, 'entitlementVersion')) {
    const malformedFields = malformedProjectionFields(snapshot)
    if (malformedFields.length > 0) {
      return {
        decision: 'manual_review',
        reasons: ['malformed_entitlement_projection'],
        billingMarkerFields,
        partialProjectionFields,
        malformedProjectionFields: malformedFields,
      }
    }

    return {
      decision: 'already_initialized',
      reasons: [],
      billingMarkerFields: [],
      partialProjectionFields: [],
      malformedProjectionFields: [],
    }
  }

  const reasons: EntitlementMigrationReviewReason[] = []

  if (snapshot.planVocabularyVersion !== 2) {
    reasons.push('legacy_or_unversioned_plan_vocabulary')
  }

  if (snapshot.plan !== 'free') {
    if (
      snapshot.plan === 'plus'
      || snapshot.plan === 'pro'
      || snapshot.plan === 'enterprise'
    ) {
      reasons.push('non_free_plan_requires_payment_evidence')
    } else {
      reasons.push('unknown_or_missing_plan')
    }
  }

  if (billingMarkerFields.includes('stripeCustomerId')) {
    reasons.push('stripe_billing_marker')
  }
  if (billingMarkerFields.includes('razorpayCustomerId')) {
    reasons.push('razorpay_billing_marker')
  }
  if (billingMarkerFields.includes('planExpiresAt')) {
    reasons.push('expiry_billing_marker')
  }

  if (
    hasStoredField(snapshot, 'entitlementSource')
    && snapshot.entitlementSource !== 'free'
  ) {
    reasons.push('non_free_entitlement_source')
  }
  if (partialProjectionFields.length > 0) {
    reasons.push('partial_entitlement_projection')
  }

  if (reasons.length > 0) {
    return {
      decision: 'manual_review',
      reasons,
      billingMarkerFields,
      partialProjectionFields,
      malformedProjectionFields: [],
    }
  }

  return {
    decision: 'initialize_v2_free',
    reasons: [],
    billingMarkerFields: [],
    partialProjectionFields: [],
    malformedProjectionFields: [],
  }
}

/**
 * The write filter deliberately repeats every classifier invariant. If a
 * candidate acquires billing/projection state after the inventory read, the
 * update becomes a no-op instead of overwriting that newer state.
 */
export function buildSafeV2FreeMigrationFilter<UserId>(userId: UserId) {
  const absentBillingAndProjectionFields = Object.fromEntries(
    [
      ...ENTITLEMENT_MIGRATION_BILLING_MARKER_FIELDS,
      ...ENTITLEMENT_MIGRATION_PARTIAL_PROJECTION_FIELDS,
    ].map((field) => [field, { $exists: false as const }]),
  )

  return {
    _id: userId,
    plan: 'free' as const,
    planVocabularyVersion: 2 as const,
    entitlementVersion: { $exists: false as const },
    ...absentBillingAndProjectionFields,
  }
}

export function buildFreeEntitlementMigrationProjection(
  now = new Date(),
): FreeEntitlementMigrationProjection {
  return initialBasicEntitlementProjection(now)
}
