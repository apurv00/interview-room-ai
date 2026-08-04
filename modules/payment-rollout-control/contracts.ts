import { createHash, createHmac } from 'node:crypto'
import { z } from 'zod'

export const BILLING_ROLLOUT_PHASE_REQUEST_SCHEMA_VERSION =
  'billing_rollout_phase_request_v1' as const
export const BILLING_ROLLOUT_APPROVAL_SCHEMA_VERSION =
  'billing_rollout_approval_v1' as const
export const BILLING_ROLLOUT_ACTIVATION_SCHEMA_VERSION =
  'billing_rollout_activation_v1' as const
export const BILLING_ROLLOUT_EMERGENCY_STOP_SCHEMA_VERSION =
  'billing_rollout_emergency_stop_v1' as const
export const BILLING_ROLLOUT_DECISION_SCHEMA_VERSION =
  'billing_rollout_authority_decision_v1' as const
export const BILLING_ROLLOUT_PHASE_IDS = [
  'phase_0_readiness',
  'phase_1_test_qa',
  'phase_2_internal_live',
  'phase_3_qualified_pilot',
  'phase_4_new_users_5',
  'phase_5_new_users_25',
  'phase_6_new_users_100',
  'phase_7_existing_boundary',
  'phase_8_renewal_hold',
] as const
export const BILLING_ROLLOUT_ACTIVATABLE_PHASE_IDS = [
  'phase_1_test_qa',
  'phase_2_internal_live',
  'phase_3_qualified_pilot',
  'phase_4_new_users_5',
  'phase_5_new_users_25',
  'phase_6_new_users_100',
  'phase_7_existing_boundary',
] as const
export const BILLING_ROLLOUT_OWNER_ROLES = [
  'executive_launch',
  'product_rollout',
  'payments_engineering',
  'entitlement_engineering',
  'finance_ca',
  'legal_privacy',
  'security',
  'razorpay_account',
  'support_communications',
  'on_call_incident',
] as const
export const BILLING_ROLLOUT_QUERY_IDS = [
  'rollout_config_snapshot_v1',
  'provider_mode_binding_v1',
  'cohort_consistency_v1',
  'cohort_leakage_v1',
  'captured_without_access_v1',
  'access_without_capture_v1',
  'duplicate_charge_v1',
  'amount_snapshot_mismatch_v1',
  'missing_financial_document_v1',
  'webhook_health_v1',
  'reconciliation_divergence_v1',
  'coupon_integrity_v1',
  'grandfather_integrity_v1',
  'grandfather_paid_overlap_v1',
  'renewal_health_v1',
  'refund_health_v1',
  'deletion_pending_health_v1',
  'support_billing_signal_v1',
] as const
export const BILLING_ROLLOUT_SKUS = [
  'plus_subscription',
  'pro_subscription',
  'additional_interview',
  'premium_resume_unlock',
] as const
export type BillingRolloutPhaseId =
  (typeof BILLING_ROLLOUT_PHASE_IDS)[number]
export type BillingRolloutActivatablePhaseId =
  (typeof BILLING_ROLLOUT_ACTIVATABLE_PHASE_IDS)[number]
export type BillingRolloutOwnerRole =
  (typeof BILLING_ROLLOUT_OWNER_ROLES)[number]
export type BillingRolloutQueryId =
  (typeof BILLING_ROLLOUT_QUERY_IDS)[number]
export type BillingRolloutSku = (typeof BILLING_ROLLOUT_SKUS)[number]
const DIGEST_PATTERN = /^[a-f0-9]{64}$/
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/
const SAFE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{2,199}$/
const COMMIT_SHA_PATTERN = /^[a-f0-9]{7,64}$/
const CATALOG_VERSION_PATTERN =
  /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/
const SEED_ID_PATTERN =
  /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
const DigestSchema = z.string().regex(DIGEST_PATTERN)
const SafeIdSchema = z.string().regex(SAFE_ID_PATTERN)
const CanonicalUtcTimestampSchema = z.string().refine((value) => {
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString() === value
}, 'Must be a canonical UTC timestamp')
const SortedUniqueDigestArraySchema = z.array(DigestSchema)
  .min(1)
  .max(20)
  .refine(
    (values) => values.every(
      (value, index) => index === 0 || values[index - 1]! < value,
    ),
    'Digests must be unique and sorted',
  )
const RolloutSurfacesSchema = z.object({
  selling: z.boolean(),
  enforcement: z.boolean(),
  copy: z.boolean(),
  analytics: z.boolean(),
  communications: z.boolean(),
}).strict()
const SortedUniqueSkuArraySchema = z.array(
  z.enum(BILLING_ROLLOUT_SKUS),
)
  .max(BILLING_ROLLOUT_SKUS.length)
  .refine(
    (values) => values.every(
      (value, index) => index === 0 || values[index - 1]! < value,
    ),
    'SKU scope must be unique and sorted',
  )
export const BillingRolloutRequestedStateSchema = z.object({
  providerMode: z.enum(['none', 'test', 'live']),
  sellingMode: z.enum(['off', 'qa', 'all']),
  enforcementMode: z.enum(['off', 'shadow', 'new_users', 'all']),
  couponMode: z.enum(['off', 'qa', 'all']),
  allowlistCount: z.number().int().min(0).max(500),
  allowlistHash: DigestSchema,
  allowlistExpiresAt: CanonicalUtcTimestampSchema.nullable(),
  skuScope: SortedUniqueSkuArraySchema,
  newUserRolloutPercent: z.number().int().min(0).max(100),
  enforcementStartedAt: CanonicalUtcTimestampSchema.nullable(),
  legacyGrandfatherEndsAt: CanonicalUtcTimestampSchema.nullable(),
  activeCatalogVersion:
    z.string().regex(CATALOG_VERSION_PATTERN),
  activeCatalogHash: DigestSchema,
  providerBindingHash: DigestSchema,
  couponPolicyHash: DigestSchema,
  copyBundleHash: DigestSchema,
  rolloutSeedId: z.string().regex(SEED_ID_PATTERN),
  rolloutPolicyHash: DigestSchema,
  cohortContinuityHash: DigestSchema,
  autoCouponRequired: z.literal(true),
  webhookProcessingEnabled: z.boolean(),
  reconciliationEnabled: z.boolean(),
  surfaces: RolloutSurfacesSchema,
}).strict()
export type BillingRolloutRequestedState = z.infer<
  typeof BillingRolloutRequestedStateSchema
>

export const BillingRolloutEvidenceArtifactSchema = z.object({
  queryId: z.enum(BILLING_ROLLOUT_QUERY_IDS),
  artifactHash: DigestSchema,
  resultStatus: z.literal('pass'),
  phaseId: z.enum(BILLING_ROLLOUT_PHASE_IDS),
  environment: z.enum(['development', 'test', 'staging', 'production']),
  providerMode: z.enum(['none', 'test', 'live']),
  deploymentId: SafeIdSchema,
  commitSha: z.string().regex(COMMIT_SHA_PATTERN),
  catalogVersion: z.string().regex(CATALOG_VERSION_PATTERN),
  catalogHash: DigestSchema,
  configSnapshotHash: DigestSchema,
  allowlistOrCohortHash: DigestSchema,
  windowStartedAt: CanonicalUtcTimestampSchema,
  windowEndedAt: CanonicalUtcTimestampSchema,
  generatedAt: CanonicalUtcTimestampSchema,
  reviewedByHandles: SortedUniqueDigestArraySchema,
}).strict().superRefine((artifact, context) => {
  const startedAt = new Date(artifact.windowStartedAt)
  const endedAt = new Date(artifact.windowEndedAt)
  const generatedAt = new Date(artifact.generatedAt)
  if (endedAt < startedAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom, path: ['windowEndedAt'],
      message: 'Evidence window must not end before it starts',
    })
  }
  if (generatedAt < endedAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom, path: ['generatedAt'],
      message: 'Evidence must be generated after its window ends',
    })
  }
})
export type BillingRolloutEvidenceArtifact =
  z.infer<typeof BillingRolloutEvidenceArtifactSchema>
export const BillingRolloutExternalReferencesSchema = z.object({
  legalApprovalRef: SafeIdSchema.nullable(),
  financeApprovalRef: SafeIdSchema.nullable(),
  securityApprovalRef: SafeIdSchema.nullable(),
  supportCoverageRef: SafeIdSchema.nullable(),
  incidentChannelRef: SafeIdSchema,
  dashboardWindowRef: SafeIdSchema,
}).strict()
export const BillingRolloutPhaseRequestCommandSchema = z.object({
  schemaVersion:
    z.literal(BILLING_ROLLOUT_PHASE_REQUEST_SCHEMA_VERSION),
  commandId: SafeIdSchema,
  correlationId: SafeIdSchema,
  phaseId: z.enum(BILLING_ROLLOUT_PHASE_IDS),
  expectedAuthorityRevision: z.number().int().min(0),
  expectedCurrentActivationSequence: z.number().int().min(0),
  expectedConfigRevision: z.number().int().min(0),
  configBeforeHash: DigestSchema,
  configAfterPreviewHash: DigestSchema,
  requestedState: BillingRolloutRequestedStateSchema,
  deploymentId: SafeIdSchema,
  commitSha: z.string().regex(COMMIT_SHA_PATTERN),
  cohortOrAllowlistHash: DigestSchema,
  evidence: z.array(BillingRolloutEvidenceArtifactSchema)
    .min(1)
    .max(BILLING_ROLLOUT_QUERY_IDS.length)
    .refine(
      (items) => items.every(
        (item, index) =>
          index === 0 ||
          items[index - 1]!.queryId < item.queryId,
      ),
      'Evidence query IDs must be unique and sorted',
    ),
  externalReferences: BillingRolloutExternalReferencesSchema,
  entryWindowUtc: z.object({
    notBefore: CanonicalUtcTimestampSchema,
    expiresAt: CanonicalUtcTimestampSchema,
  }).strict(),
  openIncidentCount: z.number().int().min(0).max(10_000),
  openP0P1IncidentCount: z.literal(0),
  openSupportCasesBySeverity: z.object({
    p0: z.literal(0),
    p1: z.literal(0),
    p2: z.number().int().min(0).max(100_000),
    p3: z.number().int().min(0).max(100_000),
  }).strict(),
  reason: z.string().trim().min(20).max(2_000),
  confirmation: z.string().min(1).max(120),
}).strict().superRefine((command, context) => {
  if (
    new Date(command.entryWindowUtc.expiresAt) <=
      new Date(command.entryWindowUtc.notBefore)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['entryWindowUtc', 'expiresAt'],
      message: 'Entry window expiry must be after its start',
    })
  }
})
export type BillingRolloutPhaseRequestCommand = z.infer<
  typeof BillingRolloutPhaseRequestCommandSchema
>
export const BillingRolloutApprovalCommandSchema = z.object({
  schemaVersion: z.literal(BILLING_ROLLOUT_APPROVAL_SCHEMA_VERSION),
  commandId: SafeIdSchema,
  correlationId: SafeIdSchema,
  requestId: SafeIdSchema,
  requestDigest: DigestSchema,
  ownerRole: z.enum(BILLING_ROLLOUT_OWNER_ROLES),
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().trim().min(20).max(2_000),
  confirmation: z.string().min(1).max(160),
}).strict()

export type BillingRolloutApprovalCommand = z.infer<
  typeof BillingRolloutApprovalCommandSchema
>
export const BillingRolloutActivationCommandSchema = z.object({
  schemaVersion: z.literal(BILLING_ROLLOUT_ACTIVATION_SCHEMA_VERSION),
  commandId: SafeIdSchema,
  correlationId: SafeIdSchema,
  requestId: DigestSchema,
  requestDigest: DigestSchema,
  expectedAuthorityRevision: z.number().int().min(0),
  confirmation: z.string().min(1).max(200),
}).strict()

export type BillingRolloutActivationCommand = z.infer<
  typeof BillingRolloutActivationCommandSchema
>

export const BillingRolloutEmergencyStopCommandSchema = z.object({
  schemaVersion:
    z.literal(BILLING_ROLLOUT_EMERGENCY_STOP_SCHEMA_VERSION),
  commandId: SafeIdSchema,
  correlationId: SafeIdSchema,
  expectedAuthorityRevision: z.number().int().min(1),
  expectedActiveActivationId: DigestSchema,
  incidentReference: SafeIdSchema,
  reason: z.string().trim().min(20).max(2_000),
  confirmation: z.string().min(1).max(160),
}).strict()

export type BillingRolloutEmergencyStopCommand = z.infer<
  typeof BillingRolloutEmergencyStopCommandSchema
>

export interface BillingRolloutActor {
  readonly userId: string
  readonly cmsRole: 'platform_admin'
}

export interface PreparedBillingRolloutRequest {
  readonly schemaVersion:
    typeof BILLING_ROLLOUT_PHASE_REQUEST_SCHEMA_VERSION
  readonly requestId: string
  readonly requestDigest: string
  readonly commandId: string
  readonly correlationId: string
  readonly phaseId: BillingRolloutPhaseId
  readonly requestCanonicalJson: string
  readonly requestedStateHash: string
  readonly evidenceBundleHash: string
  readonly requesterUserId: string
  readonly requesterCmsRole: 'platform_admin'
  readonly requiredApprovalRoles: readonly BillingRolloutOwnerRole[]
  readonly expectedAuthorityRevision: number
  readonly expectedCurrentActivationSequence: number
  readonly expectedConfigRevision: number
  readonly configBeforeHash: string
  readonly configAfterPreviewHash: string
  readonly notBefore: Date
  readonly expiresAt: Date
  readonly status: 'pending_approval'
  readonly revision: 1
  readonly createdAt: Date
}

export interface PreparedBillingRolloutApproval {
  readonly schemaVersion: typeof BILLING_ROLLOUT_APPROVAL_SCHEMA_VERSION
  readonly approvalId: string
  readonly approvalDigest: string
  readonly commandId: string
  readonly correlationId: string
  readonly requestId: string
  readonly requestDigest: string
  readonly ownerRole: BillingRolloutOwnerRole
  readonly decision: 'approved' | 'rejected'
  readonly actorUserId: string
  readonly actorCmsRole: 'platform_admin'
  readonly reason: string
  readonly recordedAt: Date
}

export interface BillingRolloutApprovalEvidence {
  readonly requestId: string
  readonly requestDigest: string
  readonly ownerRole: BillingRolloutOwnerRole
  readonly decision: 'approved' | 'rejected'
  readonly actorUserId: string
  readonly approvalDigest: string
}

export interface BillingRolloutActivationAttestation {
  readonly schemaVersion:
    typeof BILLING_ROLLOUT_ACTIVATION_SCHEMA_VERSION
  readonly activationId: string
  readonly sequence: number
  readonly authorityRevision: number
  readonly stopEpoch: number
  readonly kind: 'activated' | 'emergency_stopped'
  readonly phaseId: BillingRolloutPhaseId
  readonly requestId: string
  readonly requestDigest: string
  readonly requestedStateHash: string
  readonly configBeforeHash: string
  readonly configAfterHash: string
  readonly configRevision: number
  readonly deploymentId: string
  readonly commitSha: string
  readonly activeCatalogVersion: string
  readonly activeCatalogHash: string
  readonly providerBindingHash: string
  readonly couponPolicyHash: string
  readonly copyBundleHash: string
  readonly rolloutPolicyHash: string
  readonly cohortOrAllowlistHash: string
  readonly cohortContinuityHash: string
  readonly recoveryPreserved: boolean
  readonly activatedByUserId: string
  readonly activatedAt: Date
}

export type BillingRolloutAuthorityDecision = Readonly<{
  schemaVersion: typeof BILLING_ROLLOUT_DECISION_SCHEMA_VERSION
  enabled: boolean
  reason:
    | 'execution_gate_off'
    | 'activation_missing'
    | 'activation_stopped'
    | 'activation_mismatch'
    | 'invalid_subject'
    | 'deletion_pending'
    | 'before_entry'
    | 'qa_control'
    | 'public_control'
    | 'public_treatment'
    | 'grandfathered'
  audience: 'none' | 'qa' | 'public_control' | 'public_treatment'
  providerMode?: 'test' | 'live'
  sellingAllowed: boolean
  enforcementEnabled: boolean
  copyEnabled: boolean
  couponEnabled: boolean
  analyticsEnabled: boolean
  communicationsEnabled: boolean
  skuScope: readonly BillingRolloutSku[]
  cohortIncluded: boolean
  cohortBucket?: number
  phaseId?: BillingRolloutPhaseId
  activationId?: string
  activationSequence?: number
  authorityRevision?: number
  stopEpoch?: number
  requestDigest?: string
  requestedStateHash?: string
  catalogVersion?: string
  catalogHash?: string
  providerBindingHash?: string
  couponPolicyHash?: string
  copyBundleHash?: string
  rolloutPolicyHash?: string
  decisionDigest?: string
}>

function normalizeCanonicalValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(normalizeCanonicalValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [
        key,
        normalizeCanonicalValue(nested),
      ]),
  )
}

export function canonicalRolloutJson(value: unknown): string {
  return JSON.stringify(normalizeCanonicalValue(value))
}

export function billingRolloutDigest(value: unknown): string {
  return createHash('sha256')
    .update(canonicalRolloutJson(value))
    .digest('hex')
}

export function billingRolloutCohortContinuityHash(
  state: Pick<
    BillingRolloutRequestedState,
    | 'activeCatalogVersion'
    | 'activeCatalogHash'
    | 'rolloutSeedId'
    | 'enforcementStartedAt'
    | 'legacyGrandfatherEndsAt'
  >,
): string {
  return billingRolloutDigest({
    domain: 'billing_rollout_cohort_continuity_v1',
    algorithm: 'hmac-sha256-v1',
    authorityKeyVersion: 1,
    activeCatalogVersion: state.activeCatalogVersion,
    activeCatalogHash: state.activeCatalogHash,
    rolloutSeedId: state.rolloutSeedId,
    enforcementStartedAt: state.enforcementStartedAt,
    legacyGrandfatherEndsAt: state.legacyGrandfatherEndsAt,
  })
}

export function billingRolloutRequestedPolicyHash(
  state: BillingRolloutRequestedState,
): string {
  const policy = Object.fromEntries(
    Object.entries(state).filter(
      ([key]) => key !== 'rolloutPolicyHash',
    ),
  )
  return billingRolloutDigest({
    domain: 'billing_rollout_requested_policy_v1',
    policy,
  })
}

function sortedRoles(
  roles: readonly BillingRolloutOwnerRole[],
): readonly BillingRolloutOwnerRole[] {
  return Object.freeze([...roles].sort())
}

const ALL_OWNER_ROLES = sortedRoles(BILLING_ROLLOUT_OWNER_ROLES)
const PRODUCT_PAYMENT_SECURITY_ROLES = sortedRoles([
  'product_rollout',
  'payments_engineering',
  'security',
])
const INTERNAL_LIVE_ROLES = sortedRoles([
  'executive_launch',
  'payments_engineering',
  'finance_ca',
  'security',
  'razorpay_account',
])
const PUBLIC_PROMOTION_ROLES = sortedRoles([
  'product_rollout',
  'payments_engineering',
  'entitlement_engineering',
  'finance_ca',
  'support_communications',
  'on_call_incident',
])

export function requiredBillingRolloutApprovalRoles(
  phaseId: BillingRolloutPhaseId,
): readonly BillingRolloutOwnerRole[] {
  if (phaseId === 'phase_1_test_qa') {
    return PRODUCT_PAYMENT_SECURITY_ROLES
  }
  if (phaseId === 'phase_2_internal_live') {
    return INTERNAL_LIVE_ROLES
  }
  if (
    phaseId === 'phase_4_new_users_5' ||
    phaseId === 'phase_5_new_users_25' ||
    phaseId === 'phase_6_new_users_100'
  ) {
    return PUBLIC_PROMOTION_ROLES
  }
  return ALL_OWNER_ROLES
}

const BASE_MONEY_QUERY_IDS: readonly BillingRolloutQueryId[] = [
  'rollout_config_snapshot_v1',
  'provider_mode_binding_v1',
  'captured_without_access_v1',
  'access_without_capture_v1',
  'duplicate_charge_v1',
  'amount_snapshot_mismatch_v1',
  'missing_financial_document_v1',
  'webhook_health_v1',
  'reconciliation_divergence_v1',
  'coupon_integrity_v1',
  'refund_health_v1',
  'deletion_pending_health_v1',
]

export function requiredBillingRolloutQueryIds(
  phaseId: BillingRolloutPhaseId,
): readonly BillingRolloutQueryId[] {
  if (phaseId === 'phase_0_readiness') {
    return Object.freeze([...BILLING_ROLLOUT_QUERY_IDS].sort())
  }
  if (phaseId === 'phase_1_test_qa' || phaseId === 'phase_2_internal_live') {
    return Object.freeze([...BASE_MONEY_QUERY_IDS].sort())
  }
  if (phaseId === 'phase_3_qualified_pilot') {
    return Object.freeze([
      ...BASE_MONEY_QUERY_IDS,
      'cohort_consistency_v1',
      'cohort_leakage_v1',
      'support_billing_signal_v1',
    ].sort() as BillingRolloutQueryId[])
  }
  if (
    phaseId === 'phase_4_new_users_5' ||
    phaseId === 'phase_5_new_users_25' ||
    phaseId === 'phase_6_new_users_100'
  ) {
    return Object.freeze([
      ...BASE_MONEY_QUERY_IDS,
      'cohort_consistency_v1',
      'cohort_leakage_v1',
      'grandfather_integrity_v1',
      'grandfather_paid_overlap_v1',
      'support_billing_signal_v1',
    ].sort() as BillingRolloutQueryId[])
  }
  return Object.freeze([...BILLING_ROLLOUT_QUERY_IDS].sort())
}

function allSurfaces(
  state: BillingRolloutRequestedState,
  expected: boolean,
): boolean {
  return Object.values(state.surfaces)
    .every((surface) => surface === expected)
}

const ALL_SKUS: readonly BillingRolloutSku[] =
  Object.freeze([...BILLING_ROLLOUT_SKUS].sort())
const PREMIUM_RESUME_ONLY: readonly BillingRolloutSku[] =
  Object.freeze(['premium_resume_unlock'])

function sameSkuScope(
  actual: readonly BillingRolloutSku[],
  expected: readonly BillingRolloutSku[],
): boolean {
  return actual.length === expected.length &&
    actual.every((sku, index) => sku === expected[index])
}

function sameBooleanSurfaceState(
  state: BillingRolloutRequestedState,
  expected: {
    enforcement: boolean
    communications: boolean
  },
): boolean {
  return state.surfaces.selling &&
    state.surfaces.copy &&
    state.surfaces.analytics &&
    state.surfaces.enforcement === expected.enforcement &&
    state.surfaces.communications === expected.communications
}

export function billingRolloutPhaseStateIssues(
  phaseId: BillingRolloutPhaseId,
  state: BillingRolloutRequestedState,
): readonly string[] {
  const issues: string[] = []
  const hasStart = state.enforcementStartedAt !== null
  const hasEnd = state.legacyGrandfatherEndsAt !== null
  if (hasStart !== hasEnd) issues.push('timeline_incomplete')
  if (
    hasStart &&
    hasEnd &&
    new Date(state.legacyGrandfatherEndsAt!).getTime() -
      new Date(state.enforcementStartedAt!).getTime() !==
        THIRTY_DAYS_MS
  ) issues.push('grandfather_window_not_30_days')
  const recoveryOn =
    state.webhookProcessingEnabled &&
    state.reconciliationEnabled
  const allowlistPresent = state.allowlistCount > 0
  const allowlistExpiryPresent = state.allowlistExpiresAt !== null
  const timelinePresent = hasStart && hasEnd

  if (phaseId === 'phase_0_readiness') {
    if (
      state.providerMode !== 'none' ||
      state.sellingMode !== 'off' ||
      state.enforcementMode !== 'off' ||
      state.couponMode !== 'off' ||
      state.allowlistCount !== 0 ||
      allowlistExpiryPresent ||
      state.skuScope.length !== 0 ||
      state.newUserRolloutPercent !== 0 ||
      timelinePresent ||
      !allSurfaces(state, false)
    ) issues.push('phase_0_must_be_fully_inert')
    return Object.freeze(issues)
  }

  if (phaseId === 'phase_1_test_qa') {
    if (
      state.providerMode !== 'test' ||
      state.sellingMode !== 'qa' ||
      state.enforcementMode !== 'off' ||
      state.couponMode !== 'qa' ||
      !allowlistPresent ||
      !allowlistExpiryPresent ||
      !sameSkuScope(state.skuScope, ALL_SKUS) ||
      state.newUserRolloutPercent !== 0 ||
      timelinePresent ||
      !sameBooleanSurfaceState(state, {
        enforcement: false,
        communications: false,
      })
    ) issues.push('phase_1_state_mismatch')
  } else if (phaseId === 'phase_2_internal_live') {
    if (
      state.providerMode !== 'live' ||
      state.sellingMode !== 'qa' ||
      state.enforcementMode !== 'off' ||
      state.couponMode !== 'qa' ||
      !allowlistPresent ||
      !allowlistExpiryPresent ||
      !sameSkuScope(state.skuScope, PREMIUM_RESUME_ONLY) ||
      state.newUserRolloutPercent !== 0 ||
      timelinePresent ||
      !sameBooleanSurfaceState(state, {
        enforcement: false,
        communications: false,
      })
    ) issues.push('phase_2_state_mismatch')
  } else if (phaseId === 'phase_3_qualified_pilot') {
    if (
      state.providerMode !== 'live' ||
      state.sellingMode !== 'qa' ||
      state.enforcementMode !== 'all' ||
      state.couponMode !== 'qa' ||
      !allowlistPresent ||
      !allowlistExpiryPresent ||
      !sameSkuScope(state.skuScope, ALL_SKUS) ||
      state.newUserRolloutPercent !== 0 ||
      timelinePresent ||
      !sameBooleanSurfaceState(state, {
        enforcement: true,
        communications: true,
      })
    ) issues.push('phase_3_state_mismatch')
  } else if (
    phaseId === 'phase_4_new_users_5' ||
    phaseId === 'phase_5_new_users_25' ||
    phaseId === 'phase_6_new_users_100'
  ) {
    const expectedPercent =
      phaseId === 'phase_4_new_users_5'
        ? 5
        : phaseId === 'phase_5_new_users_25'
          ? 25
          : 100
    if (
      state.providerMode !== 'live' ||
      state.sellingMode !== 'all' ||
      state.enforcementMode !== 'new_users' ||
      state.couponMode !== 'all' ||
      state.allowlistCount !== 0 ||
      allowlistExpiryPresent ||
      !sameSkuScope(state.skuScope, ALL_SKUS) ||
      state.newUserRolloutPercent !== expectedPercent ||
      !timelinePresent ||
      !sameBooleanSurfaceState(state, {
        enforcement: true,
        communications: true,
      })
    ) issues.push('public_new_user_state_mismatch')
  } else if (phaseId === 'phase_7_existing_boundary') {
    if (
      state.providerMode !== 'live' ||
      state.sellingMode !== 'all' ||
      state.enforcementMode !== 'all' ||
      state.couponMode !== 'all' ||
      state.allowlistCount !== 0 ||
      allowlistExpiryPresent ||
      !sameSkuScope(state.skuScope, ALL_SKUS) ||
      state.newUserRolloutPercent !== 100 ||
      !timelinePresent ||
      !sameBooleanSurfaceState(state, {
        enforcement: true,
        communications: true,
      })
    ) issues.push('existing_user_boundary_state_mismatch')
  } else if (
    state.providerMode !== 'live' ||
    state.sellingMode !== 'all' ||
    state.enforcementMode !== 'all' ||
    state.couponMode !== 'all' ||
    state.allowlistCount !== 0 ||
    allowlistExpiryPresent ||
    !sameSkuScope(state.skuScope, ALL_SKUS) ||
    state.newUserRolloutPercent !== 100 ||
    !timelinePresent ||
    !sameBooleanSurfaceState(state, {
      enforcement: true,
      communications: true,
    })
  ) {
    issues.push('renewal_hold_state_mismatch')
  }

  if (!recoveryOn) issues.push('recovery_lanes_must_be_on')
  if (!state.autoCouponRequired) issues.push('automatic_coupon_required')
  return Object.freeze(issues)
}

export function prepareBillingRolloutRequest(input: {
  readonly command: BillingRolloutPhaseRequestCommand
  readonly actor: BillingRolloutActor
  readonly now: Date
}): PreparedBillingRolloutRequest {
  const command =
    BillingRolloutPhaseRequestCommandSchema.parse(input.command)
  if (!OBJECT_ID_PATTERN.test(input.actor.userId.toLowerCase())) {
    throw new Error('Rollout actor must be an authoritative user ID')
  }
  if (
    command.confirmation !==
      `REQUEST BILLING ROLLOUT ${command.phaseId}`
  ) {
    throw new Error('Exact rollout request confirmation is required')
  }
  if (
    !Number.isFinite(input.now.getTime()) ||
    input.now >= new Date(command.entryWindowUtc.expiresAt)
  ) {
    throw new Error('Rollout request entry window has expired')
  }
  const stateIssues = billingRolloutPhaseStateIssues(
    command.phaseId,
    command.requestedState,
  )
  if (stateIssues.length > 0) {
    throw new Error(
      `Rollout phase state is invalid: ${stateIssues.join(', ')}`,
    )
  }
  if (
    command.requestedState.cohortContinuityHash !==
      billingRolloutCohortContinuityHash(command.requestedState)
  ) {
    throw new Error('Cohort continuity hash is invalid')
  }
  if (
    command.requestedState.rolloutPolicyHash !==
      billingRolloutRequestedPolicyHash(command.requestedState)
  ) {
    throw new Error('Requested rollout policy hash is invalid')
  }
  if (
    command.requestedState.allowlistExpiresAt !== null &&
    command.requestedState.allowlistExpiresAt !==
      command.entryWindowUtc.expiresAt
  ) {
    throw new Error(
      'Allowlist expiry must equal the approved entry-window expiry',
    )
  }
  if (
    command.requestedState.allowlistCount > 0 &&
    command.requestedState.allowlistHash !==
      command.cohortOrAllowlistHash
  ) {
    throw new Error('Allowlist hash is not bound to the phase request')
  }
  if (
    command.requestedState.allowlistCount === 0 &&
    command.requestedState.rolloutPolicyHash !==
      command.cohortOrAllowlistHash
  ) {
    throw new Error('Cohort policy hash is not bound to the phase request')
  }
  const evidenceIds = new Set(
    command.evidence.map((artifact) => artifact.queryId),
  )
  const missingEvidence = requiredBillingRolloutQueryIds(command.phaseId)
    .filter((queryId) => !evidenceIds.has(queryId))
  if (missingEvidence.length > 0) {
    throw new Error(
      `Required rollout evidence is missing: ${missingEvidence.join(', ')}`,
    )
  }
  const firstEvidence = command.evidence[0]!
  const evidenceMismatch = command.evidence.some((artifact) =>
    artifact.environment !== firstEvidence.environment ||
      artifact.windowStartedAt !== firstEvidence.windowStartedAt ||
      artifact.windowEndedAt !== firstEvidence.windowEndedAt ||
      artifact.phaseId !== command.phaseId ||
      artifact.providerMode !== command.requestedState.providerMode ||
      artifact.deploymentId !== command.deploymentId ||
      artifact.commitSha !== command.commitSha ||
      artifact.catalogVersion !==
        command.requestedState.activeCatalogVersion ||
      artifact.catalogHash !== command.requestedState.activeCatalogHash ||
      artifact.configSnapshotHash !== command.configAfterPreviewHash ||
      artifact.allowlistOrCohortHash !== command.cohortOrAllowlistHash
  )
  if (evidenceMismatch) {
    throw new Error(
      'Rollout evidence is not bound to the requested rollout basis',
    )
  }
  if (
    command.evidence.some(
      (artifact) => new Date(artifact.generatedAt) > input.now,
    )
  ) {
    throw new Error('Rollout evidence cannot be generated in the future')
  }
  const requestCanonicalJson = canonicalRolloutJson(command)
  const requestDigest = billingRolloutDigest({
    domain: BILLING_ROLLOUT_PHASE_REQUEST_SCHEMA_VERSION,
    command,
    requesterUserId: input.actor.userId.toLowerCase(),
  })
  const requestedStateHash =
    billingRolloutDigest(command.requestedState)
  const evidenceBundleHash = billingRolloutDigest(command.evidence)
  return Object.freeze({
    schemaVersion: BILLING_ROLLOUT_PHASE_REQUEST_SCHEMA_VERSION,
    requestId: requestDigest,
    requestDigest,
    commandId: command.commandId,
    correlationId: command.correlationId,
    phaseId: command.phaseId,
    requestCanonicalJson,
    requestedStateHash,
    evidenceBundleHash,
    requesterUserId: input.actor.userId.toLowerCase(),
    requesterCmsRole: input.actor.cmsRole,
    requiredApprovalRoles:
      requiredBillingRolloutApprovalRoles(command.phaseId),
    expectedAuthorityRevision: command.expectedAuthorityRevision,
    expectedCurrentActivationSequence:
      command.expectedCurrentActivationSequence,
    expectedConfigRevision: command.expectedConfigRevision,
    configBeforeHash: command.configBeforeHash,
    configAfterPreviewHash: command.configAfterPreviewHash,
    notBefore: new Date(command.entryWindowUtc.notBefore),
    expiresAt: new Date(command.entryWindowUtc.expiresAt),
    status: 'pending_approval',
    revision: 1,
    createdAt: new Date(input.now),
  })
}

export function prepareBillingRolloutApproval(input: {
  readonly request: PreparedBillingRolloutRequest
  readonly existing: readonly BillingRolloutApprovalEvidence[]
  readonly command: BillingRolloutApprovalCommand
  readonly actor: BillingRolloutActor
  readonly now: Date
}): PreparedBillingRolloutApproval {
  const command = BillingRolloutApprovalCommandSchema.parse(input.command)
  if (!OBJECT_ID_PATTERN.test(input.actor.userId.toLowerCase())) {
    throw new Error('Rollout actor must be an authoritative user ID')
  }
  if (
    command.requestId !== input.request.requestId ||
    command.requestDigest !== input.request.requestDigest
  ) throw new Error('Approval is not bound to the exact rollout request')
  if (input.request.status !== 'pending_approval') {
    throw new Error('Rollout request is no longer pending approval')
  }
  if (
    !Number.isFinite(input.now.getTime()) ||
    input.now >= input.request.expiresAt
  ) throw new Error('Rollout approval window has expired')
  if (input.actor.userId.toLowerCase() ===
      input.request.requesterUserId) {
    throw new Error('Rollout requester cannot approve their own request')
  }
  if (!input.request.requiredApprovalRoles.includes(command.ownerRole)) {
    throw new Error('Approval role is not required for this rollout phase')
  }
  const expectedConfirmation =
    `${command.decision === 'approved' ? 'APPROVE' : 'REJECT'} ` +
    `BILLING ROLLOUT ${input.request.phaseId} ` +
    input.request.requestDigest
  if (command.confirmation !== expectedConfirmation) {
    throw new Error('Exact rollout approval confirmation is required')
  }
  const existingRole = input.existing.find(
    (approval) => approval.ownerRole === command.ownerRole,
  )
  if (existingRole) {
    throw new Error('This owner role already recorded a decision')
  }
  const approvalDigest = billingRolloutDigest({
    domain: BILLING_ROLLOUT_APPROVAL_SCHEMA_VERSION,
    command,
    actorUserId: input.actor.userId.toLowerCase(),
    actorCmsRole: input.actor.cmsRole,
  })
  return Object.freeze({
    schemaVersion: BILLING_ROLLOUT_APPROVAL_SCHEMA_VERSION,
    approvalId: approvalDigest,
    approvalDigest,
    commandId: command.commandId,
    correlationId: command.correlationId,
    requestId: command.requestId,
    requestDigest: command.requestDigest,
    ownerRole: command.ownerRole,
    decision: command.decision,
    actorUserId: input.actor.userId.toLowerCase(),
    actorCmsRole: input.actor.cmsRole,
    reason: command.reason,
    recordedAt: new Date(input.now),
  })
}

export function assertBillingRolloutActivationApproved(input: {
  readonly request: PreparedBillingRolloutRequest
  readonly approvals: readonly BillingRolloutApprovalEvidence[]
  readonly now: Date
}): void {
  if (
    !BILLING_ROLLOUT_ACTIVATABLE_PHASE_IDS.includes(
      input.request.phaseId as BillingRolloutActivatablePhaseId,
    )
  ) throw new Error('This rollout phase is evidence-only')
  if (input.now < input.request.notBefore) {
    throw new Error('Rollout entry window has not started')
  }
  if (input.now >= input.request.expiresAt) {
    throw new Error('Rollout entry window has expired')
  }
  if (
    input.approvals.some(
      (approval) =>
        approval.requestId !== input.request.requestId ||
        approval.requestDigest !== input.request.requestDigest,
    )
  ) throw new Error('Approval set contains cross-request evidence')
  if (input.approvals.some((approval) => approval.decision === 'rejected')) {
    throw new Error('Rollout request has been rejected')
  }
  const approvedRoles = new Set(
    input.approvals
      .filter((approval) => approval.decision === 'approved')
      .map((approval) => approval.ownerRole),
  )
  const missing = input.request.requiredApprovalRoles.filter(
    (role) => !approvedRoles.has(role),
  )
  if (missing.length > 0) {
    throw new Error(
      `Rollout approvals are incomplete: ${missing.join(', ')}`,
    )
  }
  if (
    input.approvals.some(
      (approval) =>
        approval.actorUserId === input.request.requesterUserId,
    )
  ) throw new Error('Requester cannot appear in the approval set')
}

function emptyDecision(
  reason: BillingRolloutAuthorityDecision['reason'],
  evidence: Partial<BillingRolloutAuthorityDecision> = {},
): BillingRolloutAuthorityDecision {
  return sealDecision({
    schemaVersion: BILLING_ROLLOUT_DECISION_SCHEMA_VERSION,
    enabled: false,
    reason,
    audience: 'none',
    sellingAllowed: false,
    enforcementEnabled: false,
    copyEnabled: false,
    couponEnabled: false,
    analyticsEnabled: false,
    communicationsEnabled: false,
    skuScope: [],
    cohortIncluded: false,
    ...evidence,
  })
}

function exactHmacKey(secretBase64: string): Buffer {
  const key = Buffer.from(secretBase64, 'base64')
  if (key.length !== 32) {
    throw new Error('Rollout authority HMAC key must contain exactly 32 bytes')
  }
  return key
}

export function billingRolloutAllowlistHash(input: {
  readonly userIds: readonly string[]
  readonly authoritySecretBase64: string
}): string {
  const userIds = [...input.userIds]
    .map((userId) => userId.toLowerCase())
    .sort()
  if (
    userIds.length > 500 ||
    userIds.some((userId) => !OBJECT_ID_PATTERN.test(userId)) ||
    userIds.some(
      (userId, index) => index > 0 && userIds[index - 1] === userId,
    )
  ) throw new Error('Rollout allowlist must contain unique user IDs')
  const subjectHashes = userIds.map((userId) =>
    billingRolloutSubjectHash({
      userId,
      authoritySecretBase64: input.authoritySecretBase64,
    }))
  return billingRolloutSubjectManifestHash(subjectHashes)
}

export function billingRolloutSubjectHash(input: {
  readonly userId: string
  readonly authoritySecretBase64: string
}): string {
  if (!OBJECT_ID_PATTERN.test(input.userId.toLowerCase())) {
    throw new Error('Rollout subject must be an authoritative user ID')
  }
  return createHmac('sha256', exactHmacKey(input.authoritySecretBase64))
    .update(`billing_rollout_subject_hmac_v1:${input.userId.toLowerCase()}`)
    .digest('hex')
}

export function billingRolloutSubjectManifestHash(
  subjectHashes: readonly string[],
): string {
  const sorted = [...subjectHashes].sort()
  if (
    sorted.length > 500 ||
    sorted.some((value) => !DIGEST_PATTERN.test(value)) ||
    sorted.some((value, index) => index > 0 && sorted[index - 1] === value)
  ) throw new Error('Rollout subject hashes must be unique digests')
  return billingRolloutDigest({
    domain: 'billing_rollout_subject_manifest_v1',
    subjectHashes: sorted,
  })
}

function rolloutBucket(input: {
  readonly userId: string
  readonly catalogVersion: string
  readonly rolloutSeedId: string
  readonly cohortSecretBase64: string
}): number {
  const digest = createHmac(
    'sha256',
    exactHmacKey(input.cohortSecretBase64),
  )
    .update(canonicalRolloutJson({
      domain: 'billing_rollout_cohort_hmac_v1',
      userId: input.userId.toLowerCase(),
      catalogVersion: input.catalogVersion,
      rolloutSeedId: input.rolloutSeedId,
    }))
    .digest('hex')
  return Number.parseInt(digest.slice(0, 12), 16) % 10_000
}

function sealDecision(
  value: Omit<BillingRolloutAuthorityDecision, 'decisionDigest'>,
): BillingRolloutAuthorityDecision {
  const decisionDigest = billingRolloutDigest({
    domain: BILLING_ROLLOUT_DECISION_SCHEMA_VERSION,
    decision: value,
  })
  return Object.freeze({ ...value, decisionDigest })
}

export function evaluateBillingRolloutAuthority(input: {
  readonly executionReady: boolean
  readonly activation?: BillingRolloutActivationAttestation
  readonly request?: BillingRolloutPhaseRequestCommand
  readonly currentConfigRevision: number
  readonly currentConfigHash: string
  readonly currentCatalogVersion: string
  readonly currentCatalogHash: string
  readonly currentRolloutPolicyHash: string
  readonly currentAllowlistSubjectHashes: readonly string[]
  readonly userId: string
  readonly userCreatedAt?: Date
  readonly buyerState?: string
  readonly now: Date
  readonly cohortSecretBase64?: string
}): BillingRolloutAuthorityDecision {
  if (!input.executionReady) return emptyDecision('execution_gate_off')
  if (!input.activation || !input.request) {
    return emptyDecision('activation_missing')
  }
  const activation = input.activation
  if (activation.kind === 'emergency_stopped') {
    return emptyDecision('activation_stopped', {
      phaseId: activation.phaseId,
      activationSequence: activation.sequence,
      requestDigest: activation.requestDigest,
      requestedStateHash: activation.requestedStateHash,
    })
  }
  const parsed = BillingRolloutPhaseRequestCommandSchema.safeParse(
    input.request,
  )
  if (
    !parsed.success ||
    parsed.data.phaseId !== activation.phaseId ||
    billingRolloutDigest(parsed.data.requestedState) !==
      activation.requestedStateHash ||
    parsed.data.configBeforeHash !== activation.configBeforeHash ||
    parsed.data.configAfterPreviewHash !== activation.configAfterHash ||
    parsed.data.deploymentId !== activation.deploymentId ||
    parsed.data.commitSha !== activation.commitSha ||
    parsed.data.cohortOrAllowlistHash !==
      activation.cohortOrAllowlistHash ||
    parsed.data.requestedState.activeCatalogVersion !==
      activation.activeCatalogVersion ||
    parsed.data.requestedState.activeCatalogHash !==
      activation.activeCatalogHash ||
    parsed.data.requestedState.providerBindingHash !==
      activation.providerBindingHash ||
    parsed.data.requestedState.couponPolicyHash !==
      activation.couponPolicyHash ||
    parsed.data.requestedState.copyBundleHash !==
      activation.copyBundleHash ||
    parsed.data.requestedState.rolloutPolicyHash !==
      activation.rolloutPolicyHash ||
    parsed.data.requestedState.cohortContinuityHash !==
      activation.cohortContinuityHash ||
    activation.configRevision !== input.currentConfigRevision ||
    activation.configAfterHash !== input.currentConfigHash ||
    activation.activeCatalogVersion !== input.currentCatalogVersion ||
    activation.activeCatalogHash !== input.currentCatalogHash ||
    activation.rolloutPolicyHash !== input.currentRolloutPolicyHash
  ) {
    return emptyDecision('activation_mismatch', {
      phaseId: activation.phaseId,
      activationSequence: activation.sequence,
      requestDigest: activation.requestDigest,
      requestedStateHash: activation.requestedStateHash,
    })
  }
  const state = parsed.data.requestedState
  const evidence = {
    enabled: true,
    phaseId: activation.phaseId,
    activationId: activation.activationId,
    activationSequence: activation.sequence,
    authorityRevision: activation.authorityRevision,
    stopEpoch: activation.stopEpoch,
    requestDigest: activation.requestDigest,
    requestedStateHash: activation.requestedStateHash,
    catalogVersion: activation.activeCatalogVersion,
    catalogHash: activation.activeCatalogHash,
    providerBindingHash: activation.providerBindingHash,
    couponPolicyHash: activation.couponPolicyHash,
    copyBundleHash: activation.copyBundleHash,
    rolloutPolicyHash: activation.rolloutPolicyHash,
  } as const
  if (
    !OBJECT_ID_PATTERN.test(input.userId.toLowerCase()) ||
    !Number.isFinite(input.now.getTime())
  ) return emptyDecision('invalid_subject', evidence)
  if (input.buyerState === 'deletion_pending') {
    return emptyDecision('deletion_pending', evidence)
  }
  if (input.now < new Date(parsed.data.entryWindowUtc.notBefore)) {
    return emptyDecision('before_entry', evidence)
  }

  const exactAllowlist = [...input.currentAllowlistSubjectHashes].sort()
  let currentAllowlistHash: string
  try {
    currentAllowlistHash =
      billingRolloutSubjectManifestHash(exactAllowlist)
  } catch {
    return emptyDecision('activation_mismatch', evidence)
  }
  if (
    exactAllowlist.length !== state.allowlistCount ||
    currentAllowlistHash !== state.allowlistHash
  ) return emptyDecision('activation_mismatch', evidence)

  const allowlistPhase =
    activation.phaseId === 'phase_1_test_qa' ||
    activation.phaseId === 'phase_2_internal_live' ||
    activation.phaseId === 'phase_3_qualified_pilot'
  if (allowlistPhase) {
    if (
      !state.allowlistExpiresAt ||
      input.now >= new Date(state.allowlistExpiresAt)
    ) return emptyDecision('activation_stopped', evidence)
    let subjectHash: string
    try {
      subjectHash = billingRolloutSubjectHash({
        userId: input.userId,
        authoritySecretBase64: input.cohortSecretBase64 ?? '',
      })
    } catch {
      return emptyDecision('activation_mismatch', evidence)
    }
    if (!exactAllowlist.includes(subjectHash)) {
      return emptyDecision('qa_control', {
        ...evidence,
        audience: 'public_control',
      })
    }
    return sealDecision({
      schemaVersion: BILLING_ROLLOUT_DECISION_SCHEMA_VERSION,
      ...evidence,
      reason: 'public_treatment',
      audience: 'qa',
      providerMode:
        state.providerMode === 'test' ? 'test' : 'live',
      sellingAllowed: state.surfaces.selling,
      enforcementEnabled:
        state.surfaces.enforcement &&
        state.enforcementMode !== 'off' &&
        state.enforcementMode !== 'shadow',
      copyEnabled: state.surfaces.copy,
      couponEnabled: state.couponMode !== 'off',
      analyticsEnabled: state.surfaces.analytics,
      communicationsEnabled: state.surfaces.communications,
      skuScope: state.skuScope,
      cohortIncluded: true,
    })
  }

  const startedAt = state.enforcementStartedAt
    ? new Date(state.enforcementStartedAt)
    : undefined
  const grandfatherEndsAt = state.legacyGrandfatherEndsAt
    ? new Date(state.legacyGrandfatherEndsAt)
    : undefined
  if (
    !input.userCreatedAt ||
    !Number.isFinite(input.userCreatedAt.getTime()) ||
    !startedAt ||
    !grandfatherEndsAt ||
    input.userCreatedAt > input.now
  ) return emptyDecision('invalid_subject', evidence)
  if (input.now < startedAt) {
    return emptyDecision('before_entry', evidence)
  }

  const existingUser = input.userCreatedAt < startedAt
  if (
    existingUser &&
    (
      activation.phaseId !== 'phase_7_existing_boundary' ||
      input.now < grandfatherEndsAt
    )
  ) {
    return emptyDecision('grandfathered', {
      ...evidence,
      audience: 'public_control',
    })
  }
  if (!input.cohortSecretBase64) {
    return emptyDecision('activation_mismatch', evidence)
  }
  let cohortBucket: number
  try {
    cohortBucket = rolloutBucket({
      userId: input.userId,
      catalogVersion: state.activeCatalogVersion,
      rolloutSeedId: state.rolloutSeedId,
      cohortSecretBase64: input.cohortSecretBase64,
    })
  } catch {
    return emptyDecision('activation_mismatch', evidence)
  }
  const cohortIncluded =
    cohortBucket < state.newUserRolloutPercent * 100
  if (!cohortIncluded) {
    return emptyDecision('public_control', {
      ...evidence,
      audience: 'public_control',
      cohortBucket,
    })
  }
  return sealDecision({
    schemaVersion: BILLING_ROLLOUT_DECISION_SCHEMA_VERSION,
    ...evidence,
    reason: 'public_treatment',
    audience: 'public_treatment',
    providerMode: 'live',
    sellingAllowed: state.surfaces.selling,
    enforcementEnabled: state.surfaces.enforcement,
    copyEnabled: state.surfaces.copy,
    couponEnabled: state.couponMode === 'all',
    analyticsEnabled: state.surfaces.analytics,
    communicationsEnabled: state.surfaces.communications,
    skuScope: state.skuScope,
    cohortIncluded: true,
    cohortBucket,
  })
}
