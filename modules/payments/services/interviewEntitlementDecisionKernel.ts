import {
  CONSUMER_CATALOG_V1,
  SUPPORTED_INTERVIEW_DURATIONS_MINUTES,
  type SupportedInterviewDurationMinutes,
} from '@shared/services/planConfig'
import type { ProviderMode } from '../types/catalog'
import { basicCalendarMonthPeriod } from './periodKeyService'

const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/
const INTERVIEW_TYPE_PATTERN =
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DAY_MS = 24 * 60 * 60 * 1_000

export const INTERVIEW_ENTITLEMENT_DECISION_SCHEMA_VERSION =
  2 as const
export const INTERVIEW_ENTITLEMENT_DECISION_POLICY_VERSION =
  'pr8-interview-entitlement-decision-v2' as const
export const LEGACY_INTERVIEW_ENTITLEMENT_DECISION_SCHEMA_VERSION =
  1 as const
export const LEGACY_INTERVIEW_ENTITLEMENT_DECISION_POLICY_VERSION =
  'pr8-interview-entitlement-decision-v1' as const
export const MAX_INTERVIEW_ENTITLEMENT_UNLOCK_CANDIDATES =
  100 as const
export const MAX_ADMIN_INTERVIEW_GRANT_CANDIDATES = 100 as const

export const INTERVIEW_ENTITLEMENT_DECISION_ERROR_CODES = [
  'invalid_configuration',
  'invalid_authority',
] as const
export type InterviewEntitlementDecisionErrorCode =
  (typeof INTERVIEW_ENTITLEMENT_DECISION_ERROR_CODES)[number]

export class InterviewEntitlementDecisionError extends Error {
  constructor(
    readonly code: InterviewEntitlementDecisionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'InterviewEntitlementDecisionError'
  }
}

export interface RequestedInterviewConfiguration {
  interviewType: string
  interviewTypeSupported: boolean
  durationMinutes: unknown
}

export interface NormalizedInterviewConfiguration {
  interviewType: string
  durationMinutes: SupportedInterviewDurationMinutes
  durationSeconds: 600 | 1200 | 1800
}

export interface BasicCalendarMonthAuthority {
  kind: 'basic_calendar_month'
  activePaidCycleState: 'none'
  entitlementSource: 'free'
  usagePeriodKey: string
  interviewsUsed: number
  interviewLimit: 1
  usageResetAt: Date
  entitlementVersion: number
}

export interface ActivePaidCycleAuthority {
  kind: 'active_paid_cycle'
  entitlementSource: 'subscription'
  providerMode: ProviderMode
  cycleId: string
  subscriptionId: string
  razorpaySubscriptionId: string
  planKey: 'plus' | 'pro'
  catalogVersion: string
  periodKey: string
  periodStart: Date
  periodEnd: Date
  interviewsUsed: number
  interviewLimit: number
  maxDurationMinutes: 30
  entitlementVersion: number
}

export interface AdminCompPeriodAuthority {
  kind: 'admin_comp_period'
  entitlementSource: 'admin_grant'
  projectionId: string
  grantId: string
  grantVersion: number
  planKey: 'plus' | 'pro'
  catalogVersion: string
  catalogContentHash: string
  periodKey: string
  periodStart: Date
  periodEnd: Date
  interviewsUsed: number
  interviewLimit: number
  maxDurationMinutes: 30
  entitlementVersion: number
  counterEpoch: {
    epochId: string
    epochNumber: number
  }
}

export type SubscriptionGraceGrantState =
  | 'not_offered'
  | 'available'
  | 'reserved'
  | 'consumed'
  | 'revoked'
  | 'tracked_goodwill'
  | 'counted_against_cycle'

export interface SubscriptionGraceInterviewAuthority {
  kind: 'subscription_grace'
  entitlementSource: 'subscription_grace'
  providerMode: ProviderMode
  caseId: string
  caseRevision: number
  statusVersion: number
  grantId: string
  grantRevision: number
  grantState: SubscriptionGraceGrantState
  grantDigest?: string
  subscriptionId: string
  razorpaySubscriptionId: string
  planKey: 'plus' | 'pro'
  catalogVersion: string
  paidPeriodKey: string
  paidPeriodStart: Date
  paidPeriodEnd: Date
  graceEndsAt: Date
  sourceEvidenceDigest: string
  decisionDigest: string
  maxDurationMinutes: 30
}

export type IncludedInterviewAuthority =
  | BasicCalendarMonthAuthority
  | ActivePaidCycleAuthority
  | AdminCompPeriodAuthority
  | SubscriptionGraceInterviewAuthority

export interface PaidInterviewUnlockCandidate {
  unlockId: string
  providerMode: ProviderMode
  status: 'available' | 'restored'
  maxDurationMinutes: 30
  validUntil: Date
  createdAt: Date
}

export interface AdminInterviewGrantCandidate {
  projectionId: string
  grantId: string
  grantVersion: number
  interviewState: 'available' | 'restored'
  maxDurationMinutes: 30
  startsAt: Date
  endsAt: Date
  createdAt: Date
  consumedSessionId?: string
  consumedUsageId?: string
  consumedAt?: Date
  restorationId?: string
  restoredAt?: Date
}

export interface InterviewEntitlementDecisionInput {
  userId: string
  providerMode: ProviderMode
  now: Date
  configuration: RequestedInterviewConfiguration
  includedAuthority: IncludedInterviewAuthority
  paidInterviewUnlocks: readonly PaidInterviewUnlockCandidate[]
  adminInterviewGrants: readonly AdminInterviewGrantCandidate[]
}

export type InterviewUsageEntitlementSnapshot =
  | BasicInterviewUsageEntitlementSnapshot
  | PaidCycleInterviewUsageEntitlementSnapshot
  | SubscriptionGraceInterviewUsageEntitlementSnapshot
  | PaidUnlockInterviewUsageEntitlementSnapshot
  | AdminCompInterviewUsageEntitlementSnapshot
  | AdminOneTimeInterviewUsageEntitlementSnapshot

interface InterviewUsageEntitlementSnapshotBase {
  schemaVersion:
    typeof INTERVIEW_ENTITLEMENT_DECISION_SCHEMA_VERSION
  policyVersion:
    typeof INTERVIEW_ENTITLEMENT_DECISION_POLICY_VERSION
  decidedAt: string
  userId: string
  providerMode: ProviderMode
  interviewType: string
  normalizedDurationMinutes:
    SupportedInterviewDurationMinutes
  normalizedDurationSeconds: 600 | 1200 | 1800
}

export interface BasicInterviewUsageEntitlementSnapshot
  extends InterviewUsageEntitlementSnapshotBase {
  source: 'free_period'
  sourceId: string
  activePaidCycleState: 'none'
  entitlementSource: 'free'
  effectiveTier: 'basic'
  periodKey: string
  periodStart: string
  periodEnd: string
  interviewLimit: 1
  interviewsUsedBefore: number
  interviewsRemainingBefore: number
  maxDurationMinutes: 10
  entitlementVersion: number
}

export interface PaidCycleInterviewUsageEntitlementSnapshot
  extends InterviewUsageEntitlementSnapshotBase {
  source: 'subscription_cycle'
  sourceId: string
  entitlementSource: 'subscription'
  effectiveTier: 'plus' | 'pro'
  subscriptionId: string
  razorpaySubscriptionId: string
  catalogVersion: string
  periodKey: string
  periodStart: string
  periodEnd: string
  interviewLimit: number
  interviewsUsedBefore: number
  interviewsRemainingBefore: number
  maxDurationMinutes: 30
  entitlementVersion: number
}

export interface SubscriptionGraceInterviewUsageEntitlementSnapshot
  extends InterviewUsageEntitlementSnapshotBase {
  source: 'subscription_grace'
  sourceId: string
  entitlementSource: 'subscription_grace'
  effectiveTier: 'plus' | 'pro'
  caseId: string
  caseRevision: number
  statusVersion: number
  grantId: string
  grantRevision: number
  grantState: 'not_offered' | 'available'
  grantDigest?: string
  subscriptionId: string
  razorpaySubscriptionId: string
  catalogVersion: string
  periodKey: string
  periodStart: string
  periodEnd: string
  graceEndsAt: string
  sourceEvidenceDigest: string
  decisionDigest: string
  interviewLimit: 1
  interviewsUsedBefore: 0
  interviewsRemainingBefore: 1
  maxDurationMinutes: 30
}

export interface PaidUnlockInterviewUsageEntitlementSnapshot
  extends InterviewUsageEntitlementSnapshotBase {
  source: 'paid_interview'
  sourceId: string
  entitlementSource: 'one_time_purchase'
  effectiveTier: 'basic' | 'plus' | 'pro'
  unlockStatus: 'available' | 'restored'
  validUntil: string
  createdAt: string
  maxDurationMinutes: 30
}

export interface AdminCompInterviewUsageEntitlementSnapshot
  extends InterviewUsageEntitlementSnapshotBase {
  source: 'admin'
  sourceId: string
  entitlementSource: 'admin_grant'
  adminGrantKind: 'comp_period'
  effectiveTier: 'plus' | 'pro'
  grantId: string
  grantVersion: number
  catalogVersion: string
  catalogContentHash: string
  periodKey: string
  periodStart: string
  periodEnd: string
  interviewLimit: number
  interviewsUsedBefore: number
  interviewsRemainingBefore: number
  maxDurationMinutes: 30
  entitlementVersion: number
  counterEpoch: {
    epochId: string
    epochNumber: number
  }
}

export interface AdminOneTimeInterviewUsageEntitlementSnapshot
  extends InterviewUsageEntitlementSnapshotBase {
  source: 'admin'
  sourceId: string
  entitlementSource: 'admin_grant'
  adminGrantKind: 'interview'
  effectiveTier: 'basic' | 'plus' | 'pro'
  grantId: string
  grantVersion: number
  interviewState: 'available' | 'restored'
  startsAt: string
  endsAt: string
  createdAt: string
  maxDurationMinutes: 30
  previousConsumption?: {
    sessionId: string
    usageId: string
    consumedAt: string
    restorationId: string
    restoredAt: string
  }
}

export interface InterviewEntitlementReservationDecision {
  schemaVersion:
    typeof INTERVIEW_ENTITLEMENT_DECISION_SCHEMA_VERSION
  policyVersion:
    typeof INTERVIEW_ENTITLEMENT_DECISION_POLICY_VERSION
  decision: 'reservation_required'
  decidedAt: string
  normalizedConfiguration:
    Readonly<NormalizedInterviewConfiguration>
  effectiveTier: 'basic' | 'plus' | 'pro'
  selection: Readonly<{
    source:
      | 'free_period'
      | 'subscription_cycle'
      | 'subscription_grace'
      | 'paid_interview'
      | 'admin'
    sourceId: string
    expiresAt: string
    precedence:
      | 'earliest_expiry'
      | 'included_expiry_tie'
      | 'paid_created_at_tie_break'
      | 'paid_id_tie_break'
      | 'admin_before_paid_tie'
      | 'admin_created_at_tie_break'
      | 'admin_id_tie_break'
      | 'only_eligible_candidate'
  }>
  reservation: Readonly<{
    source:
      | 'free_period'
      | 'subscription_cycle'
      | 'subscription_grace'
      | 'paid_interview'
      | 'admin'
    sourceId: string
    periodKey?: string
    normalizedDurationMinutes:
      SupportedInterviewDurationMinutes
    entitlementSnapshot:
      Readonly<InterviewUsageEntitlementSnapshot>
  }>
}

export interface InterviewLimitPaymentRequiredDecision {
  schemaVersion:
    typeof INTERVIEW_ENTITLEMENT_DECISION_SCHEMA_VERSION
  policyVersion:
    typeof INTERVIEW_ENTITLEMENT_DECISION_POLICY_VERSION
  decision: 'payment_required'
  decidedAt: string
  normalizedConfiguration:
    Readonly<NormalizedInterviewConfiguration>
  effectiveTier: 'basic' | 'plus' | 'pro'
  response: Readonly<{
    status: 402
    code: 'INTERVIEW_LIMIT'
    quoteResolution: 'server_required'
    preserveConfiguration: true
    reason:
      | 'included_duration_exceeded'
      | 'allowance_exhausted'
    quoteRequests: Readonly<{
      plus: Readonly<{
        planKey: 'plus'
        surface: 'interviewPaywall'
      }>
      pro: Readonly<{
        planKey: 'pro'
        surface: 'interviewPaywall'
      }>
      singleInterview: Readonly<{
        sku: 'single_interview'
        surface: 'interviewPaywall'
      }>
    }>
  }>
}

export type InterviewEntitlementDecision =
  | InterviewEntitlementReservationDecision
  | InterviewLimitPaymentRequiredDecision

interface IncludedCandidate {
  source:
    | 'free_period'
    | 'subscription_cycle'
    | 'subscription_grace'
    | 'admin'
  sourceId: string
  expiresAt: Date
  snapshot:
    | BasicInterviewUsageEntitlementSnapshot
    | PaidCycleInterviewUsageEntitlementSnapshot
    | SubscriptionGraceInterviewUsageEntitlementSnapshot
    | AdminCompInterviewUsageEntitlementSnapshot
}

interface UnlockCandidate {
  source: 'paid_interview'
  sourceId: string
  expiresAt: Date
  createdAt: Date
  snapshot: PaidUnlockInterviewUsageEntitlementSnapshot
}

interface AdminUnlockCandidate {
  source: 'admin'
  sourceId: string
  expiresAt: Date
  createdAt: Date
  snapshot: AdminOneTimeInterviewUsageEntitlementSnapshot
}

type EligibleCandidate =
  | IncludedCandidate
  | UnlockCandidate
  | AdminUnlockCandidate

function fail(
  code: InterviewEntitlementDecisionErrorCode,
  message: string,
): never {
  throw new InterviewEntitlementDecisionError(code, message)
}

function validDate(value: unknown): value is Date {
  return (
    value instanceof Date &&
    Number.isFinite(value.getTime())
  )
}

function exactObjectId(
  value: unknown,
  field: string,
): string {
  if (
    typeof value !== 'string' ||
    !OBJECT_ID_PATTERN.test(value)
  ) {
    fail(
      'invalid_authority',
      `${field} must be a canonical ObjectId`,
    )
  }
  return value
}

function nonNegativeSafeInteger(
  value: unknown,
  field: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 0
  ) {
    fail(
      'invalid_authority',
      `${field} must be a non-negative safe integer`,
    )
  }
  return Number(value)
}

function positiveSafeInteger(
  value: unknown,
  field: string,
): number {
  const normalized = nonNegativeSafeInteger(value, field)
  if (normalized === 0) {
    fail(
      'invalid_authority',
      `${field} must be positive`,
    )
  }
  return normalized
}

function exactNonEmptyString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maxLength ||
    value !== value.trim()
  ) {
    fail(
      'invalid_authority',
      `${field} must be an exact non-empty string`,
    )
  }
  return value
}

function exactAuthorityId(value: unknown, field: string): string {
  const normalized = exactNonEmptyString(value, field, 200)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(normalized)) {
    fail('invalid_authority', `${field} is malformed`)
  }
  return normalized
}

function exactIso(date: Date): string {
  return new Date(date).toISOString()
}

function durationSeconds(
  durationMinutes: SupportedInterviewDurationMinutes,
): 600 | 1200 | 1800 {
  return (durationMinutes * 60) as 600 | 1200 | 1800
}

export function normalizeInterviewEntitlementConfiguration(
  input: RequestedInterviewConfiguration,
): Readonly<NormalizedInterviewConfiguration> {
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.interviewType !== 'string' ||
    input.interviewType.length < 1 ||
    input.interviewType.length > 100 ||
    !INTERVIEW_TYPE_PATTERN.test(input.interviewType) ||
    input.interviewTypeSupported !== true
  ) {
    fail(
      'invalid_configuration',
      'Interview type is not supported',
    )
  }
  if (
    typeof input.durationMinutes !== 'number' ||
    !SUPPORTED_INTERVIEW_DURATIONS_MINUTES.includes(
      input.durationMinutes as SupportedInterviewDurationMinutes,
    )
  ) {
    fail(
      'invalid_configuration',
      'Duration must be exactly 10, 20, or 30 minutes',
    )
  }
  const normalizedDurationMinutes =
    input.durationMinutes as SupportedInterviewDurationMinutes
  return Object.freeze({
    interviewType: input.interviewType,
    durationMinutes: normalizedDurationMinutes,
    durationSeconds: durationSeconds(
      normalizedDurationMinutes,
    ),
  })
}

function includedTier(
  authority: IncludedInterviewAuthority,
): 'basic' | 'plus' | 'pro' {
  return authority.kind === 'basic_calendar_month'
    ? 'basic'
    : authority.planKey
}

function baseSnapshot(input: {
  userId: string
  providerMode: ProviderMode
  now: Date
  configuration: NormalizedInterviewConfiguration
}): InterviewUsageEntitlementSnapshotBase {
  return {
    schemaVersion:
      INTERVIEW_ENTITLEMENT_DECISION_SCHEMA_VERSION,
    policyVersion:
      INTERVIEW_ENTITLEMENT_DECISION_POLICY_VERSION,
    decidedAt: exactIso(input.now),
    userId: input.userId,
    providerMode: input.providerMode,
    interviewType: input.configuration.interviewType,
    normalizedDurationMinutes:
      input.configuration.durationMinutes,
    normalizedDurationSeconds:
      input.configuration.durationSeconds,
  }
}

function basicCandidate(input: {
  userId: string
  providerMode: ProviderMode
  now: Date
  configuration: NormalizedInterviewConfiguration
  authority: BasicCalendarMonthAuthority
}): IncludedCandidate | null {
  const period = basicCalendarMonthPeriod(input.now)
  const used = nonNegativeSafeInteger(
    input.authority.interviewsUsed,
    'interviewsUsed',
  )
  const version = positiveSafeInteger(
    input.authority.entitlementVersion,
    'entitlementVersion',
  )
  if (
    input.authority.entitlementSource !== 'free' ||
    input.authority.activePaidCycleState !== 'none' ||
    input.authority.interviewLimit !== 1 ||
    input.authority.usagePeriodKey !== period.key ||
    !validDate(input.authority.usageResetAt) ||
    input.authority.usageResetAt.getTime() !==
      period.end.getTime() ||
    used > input.authority.interviewLimit
  ) {
    fail(
      'invalid_authority',
      'Basic calendar-month authority is inconsistent',
    )
  }
  const remaining =
    input.authority.interviewLimit - used
  const snapshot: BasicInterviewUsageEntitlementSnapshot = {
    ...baseSnapshot(input),
    source: 'free_period',
    sourceId: input.userId,
    activePaidCycleState: 'none',
    entitlementSource: 'free',
    effectiveTier: 'basic',
    periodKey: period.key,
    periodStart: exactIso(period.start),
    periodEnd: exactIso(period.end),
    interviewLimit: 1,
    interviewsUsedBefore: used,
    interviewsRemainingBefore: remaining,
    maxDurationMinutes: 10,
    entitlementVersion: version,
  }
  if (
    remaining === 0 ||
    input.configuration.durationMinutes >
      CONSUMER_CATALOG_V1.plans.free.interview
        .maxDurationMinutes
  ) {
    return null
  }
  return {
    source: snapshot.source,
    sourceId: snapshot.sourceId,
    expiresAt: period.end,
    snapshot,
  }
}

function paidCycleCandidate(input: {
  userId: string
  providerMode: ProviderMode
  now: Date
  configuration: NormalizedInterviewConfiguration
  authority: ActivePaidCycleAuthority
}): IncludedCandidate | null {
  const authority = input.authority
  const cycleId = exactObjectId(
    authority.cycleId,
    'cycleId',
  )
  const subscriptionId = exactObjectId(
    authority.subscriptionId,
    'subscriptionId',
  )
  if (
    authority.planKey !== 'plus' &&
    authority.planKey !== 'pro'
  ) {
    fail(
      'invalid_authority',
      'Paid-cycle plan must be Plus or Pro',
    )
  }
  const razorpaySubscriptionId = exactNonEmptyString(
    authority.razorpaySubscriptionId,
    'razorpaySubscriptionId',
    255,
  )
  if (
    !/^sub_[A-Za-z0-9]+$/.test(
      razorpaySubscriptionId,
    )
  ) {
    fail(
      'invalid_authority',
      'Razorpay subscription authority is malformed',
    )
  }
  const used = nonNegativeSafeInteger(
    authority.interviewsUsed,
    'interviewsUsed',
  )
  const version = positiveSafeInteger(
    authority.entitlementVersion,
    'entitlementVersion',
  )
  const capturedLimit = positiveSafeInteger(
    authority.interviewLimit,
    'interviewLimit',
  )
  const expectedPeriodKey =
    validDate(authority.periodStart) &&
    validDate(authority.periodEnd)
      ? `paid:${razorpaySubscriptionId}:${Math.floor(
          authority.periodStart.getTime() / 1000,
        )}:${Math.floor(
          authority.periodEnd.getTime() / 1000,
        )}`
      : null
  if (
    authority.entitlementSource !== 'subscription' ||
    authority.providerMode !== input.providerMode ||
    !validDate(authority.periodStart) ||
    !validDate(authority.periodEnd) ||
    authority.periodStart > input.now ||
    authority.periodEnd <= input.now ||
    authority.periodEnd <= authority.periodStart ||
    authority.periodKey !== expectedPeriodKey ||
    used > capturedLimit ||
    authority.maxDurationMinutes !== 30
  ) {
    fail(
      'invalid_authority',
      'Active paid-cycle authority is inconsistent',
    )
  }
  const catalogVersion = exactNonEmptyString(
    authority.catalogVersion,
    'catalogVersion',
    100,
  )
  const periodKey = exactNonEmptyString(
    authority.periodKey,
    'periodKey',
    255,
  )
  const remaining = capturedLimit - used
  const snapshot: PaidCycleInterviewUsageEntitlementSnapshot = {
    ...baseSnapshot(input),
    source: 'subscription_cycle',
    sourceId: cycleId,
    entitlementSource: 'subscription',
    effectiveTier: authority.planKey,
    subscriptionId,
    razorpaySubscriptionId,
    catalogVersion,
    periodKey,
    periodStart: exactIso(authority.periodStart),
    periodEnd: exactIso(authority.periodEnd),
    interviewLimit: capturedLimit,
    interviewsUsedBefore: used,
    interviewsRemainingBefore: remaining,
    maxDurationMinutes: 30,
    entitlementVersion: version,
  }
  if (remaining === 0) return null
  return {
    source: snapshot.source,
    sourceId: snapshot.sourceId,
    expiresAt: new Date(authority.periodEnd),
    snapshot,
  }
}

function subscriptionGraceCandidate(input: {
  userId: string
  providerMode: ProviderMode
  now: Date
  configuration: NormalizedInterviewConfiguration
  authority: SubscriptionGraceInterviewAuthority
}): IncludedCandidate | null {
  const authority = input.authority
  const caseId = exactObjectId(authority.caseId, 'caseId')
  const grantId = exactObjectId(authority.grantId, 'grantId')
  const subscriptionId = exactObjectId(
    authority.subscriptionId,
    'subscriptionId',
  )
  const caseRevision = positiveSafeInteger(
    authority.caseRevision,
    'caseRevision',
  )
  const statusVersion = nonNegativeSafeInteger(
    authority.statusVersion,
    'statusVersion',
  )
  const grantRevision = nonNegativeSafeInteger(
    authority.grantRevision,
    'grantRevision',
  )
  const periodKey = exactNonEmptyString(
    authority.paidPeriodKey,
    'paidPeriodKey',
    255,
  )
  const catalogVersion = exactNonEmptyString(
    authority.catalogVersion,
    'catalogVersion',
    100,
  )
  const razorpaySubscriptionId = exactNonEmptyString(
    authority.razorpaySubscriptionId,
    'razorpaySubscriptionId',
    255,
  )
  const eligibleState =
    authority.grantState === 'not_offered' ||
    authority.grantState === 'available'
  const digestAuthority =
    typeof authority.grantDigest === 'string' &&
    /^[a-f0-9]{64}$/.test(authority.grantDigest)
  if (
    authority.entitlementSource !== 'subscription_grace' ||
    authority.providerMode !== input.providerMode ||
    (authority.planKey !== 'plus' && authority.planKey !== 'pro') ||
    !/^sub_[A-Za-z0-9]+$/.test(razorpaySubscriptionId) ||
    !validDate(authority.paidPeriodStart) ||
    !validDate(authority.paidPeriodEnd) ||
    !validDate(authority.graceEndsAt) ||
    authority.paidPeriodEnd <= authority.paidPeriodStart ||
    authority.paidPeriodEnd > input.now ||
    authority.graceEndsAt <= input.now ||
    authority.graceEndsAt <= authority.paidPeriodEnd ||
    authority.graceEndsAt.getTime() -
      authority.paidPeriodEnd.getTime() > 72 * 60 * 60 * 1_000 ||
    authority.maxDurationMinutes !== 30 ||
    !/^[a-f0-9]{64}$/.test(authority.sourceEvidenceDigest) ||
    !/^[a-f0-9]{64}$/.test(authority.decisionDigest) ||
    (
      authority.grantState === 'not_offered'
        ? grantRevision !== 0 || authority.grantDigest !== undefined
        : grantRevision < 1 || !digestAuthority
    )
  ) {
    fail(
      'invalid_authority',
      'Subscription grace authority is inconsistent',
    )
  }
  if (!eligibleState) return null
  const grantState = authority.grantState as
    | 'not_offered'
    | 'available'
  const snapshot: SubscriptionGraceInterviewUsageEntitlementSnapshot = {
    ...baseSnapshot(input),
    source: 'subscription_grace',
    sourceId: grantId,
    entitlementSource: 'subscription_grace',
    effectiveTier: authority.planKey,
    caseId,
    caseRevision,
    statusVersion,
    grantId,
    grantRevision,
    grantState,
    ...(authority.grantDigest
      ? { grantDigest: authority.grantDigest }
      : {}),
    subscriptionId,
    razorpaySubscriptionId,
    catalogVersion,
    periodKey,
    periodStart: exactIso(authority.paidPeriodStart),
    periodEnd: exactIso(authority.paidPeriodEnd),
    graceEndsAt: exactIso(authority.graceEndsAt),
    sourceEvidenceDigest: authority.sourceEvidenceDigest,
    decisionDigest: authority.decisionDigest,
    interviewLimit: 1,
    interviewsUsedBefore: 0,
    interviewsRemainingBefore: 1,
    maxDurationMinutes: 30,
  }
  return {
    source: 'subscription_grace',
    sourceId: grantId,
    expiresAt: new Date(authority.graceEndsAt),
    snapshot,
  }
}

function adminCompCandidate(input: {
  userId: string
  providerMode: ProviderMode
  now: Date
  configuration: NormalizedInterviewConfiguration
  authority: AdminCompPeriodAuthority
}): IncludedCandidate | null {
  const authority = input.authority
  const projectionId = exactObjectId(
    authority.projectionId,
    'projectionId',
  )
  const grantId = exactAuthorityId(authority.grantId, 'grantId')
  const grantVersion = positiveSafeInteger(
    authority.grantVersion,
    'grantVersion',
  )
  const used = nonNegativeSafeInteger(
    authority.interviewsUsed,
    'interviewsUsed',
  )
  const limit = positiveSafeInteger(
    authority.interviewLimit,
    'interviewLimit',
  )
  const entitlementVersion = positiveSafeInteger(
    authority.entitlementVersion,
    'entitlementVersion',
  )
  const epochId = exactAuthorityId(
    authority.counterEpoch?.epochId,
    'counterEpoch.epochId',
  )
  const epochNumber = positiveSafeInteger(
    authority.counterEpoch?.epochNumber,
    'counterEpoch.epochNumber',
  )
  const catalogVersion = exactNonEmptyString(
    authority.catalogVersion,
    'catalogVersion',
    100,
  )
  const catalogContentHash = exactNonEmptyString(
    authority.catalogContentHash,
    'catalogContentHash',
    64,
  )
  if (
    authority.entitlementSource !== 'admin_grant' ||
    (authority.planKey !== 'plus' && authority.planKey !== 'pro') ||
    !validDate(authority.periodStart) ||
    !validDate(authority.periodEnd) ||
    authority.periodStart > input.now ||
    authority.periodEnd <= input.now ||
    authority.periodEnd <= authority.periodStart ||
    authority.periodEnd.getTime() -
      authority.periodStart.getTime() > 90 * DAY_MS ||
    authority.periodKey !== `admin-comp:${grantId}` ||
    !/^[a-f0-9]{64}$/.test(catalogContentHash) ||
    used > limit ||
    authority.maxDurationMinutes !== 30
  ) {
    fail(
      'invalid_authority',
      'Admin comp-period authority is inconsistent',
    )
  }
  const remaining = limit - used
  const snapshot: AdminCompInterviewUsageEntitlementSnapshot = {
    ...baseSnapshot(input),
    source: 'admin',
    sourceId: projectionId,
    entitlementSource: 'admin_grant',
    adminGrantKind: 'comp_period',
    effectiveTier: authority.planKey,
    grantId,
    grantVersion,
    catalogVersion,
    catalogContentHash,
    periodKey: authority.periodKey,
    periodStart: exactIso(authority.periodStart),
    periodEnd: exactIso(authority.periodEnd),
    interviewLimit: limit,
    interviewsUsedBefore: used,
    interviewsRemainingBefore: remaining,
    maxDurationMinutes: 30,
    entitlementVersion,
    counterEpoch: { epochId, epochNumber },
  }
  if (remaining === 0) return null
  return {
    source: 'admin',
    sourceId: projectionId,
    expiresAt: new Date(authority.periodEnd),
    snapshot,
  }
}

function unlockCandidates(input: {
  userId: string
  providerMode: ProviderMode
  now: Date
  configuration: NormalizedInterviewConfiguration
  paidInterviewUnlocks:
    readonly PaidInterviewUnlockCandidate[]
  effectiveTier: 'basic' | 'plus' | 'pro'
}): UnlockCandidate[] {
  const seen = new Set<string>()
  return input.paidInterviewUnlocks.flatMap(
    (authority): UnlockCandidate[] => {
      if (
        !authority ||
        typeof authority !== 'object'
      ) {
        fail(
          'invalid_authority',
          'Paid interview unlock authority is invalid',
        )
      }
      const unlockId = exactObjectId(
        authority.unlockId,
        'unlockId',
      )
      if (seen.has(unlockId)) {
        fail(
          'invalid_authority',
          'Paid interview unlock candidates must be unique',
        )
      }
      seen.add(unlockId)
      if (
        authority.providerMode !== input.providerMode ||
        (
          authority.status !== 'available' &&
          authority.status !== 'restored'
        ) ||
        authority.maxDurationMinutes !== 30 ||
        !validDate(authority.validUntil) ||
        !validDate(authority.createdAt) ||
        authority.createdAt > input.now ||
        authority.validUntil <= authority.createdAt
      ) {
        fail(
          'invalid_authority',
          'Paid interview unlock authority is inconsistent',
        )
      }
      if (authority.validUntil <= input.now) return []
      const snapshot: PaidUnlockInterviewUsageEntitlementSnapshot = {
        ...baseSnapshot(input),
        source: 'paid_interview',
        sourceId: unlockId,
        entitlementSource: 'one_time_purchase',
        effectiveTier: input.effectiveTier,
        unlockStatus: authority.status,
        validUntil: exactIso(authority.validUntil),
        createdAt: exactIso(authority.createdAt),
        maxDurationMinutes: 30,
      }
      return [{
        source: 'paid_interview',
        sourceId: unlockId,
        expiresAt: new Date(authority.validUntil),
        createdAt: new Date(authority.createdAt),
        snapshot,
      }]
    },
  )
}

function adminUnlockCandidates(input: {
  userId: string
  providerMode: ProviderMode
  now: Date
  configuration: NormalizedInterviewConfiguration
  adminInterviewGrants:
    readonly AdminInterviewGrantCandidate[]
  effectiveTier: 'basic' | 'plus' | 'pro'
}): AdminUnlockCandidate[] {
  const seen = new Set<string>()
  return input.adminInterviewGrants.flatMap(
    (authority): AdminUnlockCandidate[] => {
      if (!authority || typeof authority !== 'object') {
        fail('invalid_authority', 'Admin interview authority is invalid')
      }
      const projectionId = exactObjectId(
        authority.projectionId,
        'projectionId',
      )
      if (seen.has(projectionId)) {
        fail(
          'invalid_authority',
          'Admin interview candidates must be unique',
        )
      }
      seen.add(projectionId)
      const grantId = exactAuthorityId(authority.grantId, 'grantId')
      const grantVersion = positiveSafeInteger(
        authority.grantVersion,
        'grantVersion',
      )
      const datesValid =
        validDate(authority.startsAt) &&
        validDate(authority.endsAt) &&
        validDate(authority.createdAt)
      const consumption = [
        authority.consumedSessionId,
        authority.consumedUsageId,
        authority.consumedAt,
        authority.restorationId,
        authority.restoredAt,
      ]
      const restored = authority.interviewState === 'restored'
      if (
        !datesValid ||
        authority.startsAt > input.now ||
        authority.endsAt <= input.now ||
        authority.endsAt <= authority.startsAt ||
        authority.endsAt.getTime() - authority.startsAt.getTime() >
          30 * DAY_MS ||
        authority.createdAt > input.now ||
        authority.maxDurationMinutes !== 30 ||
        (
          authority.interviewState !== 'available' &&
          !restored
        ) ||
        (
          restored
            ? consumption.some((value) => value === undefined)
            : consumption.some((value) => value !== undefined)
        )
      ) {
        fail(
          'invalid_authority',
          'Admin interview authority is inconsistent',
        )
      }
      let previousConsumption:
        AdminOneTimeInterviewUsageEntitlementSnapshot[
          'previousConsumption'
        ]
      if (restored) {
        const sessionId = exactObjectId(
          authority.consumedSessionId,
          'consumedSessionId',
        )
        const usageId = exactObjectId(
          authority.consumedUsageId,
          'consumedUsageId',
        )
        const restorationId = exactObjectId(
          authority.restorationId,
          'restorationId',
        )
        if (
          !validDate(authority.consumedAt) ||
          !validDate(authority.restoredAt) ||
          authority.consumedAt < authority.startsAt ||
          authority.consumedAt >= authority.endsAt ||
          authority.restoredAt < authority.consumedAt ||
          authority.restoredAt > input.now
        ) {
          fail(
            'invalid_authority',
            'Restored admin interview evidence is inconsistent',
          )
        }
        previousConsumption = {
          sessionId,
          usageId,
          consumedAt: exactIso(authority.consumedAt),
          restorationId,
          restoredAt: exactIso(authority.restoredAt),
        }
      }
      const snapshot:
        AdminOneTimeInterviewUsageEntitlementSnapshot = {
          ...baseSnapshot(input),
          source: 'admin',
          sourceId: projectionId,
          entitlementSource: 'admin_grant',
          adminGrantKind: 'interview',
          effectiveTier: input.effectiveTier,
          grantId,
          grantVersion,
          interviewState: authority.interviewState,
          startsAt: exactIso(authority.startsAt),
          endsAt: exactIso(authority.endsAt),
          createdAt: exactIso(authority.createdAt),
          maxDurationMinutes: 30,
          ...(previousConsumption ? { previousConsumption } : {}),
        }
      return [{
        source: 'admin',
        sourceId: projectionId,
        expiresAt: new Date(authority.endsAt),
        createdAt: new Date(authority.createdAt),
        snapshot,
      }]
    },
  )
}

function candidateClass(candidate: EligibleCandidate): 0 | 1 | 2 {
  if (
    candidate.source === 'free_period' ||
    candidate.source === 'subscription_cycle' ||
    candidate.source === 'subscription_grace' ||
    (
      candidate.source === 'admin' &&
      'adminGrantKind' in candidate.snapshot &&
      candidate.snapshot.adminGrantKind === 'comp_period'
    )
  ) return 0
  return candidate.source === 'admin' ? 1 : 2
}

function compareCandidates(
  left: EligibleCandidate,
  right: EligibleCandidate,
): number {
  const expiryDifference =
    left.expiresAt.getTime() - right.expiresAt.getTime()
  if (expiryDifference !== 0) return expiryDifference
  const classDifference =
    candidateClass(left) - candidateClass(right)
  if (classDifference !== 0) return classDifference
  if ('createdAt' in left && 'createdAt' in right) {
    const creationDifference =
      left.createdAt.getTime() - right.createdAt.getTime()
    if (creationDifference !== 0) return creationDifference
  }
  return left.sourceId === right.sourceId
    ? 0
    : left.sourceId < right.sourceId
      ? -1
      : 1
}

function selectionPrecedence(
  selected: EligibleCandidate,
  candidates: readonly EligibleCandidate[],
): InterviewEntitlementReservationDecision[
  'selection'
]['precedence'] {
  if (candidates.length === 1) {
    return 'only_eligible_candidate'
  }
  const hasExpiryTie = candidates.some(
    (candidate) => (
      candidate !== selected &&
      candidate.expiresAt.getTime() ===
        selected.expiresAt.getTime()
    ),
  )
  if (
    candidateClass(selected) === 0 &&
    hasExpiryTie
  ) {
    return 'included_expiry_tie'
  }
  if (
    selected.source === 'admin' &&
    'createdAt' in selected &&
    'adminGrantKind' in selected.snapshot &&
    selected.snapshot.adminGrantKind === 'interview' &&
    hasExpiryTie
  ) {
    const adminTies = candidates.filter(
      (candidate): candidate is AdminUnlockCandidate =>
        candidate.source === 'admin' &&
        'createdAt' in candidate &&
        'adminGrantKind' in candidate.snapshot &&
        candidate.snapshot.adminGrantKind === 'interview' &&
        candidate !== selected &&
        candidate.expiresAt.getTime() === selected.expiresAt.getTime(),
    )
    if (adminTies.length === 0) return 'admin_before_paid_tie'
    return adminTies.some(
      (candidate) =>
        candidate.createdAt.getTime() === selected.createdAt.getTime(),
    )
      ? 'admin_id_tie_break'
      : 'admin_created_at_tie_break'
  }
  if (
    selected.source === 'paid_interview' &&
    hasExpiryTie
  ) {
    const paidExpiryTies = candidates.filter(
      (candidate): candidate is UnlockCandidate => (
        candidate.source === 'paid_interview' &&
        candidate !== selected &&
        candidate.expiresAt.getTime() ===
          selected.expiresAt.getTime()
      ),
    )
    return paidExpiryTies.some(
      (candidate) => candidate.createdAt.getTime() ===
        selected.createdAt.getTime(),
    )
      ? 'paid_id_tie_break'
      : 'paid_created_at_tie_break'
  }
  return 'earliest_expiry'
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Object.isFrozen(value)
  ) {
    Object.freeze(value)
    for (const nested of Object.values(value)) {
      deepFreeze(nested)
    }
  }
  return value
}

function paymentRequiredDecision(input: {
  now: Date
  configuration: NormalizedInterviewConfiguration
  effectiveTier: 'basic' | 'plus' | 'pro'
  includedAuthority: IncludedInterviewAuthority
}): InterviewLimitPaymentRequiredDecision {
  const maxIncludedDuration =
    input.includedAuthority.kind ===
      'basic_calendar_month'
      ? 10
      : 30
  return deepFreeze({
    schemaVersion:
      INTERVIEW_ENTITLEMENT_DECISION_SCHEMA_VERSION,
    policyVersion:
      INTERVIEW_ENTITLEMENT_DECISION_POLICY_VERSION,
    decision: 'payment_required',
    decidedAt: exactIso(input.now),
    normalizedConfiguration: input.configuration,
    effectiveTier: input.effectiveTier,
    response: {
      status: 402,
      code: 'INTERVIEW_LIMIT',
      quoteResolution: 'server_required',
      preserveConfiguration: true,
      reason:
        input.configuration.durationMinutes >
          maxIncludedDuration
          ? 'included_duration_exceeded'
          : 'allowance_exhausted',
      quoteRequests: {
        plus: {
          planKey: 'plus',
          surface: 'interviewPaywall',
        },
        pro: {
          planKey: 'pro',
          surface: 'interviewPaywall',
        },
        singleInterview: {
          sku: 'single_interview',
          surface: 'interviewPaywall',
        },
      },
    },
  })
}

export function decideAuthoritativeInterviewEntitlement(
  input: InterviewEntitlementDecisionInput,
): InterviewEntitlementDecision {
  if (!input || typeof input !== 'object') {
    fail(
      'invalid_authority',
      'Interview entitlement decision input is invalid',
    )
  }
  const userId = exactObjectId(input.userId, 'userId')
  if (
    !validDate(input.now) ||
    (input.providerMode !== 'test' &&
      input.providerMode !== 'live') ||
    !Array.isArray(input.paidInterviewUnlocks) ||
    input.paidInterviewUnlocks.length >
      MAX_INTERVIEW_ENTITLEMENT_UNLOCK_CANDIDATES ||
    !Array.isArray(input.adminInterviewGrants) ||
    input.adminInterviewGrants.length >
      MAX_ADMIN_INTERVIEW_GRANT_CANDIDATES
  ) {
    fail(
      'invalid_authority',
      'Interview entitlement decision authority is invalid',
    )
  }
  const now = new Date(input.now)
  const configuration =
    normalizeInterviewEntitlementConfiguration(
      input.configuration,
    )
  if (
    !input.includedAuthority ||
    typeof input.includedAuthority !== 'object' ||
    (
      input.includedAuthority.kind !==
        'basic_calendar_month' &&
      input.includedAuthority.kind !==
        'active_paid_cycle' &&
      input.includedAuthority.kind !==
        'subscription_grace' &&
      input.includedAuthority.kind !==
        'admin_comp_period'
    )
  ) {
    fail(
      'invalid_authority',
      'Included interview authority is invalid',
    )
  }
  const effectiveTier = includedTier(
    input.includedAuthority,
  )
  const shared = {
    userId,
    providerMode: input.providerMode,
    now,
    configuration,
  }
  const included =
    input.includedAuthority.kind ===
      'basic_calendar_month'
      ? basicCandidate({
          ...shared,
          authority: input.includedAuthority,
        })
      : input.includedAuthority.kind ===
          'active_paid_cycle'
        ? paidCycleCandidate({
            ...shared,
            authority: input.includedAuthority,
          })
        : input.includedAuthority.kind ===
            'subscription_grace'
          ? subscriptionGraceCandidate({
              ...shared,
              authority: input.includedAuthority,
            })
        : adminCompCandidate({
            ...shared,
            authority: input.includedAuthority,
          })
  const unlocks = unlockCandidates({
    ...shared,
    paidInterviewUnlocks: input.paidInterviewUnlocks,
    effectiveTier,
  })
  const adminUnlocks = adminUnlockCandidates({
    ...shared,
    adminInterviewGrants: input.adminInterviewGrants,
    effectiveTier,
  })
  const candidates: EligibleCandidate[] = [
    ...(included ? [included] : []),
    ...adminUnlocks,
    ...unlocks,
  ]
  candidates.sort(compareCandidates)
  const selected = candidates[0]
  if (!selected) {
    return paymentRequiredDecision({
      now,
      configuration,
      effectiveTier,
      includedAuthority: input.includedAuthority,
    })
  }

  const periodKey = 'periodKey' in selected.snapshot
    ? selected.snapshot.periodKey
    : undefined
  return deepFreeze({
    schemaVersion:
      INTERVIEW_ENTITLEMENT_DECISION_SCHEMA_VERSION,
    policyVersion:
      INTERVIEW_ENTITLEMENT_DECISION_POLICY_VERSION,
    decision: 'reservation_required',
    decidedAt: exactIso(now),
    normalizedConfiguration: configuration,
    effectiveTier,
    selection: {
      source: selected.source,
      sourceId: selected.sourceId,
      expiresAt: exactIso(selected.expiresAt),
      precedence: selectionPrecedence(
        selected,
        candidates,
      ),
    },
    reservation: {
      source: selected.source,
      sourceId: selected.sourceId,
      ...(periodKey === undefined
        ? {}
        : { periodKey }),
      normalizedDurationMinutes:
        configuration.durationMinutes,
      entitlementSnapshot: selected.snapshot,
    },
  })
}
