import { z } from 'zod'

export const SUBSCRIPTION_DUNNING_OBSERVATION_SCHEMA_VERSION =
  'payment_subscription_dunning_observation_v1' as const
export const SUBSCRIPTION_DUNNING_CASE_SCHEMA_VERSION =
  'payment_subscription_dunning_case_v1' as const
export const SUBSCRIPTION_DUNNING_EVENT_SCHEMA_VERSION =
  'payment_subscription_dunning_event_v1' as const
export const SUBSCRIPTION_DUNNING_PROVISIONAL_GRANT_SCHEMA_VERSION =
  'payment_subscription_dunning_provisional_grant_v1' as const
export const SUBSCRIPTION_DUNNING_PROVISIONAL_COMMAND_SCHEMA_VERSION =
  'payment_subscription_dunning_provisional_command_v1' as const
export const SUBSCRIPTION_DUNNING_POLICY_VERSION =
  'subscription_dunning_policy_v1' as const

export const SUBSCRIPTION_DUNNING_MAX_GRACE_MS =
  72 * 60 * 60 * 1_000
export const SUBSCRIPTION_DUNNING_PROVISIONAL_RESERVATION_MAX_MS =
  30 * 60 * 1_000
export const SUBSCRIPTION_DUNNING_SCAN_PAGE_SIZE = 25 as const
export const SUBSCRIPTION_DUNNING_SCAN_MAX_PAGES = 4 as const

export const SUBSCRIPTION_DUNNING_PROVIDER_MODES = [
  'test',
  'live',
] as const
export type SubscriptionDunningProviderMode =
  (typeof SUBSCRIPTION_DUNNING_PROVIDER_MODES)[number]

export const SUBSCRIPTION_DUNNING_PROVIDER_STATUSES = [
  'created',
  'authenticated',
  'activation_pending',
  'active',
  'pending',
  'halted',
  'paused',
  'cancelled',
  'completed',
  'expired',
  'review',
] as const
export type SubscriptionDunningProviderStatus =
  (typeof SUBSCRIPTION_DUNNING_PROVIDER_STATUSES)[number]

export const SUBSCRIPTION_DUNNING_CLOCK_AUTHORITIES = [
  'authoritative',
  'legacy_unknown',
] as const
export type SubscriptionDunningClockAuthority =
  (typeof SUBSCRIPTION_DUNNING_CLOCK_AUTHORITIES)[number]

export const SUBSCRIPTION_DUNNING_ACCESS_OVERRIDES = [
  'none',
  'admin_grant',
  'replacement_paid_cycle',
  'deletion_pending',
] as const
export type SubscriptionDunningAccessOverride =
  (typeof SUBSCRIPTION_DUNNING_ACCESS_OVERRIDES)[number]

export const SUBSCRIPTION_DUNNING_CLASSIFICATIONS = [
  'paid_period',
  'pending_grace_candidate',
  'pending_fallback_due',
  'halted_fallback_due',
  'paused_action_required',
  'recovered',
  'terminal_fallback_due',
  'review',
  'not_applicable',
] as const
export type SubscriptionDunningClassification =
  (typeof SUBSCRIPTION_DUNNING_CLASSIFICATIONS)[number]

export const SUBSCRIPTION_DUNNING_REASON_CODES = [
  'active_without_renewal_capture',
  'admin_authority_active',
  'activation_state_with_paid_period',
  'deletion_pending',
  'halted_after_paid_period',
  'halted_during_paid_period',
  'legacy_clock_unknown',
  'mandate_paused_after_paid_period',
  'mandate_paused_during_paid_period',
  'pending_clock_missing',
  'pending_grace_active',
  'pending_grace_expired',
  'pending_during_paid_period',
  'provider_state_review',
  'remote_retrying_unconfirmed',
  'renewal_cycle_captured',
  'replacement_paid_cycle_active',
  'terminal_after_paid_period',
  'terminal_during_paid_period',
] as const
export type SubscriptionDunningReasonCode =
  (typeof SUBSCRIPTION_DUNNING_REASON_CODES)[number]

export const SUBSCRIPTION_DUNNING_PROVISIONAL_STATES = [
  'not_offered',
  'available',
  'reserved',
  'consumed',
  'revoked',
  'counted_against_cycle',
  'tracked_goodwill',
  'review',
] as const
export type SubscriptionDunningProvisionalState =
  (typeof SUBSCRIPTION_DUNNING_PROVISIONAL_STATES)[number]

export const SUBSCRIPTION_DUNNING_PROVISIONAL_GRANT_STATES = [
  'available',
  'reserved',
  'consumed',
  'revoked',
  'counted_against_cycle',
  'tracked_goodwill',
] as const
export type SubscriptionDunningProvisionalGrantState =
  (typeof SUBSCRIPTION_DUNNING_PROVISIONAL_GRANT_STATES)[number]

export const SUBSCRIPTION_DUNNING_PROVISIONAL_TERMINAL_OUTCOMES = [
  'revoked',
  'counted_against_cycle',
  'tracked_goodwill',
] as const
export type SubscriptionDunningProvisionalTerminalOutcome =
  (typeof SUBSCRIPTION_DUNNING_PROVISIONAL_TERMINAL_OUTCOMES)[number]

export const SUBSCRIPTION_DUNNING_EVENT_KINDS = [
  'created',
  'transitioned',
  'reviewed',
  'recovered',
  'provisional_grant_offered',
  'provisional_grant_reserved',
  'provisional_grant_consumed',
  'provisional_grant_revoked',
  'provisional_goodwill_tracked',
  'provisional_grant_captured',
] as const
export type SubscriptionDunningEventKind =
  (typeof SUBSCRIPTION_DUNNING_EVENT_KINDS)[number]

const OBJECT_ID = /^[a-f0-9]{24}$/
const DIGEST = /^[a-f0-9]{64}$/
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

export const SubscriptionDunningObjectIdSchema =
  z.string().regex(OBJECT_ID)
export const SubscriptionDunningDigestSchema =
  z.string().regex(DIGEST)
export const SubscriptionDunningCanonicalTimestampSchema =
  z.string().datetime({
    offset: false,
    precision: 3,
  }).refine(
    (value) => new Date(value).toISOString() === value,
    'Timestamp must be canonical UTC',
  )

const PeriodKeySchema = z.string()
  .min(1)
  .max(255)
  .refine(
    (value) => value === value.trim() && !CONTROL.test(value),
    'Period key must be a bounded canonical token',
  )

export interface SubscriptionDunningCapturedTargetCycle {
  readonly cycleId: string
  readonly subscriptionId: string
  readonly paidPeriodKey: string
  readonly capturedAt: string
  readonly evidenceDigest: string
}

export const SubscriptionDunningCapturedTargetCycleSchema = z.object({
  cycleId: SubscriptionDunningObjectIdSchema,
  subscriptionId: SubscriptionDunningObjectIdSchema,
  paidPeriodKey: PeriodKeySchema,
  capturedAt: SubscriptionDunningCanonicalTimestampSchema,
  evidenceDigest: SubscriptionDunningDigestSchema,
}).strict()

export interface SubscriptionDunningProvisionalGrant {
  readonly schemaVersion:
    typeof SUBSCRIPTION_DUNNING_PROVISIONAL_GRANT_SCHEMA_VERSION
  readonly grantId: string
  readonly revision: number
  readonly state: SubscriptionDunningProvisionalGrantState
  readonly originStatusVersion: number
  readonly lastStatusVersion: number
  readonly offeredAt: string
  readonly reservedSessionId: string | null
  readonly usageReferenceId: string | null
  readonly reservedAt: string | null
  readonly consumedAt: string | null
  readonly terminalOutcome:
    SubscriptionDunningProvisionalTerminalOutcome | null
  readonly finalizedAt: string | null
  readonly capturedTargetCycle:
    SubscriptionDunningCapturedTargetCycle | null
  readonly offerEvidenceDigest: string
  readonly lastEvidenceDigest: string
  readonly lastCommandDigest: string
  readonly grantDigest: string
}

export const SubscriptionDunningProvisionalGrantSchema = z.object({
  schemaVersion: z.literal(
    SUBSCRIPTION_DUNNING_PROVISIONAL_GRANT_SCHEMA_VERSION,
  ),
  grantId: SubscriptionDunningObjectIdSchema,
  revision: z.number().int().positive().safe(),
  state: z.enum(SUBSCRIPTION_DUNNING_PROVISIONAL_GRANT_STATES),
  originStatusVersion: z.number().int().nonnegative().safe(),
  lastStatusVersion: z.number().int().nonnegative().safe(),
  offeredAt: SubscriptionDunningCanonicalTimestampSchema,
  reservedSessionId: SubscriptionDunningObjectIdSchema.nullable(),
  usageReferenceId: SubscriptionDunningObjectIdSchema.nullable(),
  reservedAt: SubscriptionDunningCanonicalTimestampSchema.nullable(),
  consumedAt: SubscriptionDunningCanonicalTimestampSchema.nullable(),
  terminalOutcome: z.enum(
    SUBSCRIPTION_DUNNING_PROVISIONAL_TERMINAL_OUTCOMES,
  ).nullable(),
  finalizedAt: SubscriptionDunningCanonicalTimestampSchema.nullable(),
  capturedTargetCycle:
    SubscriptionDunningCapturedTargetCycleSchema.nullable(),
  offerEvidenceDigest: SubscriptionDunningDigestSchema,
  lastEvidenceDigest: SubscriptionDunningDigestSchema,
  lastCommandDigest: SubscriptionDunningDigestSchema,
  grantDigest: SubscriptionDunningDigestSchema,
}).strict().superRefine((grant, context) => {
  const reserved =
    grant.reservedSessionId !== null &&
    grant.reservedAt !== null
  const consumed =
    grant.usageReferenceId !== null &&
    grant.consumedAt !== null
  const terminal =
    grant.terminalOutcome !== null &&
    grant.finalizedAt !== null
  if (
    (grant.reservedSessionId === null) !==
      (grant.reservedAt === null) ||
    (grant.usageReferenceId === null) !==
      (grant.consumedAt === null) ||
    (grant.terminalOutcome === null) !==
      (grant.finalizedAt === null) ||
    (consumed && !reserved)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['state'],
      message: 'Grant lifecycle evidence must be complete',
    })
  }
  if (
    grant.lastStatusVersion < grant.originStatusVersion ||
    (
      grant.reservedAt !== null &&
      new Date(grant.reservedAt) < new Date(grant.offeredAt)
    ) ||
    (
      grant.consumedAt !== null &&
      (
        grant.reservedAt === null ||
        new Date(grant.consumedAt) < new Date(grant.reservedAt)
      )
    ) ||
    (
      grant.finalizedAt !== null &&
      (
        new Date(grant.finalizedAt) < new Date(grant.offeredAt) ||
        (
          grant.reservedAt !== null &&
          new Date(grant.finalizedAt) <
            new Date(grant.reservedAt)
        ) ||
        (
          grant.consumedAt !== null &&
          new Date(grant.finalizedAt) <
            new Date(grant.consumedAt)
        )
      )
    ) ||
    (
      grant.capturedTargetCycle !== null &&
      (
        grant.finalizedAt === null ||
        new Date(grant.capturedTargetCycle.capturedAt) >
          new Date(grant.finalizedAt)
      )
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['state'],
      message: 'Grant lifecycle clocks must be monotonic',
    })
  }
  const valid =
    (
      grant.state === 'available' &&
      grant.revision === 1 &&
      grant.offerEvidenceDigest === grant.lastEvidenceDigest &&
      !reserved &&
      !consumed &&
      !terminal &&
      grant.capturedTargetCycle === null
    ) ||
    (
      grant.state === 'reserved' &&
      grant.revision >= 2 &&
      reserved &&
      !consumed &&
      !terminal &&
      grant.capturedTargetCycle === null
    ) ||
    (
      grant.state === 'consumed' &&
      grant.revision >= 3 &&
      reserved &&
      consumed &&
      !terminal &&
      grant.capturedTargetCycle === null
    ) ||
    (
      grant.state === 'revoked' &&
      grant.revision >= 2 &&
      !consumed &&
      terminal &&
      grant.terminalOutcome === 'revoked' &&
      grant.capturedTargetCycle === null
    ) ||
    (
      grant.state === 'tracked_goodwill' &&
      grant.revision >= 4 &&
      reserved &&
      consumed &&
      terminal &&
      grant.terminalOutcome === 'tracked_goodwill' &&
      grant.capturedTargetCycle === null
    ) ||
    (
      grant.state === 'counted_against_cycle' &&
      grant.revision >= 4 &&
      reserved &&
      consumed &&
      terminal &&
      grant.terminalOutcome === 'counted_against_cycle' &&
      grant.capturedTargetCycle !== null
    )
  if (!valid) {
    context.addIssue({
      code: 'custom',
      path: ['state'],
      message: 'Grant state does not match its sole authority evidence',
    })
  }
})

export function provisionalInterviewStateFromGrant(
  grant: SubscriptionDunningProvisionalGrant | null,
): SubscriptionDunningProvisionalState {
  return grant?.state ?? 'not_offered'
}

const ProvisionalCommandCommon = {
  schemaVersion: z.literal(
    SUBSCRIPTION_DUNNING_PROVISIONAL_COMMAND_SCHEMA_VERSION,
  ),
  providerMode: z.enum(SUBSCRIPTION_DUNNING_PROVIDER_MODES),
  subscriptionId: SubscriptionDunningObjectIdSchema,
  paidPeriodKey: PeriodKeySchema,
  caseId: SubscriptionDunningObjectIdSchema,
  expectedCaseRevision: z.number().int().positive().safe(),
  expectedStatusVersion: z.number().int().nonnegative().safe(),
  grantId: SubscriptionDunningObjectIdSchema,
  expectedGrantRevision: z.number().int().nonnegative().safe(),
  occurredAt: SubscriptionDunningCanonicalTimestampSchema,
  evidenceDigest: SubscriptionDunningDigestSchema,
} as const

export const SubscriptionDunningProvisionalGrantCommandSchema =
  z.discriminatedUnion('operation', [
    z.object({
      ...ProvisionalCommandCommon,
      operation: z.literal('offer'),
      expectedGrantRevision: z.literal(0),
    }).strict(),
    z.object({
      ...ProvisionalCommandCommon,
      operation: z.literal('reserve'),
      reservedSessionId: SubscriptionDunningObjectIdSchema,
    }).strict(),
    z.object({
      ...ProvisionalCommandCommon,
      operation: z.literal('consume'),
      reservedSessionId: SubscriptionDunningObjectIdSchema,
      usageReferenceId: SubscriptionDunningObjectIdSchema,
    }).strict(),
    z.object({
      ...ProvisionalCommandCommon,
      operation: z.literal('finalize_uncaptured_expiry'),
    }).strict(),
    z.object({
      ...ProvisionalCommandCommon,
      operation: z.literal('finalize_captured_renewal'),
      targetCycle: SubscriptionDunningCapturedTargetCycleSchema,
    }).strict(),
  ])
export type SubscriptionDunningProvisionalGrantCommand =
  z.infer<
    typeof SubscriptionDunningProvisionalGrantCommandSchema
  >

export const SubscriptionDunningPaidPeriodSchema = z.object({
  key: PeriodKeySchema,
  start: SubscriptionDunningCanonicalTimestampSchema,
  end: SubscriptionDunningCanonicalTimestampSchema,
}).strict().superRefine((period, context) => {
  if (new Date(period.end) <= new Date(period.start)) {
    context.addIssue({
      code: 'custom',
      path: ['end'],
      message: 'Paid period end must follow its start',
    })
  }
})
export type SubscriptionDunningPaidPeriod =
  z.infer<typeof SubscriptionDunningPaidPeriodSchema>

export const SubscriptionDunningObservationSchema = z.object({
  schemaVersion: z.literal(
    SUBSCRIPTION_DUNNING_OBSERVATION_SCHEMA_VERSION,
  ),
  providerMode: z.enum(SUBSCRIPTION_DUNNING_PROVIDER_MODES),
  subscriptionId: SubscriptionDunningObjectIdSchema,
  userId: SubscriptionDunningObjectIdSchema,
  providerStatus: z.enum(SUBSCRIPTION_DUNNING_PROVIDER_STATUSES),
  statusVersion: z.number().int().nonnegative().safe().nullable(),
  clockAuthority: z.enum(SUBSCRIPTION_DUNNING_CLOCK_AUTHORITIES),
  statusObservedAt: SubscriptionDunningCanonicalTimestampSchema,
  firstPendingObservedAt:
    SubscriptionDunningCanonicalTimestampSchema.nullable(),
  remoteRetryingConfirmed: z.boolean(),
  renewalCycleCaptured: z.boolean(),
  accessOverride: z.enum(SUBSCRIPTION_DUNNING_ACCESS_OVERRIDES),
  paidPeriod: SubscriptionDunningPaidPeriodSchema,
  sourceEvidenceDigest: SubscriptionDunningDigestSchema,
}).strict().superRefine((observation, context) => {
  const authoritative =
    observation.clockAuthority === 'authoritative'
  if (authoritative !== (observation.statusVersion !== null)) {
    context.addIssue({
      code: 'custom',
      path: ['statusVersion'],
      message:
        'Only authoritative observations carry a status version',
    })
  }
  if (
    observation.clockAuthority === 'legacy_unknown' &&
    (
      observation.firstPendingObservedAt !== null ||
      observation.remoteRetryingConfirmed ||
      observation.renewalCycleCaptured
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['clockAuthority'],
      message:
        'Legacy observations cannot assert clock, retry, or capture authority',
    })
  }
  if (
    observation.remoteRetryingConfirmed &&
    observation.providerStatus !== 'pending'
  ) {
    context.addIssue({
      code: 'custom',
      path: ['remoteRetryingConfirmed'],
      message: 'Retry authority is valid only for pending state',
    })
  }
  if (
    observation.renewalCycleCaptured &&
    observation.providerStatus !== 'active'
  ) {
    context.addIssue({
      code: 'custom',
      path: ['renewalCycleCaptured'],
      message: 'Renewal capture authority requires active state',
    })
  }
  if (
    observation.firstPendingObservedAt !== null &&
    new Date(observation.firstPendingObservedAt) >
      new Date(observation.statusObservedAt)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['firstPendingObservedAt'],
      message:
        'First pending observation cannot follow the status observation',
    })
  }
  if (
    new Date(observation.statusObservedAt) <
      new Date(observation.paidPeriod.start) ||
    (
      observation.firstPendingObservedAt !== null &&
      new Date(observation.firstPendingObservedAt) <
        new Date(observation.paidPeriod.start)
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['statusObservedAt'],
      message:
        'Dunning observations cannot predate their paid period',
    })
  }
})
export type SubscriptionDunningObservation =
  z.infer<typeof SubscriptionDunningObservationSchema>

export interface SubscriptionDunningPolicyDecision {
  readonly policyVersion:
    typeof SUBSCRIPTION_DUNNING_POLICY_VERSION
  readonly classification: SubscriptionDunningClassification
  readonly reason: SubscriptionDunningReasonCode
  readonly configuredGraceMs: number
  readonly paidAccessEndsAt: Date
  readonly graceEndsAt: Date | null
  readonly nextActionAt: Date | null
  readonly provisionalInterviewState:
    SubscriptionDunningProvisionalState
}

export interface SubscriptionDunningCaseIdentity {
  readonly providerMode: SubscriptionDunningProviderMode
  readonly subscriptionId: string
  readonly paidPeriodKey: string
}

export interface StoredSubscriptionDunningCase
  extends SubscriptionDunningCaseIdentity {
  readonly id: string
  readonly schemaVersion:
    typeof SUBSCRIPTION_DUNNING_CASE_SCHEMA_VERSION
  readonly policyVersion:
    typeof SUBSCRIPTION_DUNNING_POLICY_VERSION
  readonly userId: string
  readonly paidPeriodStart: string
  readonly paidPeriodEnd: string
  readonly providerStatus: SubscriptionDunningProviderStatus
  readonly statusVersion: number | null
  readonly clockAuthority: SubscriptionDunningClockAuthority
  readonly statusObservedAt: string
  readonly firstPendingObservedAt: string | null
  readonly remoteRetryingConfirmed: boolean
  readonly renewalCycleCaptured: boolean
  readonly accessOverride: SubscriptionDunningAccessOverride
  readonly sourceEvidenceDigest: string
  readonly classification: SubscriptionDunningClassification
  readonly reason: SubscriptionDunningReasonCode
  readonly configuredGraceMs: number
  readonly graceEndsAt: string | null
  readonly nextActionAt: string | null
  readonly provisionalInterviewState:
    SubscriptionDunningProvisionalState
  readonly provisionalGrant:
    SubscriptionDunningProvisionalGrant | null
  readonly revision: number
  readonly lastEventSequence: number
  readonly decisionDigest: string
}

export interface SubscriptionDunningCaseDraft
  extends Omit<
    StoredSubscriptionDunningCase,
    'id' | 'revision' | 'lastEventSequence'
  > {
  readonly revision: 1
  readonly lastEventSequence: 1
}

export interface SubscriptionDunningCaseUpdate
  extends Omit<StoredSubscriptionDunningCase, 'id'> {}

export interface SubscriptionDunningEventDraft {
  readonly schemaVersion:
    typeof SUBSCRIPTION_DUNNING_EVENT_SCHEMA_VERSION
  readonly policyVersion:
    typeof SUBSCRIPTION_DUNNING_POLICY_VERSION
  readonly caseId: string
  readonly sequence: number
  readonly kind: SubscriptionDunningEventKind
  readonly providerMode: SubscriptionDunningProviderMode
  readonly providerStatus: SubscriptionDunningProviderStatus
  readonly statusVersion: number | null
  readonly priorClassification:
    SubscriptionDunningClassification | null
  readonly classification: SubscriptionDunningClassification
  readonly reason: SubscriptionDunningReasonCode
  readonly occurredAt: string
  readonly sourceEvidenceDigest: string
  readonly decisionDigest: string
  readonly eventDigest: string
}

export interface SubscriptionDunningDueCandidate {
  readonly caseId: string
  readonly providerMode: SubscriptionDunningProviderMode
  readonly revision: number
  readonly nextActionAt: string
}

export const SubscriptionDunningDueCandidateSchema = z.object({
  caseId: SubscriptionDunningObjectIdSchema,
  providerMode: z.enum(SUBSCRIPTION_DUNNING_PROVIDER_MODES),
  revision: z.number().int().positive().safe(),
  nextActionAt: SubscriptionDunningCanonicalTimestampSchema,
}).strict()

export const SubscriptionDunningScanCursorSchema = z.object({
  nextActionAt: SubscriptionDunningCanonicalTimestampSchema,
  caseId: SubscriptionDunningObjectIdSchema,
}).strict()
export type SubscriptionDunningScanCursor =
  z.infer<typeof SubscriptionDunningScanCursorSchema>

export const SubscriptionDunningScanInputSchema = z.object({
  providerMode: z.enum(SUBSCRIPTION_DUNNING_PROVIDER_MODES),
  asOf: SubscriptionDunningCanonicalTimestampSchema,
  cursor: SubscriptionDunningScanCursorSchema.optional(),
}).strict()
export type SubscriptionDunningScanInput =
  z.infer<typeof SubscriptionDunningScanInputSchema>
