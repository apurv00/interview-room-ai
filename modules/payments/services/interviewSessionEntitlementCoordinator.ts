import mongoose, { type ClientSession } from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { InterviewDepth } from '@shared/db/models/InterviewDepth'
import { User } from '@shared/db/models/User'
import { FALLBACK_DEPTHS } from '@shared/db/seed'
import {
  type SupportedInterviewDurationMinutes,
} from '@shared/services/planConfig'
import {
  PR8_INTERVIEW_ENTITLEMENT_DECISION_READY,
  PR8_INTERVIEW_USAGE_RESERVATION_READY,
} from '@shared/services/pr8InterviewRollout'
import { BillingConfig } from '../models/BillingConfig'
import { AdminEntitlementProjection } from '../models/AdminEntitlementProjection'
import { InterviewUsage } from '../models/InterviewUsage'
import { PaidInterviewUnlock } from '../models/PaidInterviewUnlock'
import {
  Subscription,
  type SubscriptionStatus,
} from '../models/Subscription'
import { SubscriptionCycle } from '../models/SubscriptionCycle'
import {
  canonicalJson,
  sha256CanonicalJson,
} from '../lib/canonicalJson'
import type { ProviderMode } from '../types/catalog'
import {
  INTERVIEW_ENTITLEMENT_DECISION_POLICY_VERSION,
  INTERVIEW_ENTITLEMENT_DECISION_SCHEMA_VERSION,
  LEGACY_INTERVIEW_ENTITLEMENT_DECISION_POLICY_VERSION,
  LEGACY_INTERVIEW_ENTITLEMENT_DECISION_SCHEMA_VERSION,
  MAX_ADMIN_INTERVIEW_GRANT_CANDIDATES,
  MAX_INTERVIEW_ENTITLEMENT_UNLOCK_CANDIDATES,
  decideAuthoritativeInterviewEntitlement,
  normalizeInterviewEntitlementConfiguration,
  type ActivePaidCycleAuthority,
  type AdminCompPeriodAuthority,
  type AdminInterviewGrantCandidate,
  type BasicCalendarMonthAuthority,
  type IncludedInterviewAuthority,
  type InterviewEntitlementDecision,
  type InterviewEntitlementReservationDecision,
  type InterviewUsageEntitlementSnapshot,
  type PaidInterviewUnlockCandidate,
  type SubscriptionGraceInterviewAuthority,
  type SubscriptionGraceInterviewUsageEntitlementSnapshot,
} from './interviewEntitlementDecisionKernel'
import {
  projectBasicCalendarMonthEntitlementReadOnly,
  transitionBasicCalendarMonthEntitlementInSession,
} from './basicCalendarMonthTransitionService'
import { basicCalendarMonthPeriod } from './periodKeyService'
import {
  commitUserEntitlementProjectionUpdateInSession,
  findAndCommitUserEntitlementProjectionUpdateInSession,
} from './entitlementService'

const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/
const TERMINAL_SUBSCRIPTION_STATUSES =
  new Set<SubscriptionStatus>([
    'cancelled',
    'completed',
    'expired',
  ])
const ACTIVE_CYCLE_SUBSCRIPTION_STATUSES =
  new Set<SubscriptionStatus>([
    'active',
    'pending',
    'halted',
    'paused',
    'cancelled',
    'completed',
  ])
const ACTIVATION_SUBSCRIPTION_STATUSES =
  new Set<SubscriptionStatus>([
    'created',
    'authenticated',
    'activation_pending',
  ])

export const INTERVIEW_SESSION_ENTITLEMENT_ERROR_CODES = [
  'not_ready',
  'invalid_request',
  'authority_review',
  'reservation_conflict',
  'replay_conflict',
] as const
export type InterviewSessionEntitlementErrorCode =
  (typeof INTERVIEW_SESSION_ENTITLEMENT_ERROR_CODES)[number]

export class InterviewSessionEntitlementError extends Error {
  constructor(
    readonly code: InterviewSessionEntitlementErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'InterviewSessionEntitlementError'
  }
}

export interface InterviewSessionEntitlementInput {
  userId: string
  sessionId: string
  interviewType: string
  durationMinutes: unknown
}

export interface InterviewSessionEntitlementAuthority {
  providerMode: ProviderMode
  interviewTypeAuthority: {
    interviewType: string
    supported: true
  }
  includedAuthority: IncludedInterviewAuthority
  paidInterviewUnlocks:
    readonly PaidInterviewUnlockCandidate[]
  adminInterviewGrants:
    readonly AdminInterviewGrantCandidate[]
}

export interface SubscriptionGraceInterviewEntitlementPort {
  loadAuthority(
    input: {
      userId: string
      providerMode: ProviderMode
      now: Date
      subscriptionId: string
      razorpaySubscriptionId: string
      planKey: 'plus' | 'pro'
      catalogVersion: string
      paidPeriodKey: string
      paidPeriodStart: Date
      paidPeriodEnd: Date
    },
    session: ClientSession,
  ): Promise<SubscriptionGraceInterviewAuthority | null>
  reserve(
    input: {
      userId: string
      sessionId: string
      usageId: string
      providerMode: ProviderMode
      occurredAt: Date
      authority:
        Readonly<SubscriptionGraceInterviewUsageEntitlementSnapshot>
    },
    session: ClientSession,
  ): Promise<{
    caseId: string
    grantId: string
    state: 'reserved'
    reservedSessionId: string
    reservedAt: Date
  }>
}

export interface StoredInterviewUsage {
  id: mongoose.Types.ObjectId
  sessionId: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  source:
    | 'free_period'
    | 'subscription_cycle'
    | 'subscription_grace'
    | 'paid_interview'
    | 'admin'
  sourceId: mongoose.Types.ObjectId
  periodKey?: string
  reservedAt: Date
  consumedAt?: Date
  restorationId?: mongoose.Types.ObjectId
  normalizedDurationMinutes: number
  entitlementSnapshot: unknown
  entitlementSnapshotDigest?: string
  authorityEnvelope?: {
    version: 1
    adminGrantId?: string
    counterEpoch?: {
      epochId: string
      epochNumber: number
    }
  }
}

export interface InterviewSessionEntitlementStore {
  assertUserActive(
    userId: mongoose.Types.ObjectId,
    session: ClientSession,
  ): Promise<void>
  findUsageBySession(
    sessionId: mongoose.Types.ObjectId,
    session: ClientSession,
  ): Promise<StoredInterviewUsage | null>
  loadAuthority(
    input: {
      userId: mongoose.Types.ObjectId
      now: Date
      interviewType: string
    },
    session: ClientSession,
  ): Promise<InterviewSessionEntitlementAuthority>
  reserve(
    input: {
      userId: mongoose.Types.ObjectId
      sessionId: mongoose.Types.ObjectId
      now: Date
      providerMode: ProviderMode
      decision: InterviewEntitlementReservationDecision
    },
    session: ClientSession,
  ): Promise<StoredInterviewUsage>
}

export interface InterviewSessionEntitlementDependencies {
  decisionReady?: boolean
  reservationReady?: boolean
  now?: () => Date
  store?: InterviewSessionEntitlementStore
  decide?: typeof decideAuthoritativeInterviewEntitlement
  subscriptionGracePort?:
    SubscriptionGraceInterviewEntitlementPort
}

export interface InterviewSessionEntitlementReadDependencies {
  decisionReady?: boolean
  now?: () => Date
  readAuthority?: (input: {
    userId: mongoose.Types.ObjectId
    now: Date
    interviewType: string
  }) => Promise<InterviewSessionEntitlementAuthority>
  decide?: typeof decideAuthoritativeInterviewEntitlement
  subscriptionGracePort?:
    SubscriptionGraceInterviewEntitlementPort
}

export interface InterviewSessionEntitlementReadResult {
  authority: InterviewSessionEntitlementAuthority
  decision: InterviewEntitlementDecision
}

export type InterviewSessionEntitlementResult =
  | {
      kind: 'reserved'
      reused: boolean
      usageId: string
      providerMode: ProviderMode
      source:
        | 'free_period'
        | 'subscription_cycle'
        | 'subscription_grace'
        | 'paid_interview'
        | 'admin'
      sourceId: string
      periodKey?: string
      expiresAt: string
      effectiveTier: 'basic' | 'plus' | 'pro'
      normalizedConfiguration: {
        interviewType: string
        durationMinutes:
          SupportedInterviewDurationMinutes
        durationSeconds: 600 | 1200 | 1800
      }
      entitlementSnapshot:
        Readonly<InterviewUsageEntitlementSnapshot>
    }
  | {
      kind: 'payment_required'
      decision: Extract<
        InterviewEntitlementDecision,
        { decision: 'payment_required' }
      >
    }

interface UserAuthorityRow {
  _id: mongoose.Types.ObjectId
  plan?: string
  planVocabularyVersion?: number
  planExpiresAt?: Date
  entitlementSource?: string
  usagePeriodKey?: string
  interviewsUsed?: number
  interviewLimit?: number
  premiumResumesUsed?: number
  premiumResumeLimit?: number
  usageResetAt?: Date
  entitlementVersion?: number
  buyerState?: string
  deletionPendingAt?: Date
  entitlementAuthority?: {
    version: 1
    interviewCounterEpoch: {
      epochId: string
      epochNumber: number
    }
    premiumResumeCounterEpoch: {
      epochId: string
      epochNumber: number
    }
    adminGrantId?: string
    adminCompPeriodId?: mongoose.Types.ObjectId
  }
}

interface SubscriptionAuthorityRow {
  _id: mongoose.Types.ObjectId
  providerMode: ProviderMode
  planKey: 'plus' | 'pro'
  catalogVersion: string
  razorpaySubscriptionId: string
  status: SubscriptionStatus
  currentPeriodKey?: string
  currentPeriodStart?: Date
  currentPeriodEnd?: Date
}

interface SubscriptionCycleAuthorityRow {
  _id: mongoose.Types.ObjectId
  providerMode: ProviderMode
  subscriptionId: mongoose.Types.ObjectId
  planKey: 'plus' | 'pro'
  catalogVersion: string
  periodKey: string
  periodStart: Date
  periodEnd: Date
  interviewLimitSnapshot: number
  fulfillmentStatus: string
  projectionDisposition?: string
}

interface AdminCompAuthorityRow {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  grantId: string
  kind: 'comp_period'
  grantVersion: number
  authorityEnvelope: {
    version: 1
    interviewCounterEpoch: {
      epochId: string
      epochNumber: number
    }
    premiumResumeCounterEpoch: {
      epochId: string
      epochNumber: number
    }
  }
  startsAt: Date
  endsAt: Date
  revokeEffectiveAt?: Date
  lifecycleState:
    | 'scheduled'
    | 'active'
    | 'suspended_paid'
    | 'expired'
    | 'revoked'
    | 'review'
  planKey: 'plus' | 'pro'
  periodKey: string
  catalogVersion: string
  catalogContentHash: string
  interviewLimitSnapshot: number
  premiumResumeLimitSnapshot: number
  interviewsUsed: number
  premiumResumesUsed: number
}

interface AdminInterviewAuthorityRow {
  _id: mongoose.Types.ObjectId
  grantId: string
  grantVersion: number
  startsAt: Date
  endsAt: Date
  interviewState: 'available' | 'restored'
  maxDurationMinutes: 30
  consumedSessionId?: mongoose.Types.ObjectId
  consumedUsageId?: mongoose.Types.ObjectId
  consumedAt?: Date
  restorationId?: mongoose.Types.ObjectId
  restoredAt?: Date
  createdAt: Date
}

interface UsageRow {
  _id: mongoose.Types.ObjectId
  sessionId: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  source: StoredInterviewUsage['source']
  sourceId: mongoose.Types.ObjectId
  periodKey?: string
  reservedAt: Date
  consumedAt?: Date
  restorationId?: mongoose.Types.ObjectId
  normalizedDurationMinutes: number
  entitlementSnapshot: unknown
  entitlementSnapshotDigest?: string
  authorityEnvelope?: StoredInterviewUsage['authorityEnvelope']
}

function failure(
  code: InterviewSessionEntitlementErrorCode,
  message: string,
  cause?: unknown,
): InterviewSessionEntitlementError {
  return new InterviewSessionEntitlementError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  )
}

function exactObjectId(
  value: unknown,
  label: string,
): mongoose.Types.ObjectId {
  if (
    typeof value !== 'string' ||
    !OBJECT_ID_PATTERN.test(value)
  ) {
    throw failure(
      'invalid_request',
      `${label} must be a canonical ObjectId`,
    )
  }
  return new mongoose.Types.ObjectId(value)
}

function observedNow(provider: (() => Date) | undefined): Date {
  const now = (provider ?? (() => new Date()))()
  if (
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime())
  ) {
    throw failure('invalid_request', 'Current time is invalid')
  }
  return new Date(now)
}

function validDate(value: unknown): value is Date {
  return (
    value instanceof Date &&
    Number.isFinite(value.getTime())
  )
}

function safeCounter(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  )
}

function sameDate(left: unknown, right: Date): boolean {
  return validDate(left) && left.getTime() === right.getTime()
}

function storedUsage(row: UsageRow): StoredInterviewUsage {
  return {
    id: row._id,
    sessionId: row.sessionId,
    userId: row.userId,
    source: row.source,
    sourceId: row.sourceId,
    periodKey: row.periodKey,
    reservedAt: row.reservedAt,
    consumedAt: row.consumedAt,
    restorationId: row.restorationId,
    normalizedDurationMinutes:
      row.normalizedDurationMinutes,
    entitlementSnapshot: row.entitlementSnapshot,
    entitlementSnapshotDigest:
      row.entitlementSnapshotDigest,
    authorityEnvelope: row.authorityEnvelope,
  }
}

function providerModeForUser(
  userId: mongoose.Types.ObjectId,
  qaUserIds: readonly mongoose.Types.ObjectId[],
): ProviderMode {
  return qaUserIds.some((candidate) =>
    candidate.equals(userId),
  )
    ? 'test'
    : 'live'
}

function exactEntitlementVersion(
  user: UserAuthorityRow,
): number {
  if (
    !safeCounter(user.entitlementVersion) ||
    user.entitlementVersion < 1
  ) {
    throw failure(
      'authority_review',
      'Interview entitlement projection is not initialized',
    )
  }
  return user.entitlementVersion
}

function basicAuthority(
  user: UserAuthorityRow,
  period: ReturnType<typeof basicCalendarMonthPeriod>,
): BasicCalendarMonthAuthority {
  const entitlementVersion = exactEntitlementVersion(user)
  if (
    user.plan !== 'free' ||
    user.planVocabularyVersion !== 2 ||
    user.entitlementSource !== 'free' ||
    user.planExpiresAt !== undefined ||
    user.usagePeriodKey !== period.key ||
    !safeCounter(user.interviewsUsed) ||
    user.interviewLimit !== 1 ||
    user.interviewsUsed > user.interviewLimit ||
    !sameDate(user.usageResetAt, period.end) ||
    user.buyerState === 'deletion_pending' ||
    user.deletionPendingAt !== undefined
  ) {
    throw failure(
      'authority_review',
      'Basic interview entitlement authority is inconsistent',
    )
  }
  return {
    kind: 'basic_calendar_month',
    entitlementSource: 'free',
    activePaidCycleState: 'none',
    usagePeriodKey: period.key,
    interviewsUsed: user.interviewsUsed,
    interviewLimit: 1,
    usageResetAt: period.end,
    entitlementVersion,
  }
}

function paidAuthority(
  user: UserAuthorityRow,
  subscription: SubscriptionAuthorityRow,
  cycle: SubscriptionCycleAuthorityRow,
  providerMode: ProviderMode,
  now: Date,
): ActivePaidCycleAuthority {
  const entitlementVersion = exactEntitlementVersion(user)
  const capturedLimit = cycle.interviewLimitSnapshot
  if (
    subscription.providerMode !== providerMode ||
    !ACTIVE_CYCLE_SUBSCRIPTION_STATUSES.has(
      subscription.status,
    ) ||
    !subscription.currentPeriodKey ||
    !validDate(subscription.currentPeriodStart) ||
    !validDate(subscription.currentPeriodEnd) ||
    subscription.currentPeriodStart > now ||
    subscription.currentPeriodEnd <= now ||
    cycle.providerMode !== providerMode ||
    !cycle.subscriptionId.equals(subscription._id) ||
    cycle.planKey !== subscription.planKey ||
    cycle.catalogVersion !== subscription.catalogVersion ||
    cycle.periodKey !== subscription.currentPeriodKey ||
    !sameDate(cycle.periodStart, subscription.currentPeriodStart) ||
    !sameDate(cycle.periodEnd, subscription.currentPeriodEnd) ||
    !safeCounter(capturedLimit) ||
    capturedLimit < 1 ||
    cycle.fulfillmentStatus !== 'captured' ||
    cycle.projectionDisposition !== 'projected' ||
    user.plan !== subscription.planKey ||
    user.planVocabularyVersion !== 2 ||
    user.entitlementSource !== 'subscription' ||
    user.usagePeriodKey !== cycle.periodKey ||
    !sameDate(user.planExpiresAt, cycle.periodEnd) ||
    !sameDate(user.usageResetAt, cycle.periodEnd) ||
    !safeCounter(user.interviewsUsed) ||
    user.interviewLimit !== capturedLimit ||
    user.interviewsUsed > user.interviewLimit ||
    user.buyerState === 'deletion_pending' ||
    user.deletionPendingAt !== undefined
  ) {
    throw failure(
      'authority_review',
      'Paid interview entitlement authority is inconsistent',
    )
  }
  return {
    kind: 'active_paid_cycle',
    entitlementSource: 'subscription',
    providerMode,
    cycleId: cycle._id.toHexString(),
    subscriptionId: subscription._id.toHexString(),
    razorpaySubscriptionId:
      subscription.razorpaySubscriptionId,
    planKey: subscription.planKey,
    catalogVersion: subscription.catalogVersion,
    periodKey: cycle.periodKey,
    periodStart: new Date(cycle.periodStart),
    periodEnd: new Date(cycle.periodEnd),
    interviewsUsed: user.interviewsUsed,
    interviewLimit: capturedLimit,
    maxDurationMinutes: 30,
    entitlementVersion,
  }
}

function assertSubscriptionGraceProjection(
  user: UserAuthorityRow,
  subscription: SubscriptionAuthorityRow,
): void {
  exactEntitlementVersion(user)
  if (
    subscription.status !== 'pending' ||
    !subscription.currentPeriodKey ||
    !validDate(subscription.currentPeriodStart) ||
    !validDate(subscription.currentPeriodEnd) ||
    user.plan !== subscription.planKey ||
    user.planVocabularyVersion !== 2 ||
    user.entitlementSource !== 'subscription' ||
    user.usagePeriodKey !== subscription.currentPeriodKey ||
    !sameDate(user.planExpiresAt, subscription.currentPeriodEnd) ||
    !sameDate(user.usageResetAt, subscription.currentPeriodEnd) ||
    !safeCounter(user.interviewsUsed) ||
    !safeCounter(user.interviewLimit) ||
    user.interviewsUsed > user.interviewLimit ||
    user.buyerState === 'deletion_pending' ||
    user.deletionPendingAt !== undefined
  ) {
    throw failure(
      'authority_review',
      'Subscription grace User projection is inconsistent',
    )
  }
}

function adminCompAuthority(
  user: UserAuthorityRow,
  projection: AdminCompAuthorityRow,
  now: Date,
): AdminCompPeriodAuthority {
  const entitlementVersion = exactEntitlementVersion(user)
  const authority = user.entitlementAuthority
  const interviewEpoch =
    projection.authorityEnvelope?.interviewCounterEpoch
  const resumeEpoch =
    projection.authorityEnvelope?.premiumResumeCounterEpoch
  if (
    projection.kind !== 'comp_period' ||
    projection.lifecycleState !== 'active' ||
    projection.startsAt > now ||
    projection.endsAt <= now ||
    (
      projection.revokeEffectiveAt !== undefined &&
      projection.revokeEffectiveAt <= now
    ) ||
    projection.periodKey !==
      `admin-comp:${projection.grantId}` ||
    !safeCounter(projection.interviewsUsed) ||
    !safeCounter(projection.interviewLimitSnapshot) ||
    projection.interviewsUsed >
      projection.interviewLimitSnapshot ||
    !safeCounter(projection.premiumResumesUsed) ||
    !safeCounter(projection.premiumResumeLimitSnapshot) ||
    projection.premiumResumesUsed >
      projection.premiumResumeLimitSnapshot ||
    projection.authorityEnvelope?.version !== 1 ||
    !interviewEpoch ||
    !resumeEpoch ||
    user.plan !== projection.planKey ||
    user.planVocabularyVersion !== 2 ||
    user.entitlementSource !== 'admin_grant' ||
    user.usagePeriodKey !== projection.periodKey ||
    !sameDate(user.planExpiresAt, projection.endsAt) ||
    !sameDate(user.usageResetAt, projection.endsAt) ||
    user.interviewsUsed !== projection.interviewsUsed ||
    user.interviewLimit !==
      projection.interviewLimitSnapshot ||
    user.premiumResumesUsed !== projection.premiumResumesUsed ||
    user.premiumResumeLimit !==
      projection.premiumResumeLimitSnapshot ||
    authority?.version !== 1 ||
    authority.adminGrantId !== projection.grantId ||
    !authority.adminCompPeriodId?.equals(projection._id) ||
    authority.interviewCounterEpoch.epochId !==
      interviewEpoch.epochId ||
    authority.interviewCounterEpoch.epochNumber !==
      interviewEpoch.epochNumber ||
    authority.premiumResumeCounterEpoch.epochId !==
      resumeEpoch.epochId ||
    authority.premiumResumeCounterEpoch.epochNumber !==
      resumeEpoch.epochNumber
  ) {
    throw failure(
      'authority_review',
      'Admin comp interview authority is inconsistent',
    )
  }
  return {
    kind: 'admin_comp_period',
    entitlementSource: 'admin_grant',
    projectionId: projection._id.toHexString(),
    grantId: projection.grantId,
    grantVersion: projection.grantVersion,
    planKey: projection.planKey,
    catalogVersion: projection.catalogVersion,
    catalogContentHash: projection.catalogContentHash,
    periodKey: projection.periodKey,
    periodStart: new Date(projection.startsAt),
    periodEnd: new Date(projection.endsAt),
    interviewsUsed: projection.interviewsUsed,
    interviewLimit: projection.interviewLimitSnapshot,
    maxDurationMinutes: 30,
    entitlementVersion,
    counterEpoch: { ...interviewEpoch },
  }
}

async function loadMongoAuthority(
  input: {
    userId: mongoose.Types.ObjectId
    now: Date
    interviewType: string
  },
  session: ClientSession,
  options: {
    transitionBasicProjection: boolean
    subscriptionGracePort?:
      SubscriptionGraceInterviewEntitlementPort
  } = { transitionBasicProjection: true },
): Promise<InterviewSessionEntitlementAuthority> {
  const configs = await BillingConfig.find({
    key: 'singleton',
  })
    .select('qaUserIds')
    .limit(2)
    .session(session)
    .lean<Array<{
      qaUserIds?: mongoose.Types.ObjectId[]
    }>>()
  if (configs.length !== 1) {
    throw failure(
      'authority_review',
      'Billing provider authority is unavailable',
    )
  }
  const config = configs[0]
  const initialUser = await User.findOne({
    _id: input.userId,
    buyerState: { $ne: 'deletion_pending' },
    deletionPendingAt: { $exists: false },
  })
    .select(
      'plan planVocabularyVersion planExpiresAt ' +
        'entitlementSource usagePeriodKey interviewsUsed ' +
        'interviewLimit premiumResumesUsed premiumResumeLimit ' +
        'usageResetAt entitlementVersion buyerState deletionPendingAt ' +
        'entitlementAuthority',
    )
    .session(session)
    .lean<UserAuthorityRow>()
  if (!initialUser) {
    throw failure(
      'authority_review',
      'Interview entitlement user authority is unavailable',
    )
  }
  const providerMode = providerModeForUser(
    input.userId,
    config.qaUserIds ?? [],
  )
  const cmsInterviewType = await InterviewDepth.findOne({
    slug: input.interviewType,
  })
    .select('slug isActive')
    .session(session)
    .lean<{ slug: string; isActive: boolean }>()
  const fallbackInterviewType = FALLBACK_DEPTHS.some(
    (candidate) =>
      candidate.slug === input.interviewType,
  )
  if (
    cmsInterviewType
      ? (
          cmsInterviewType.slug !== input.interviewType ||
          cmsInterviewType.isActive !== true
        )
      : !fallbackInterviewType
  ) {
    throw failure(
      'authority_review',
      'Interview type is not supported by server authority',
    )
  }
  const currentCycles = await SubscriptionCycle.find({
    userId: input.userId,
    periodStart: { $lte: input.now },
    periodEnd: { $gt: input.now },
  })
    .select(
      'providerMode subscriptionId planKey catalogVersion ' +
        'periodKey periodStart periodEnd interviewLimitSnapshot ' +
        'fulfillmentStatus projectionDisposition',
    )
    .sort({ periodEnd: -1, _id: -1 })
    .limit(2)
    .session(session)
    .lean<SubscriptionCycleAuthorityRow[]>()
  if (currentCycles.length > 1) {
    throw failure(
      'authority_review',
      'Multiple active paid cycles require review',
    )
  }
  const currentComps = await AdminEntitlementProjection.find({
    userId: input.userId,
    kind: 'comp_period',
    startsAt: { $lte: input.now },
    endsAt: { $gt: input.now },
  })
    .select(
      '_id userId grantId kind grantVersion authorityEnvelope ' +
        'startsAt endsAt revokeEffectiveAt lifecycleState planKey ' +
        'periodKey catalogVersion catalogContentHash ' +
        'interviewLimitSnapshot premiumResumeLimitSnapshot ' +
        'interviewsUsed premiumResumesUsed',
    )
    .sort({ endsAt: 1, _id: 1 })
    .limit(2)
    .session(session)
    .lean<AdminCompAuthorityRow[]>()
  if (currentComps.length > 1) {
    throw failure(
      'authority_review',
      'Multiple current admin comp periods require review',
    )
  }

  let user = initialUser
  let includedAuthority: IncludedInterviewAuthority
  const cycle = currentCycles[0]
  const relevantSubscriptions = await Subscription.find({
    userId: input.userId,
    $or: [
      {
        status: {
          $nin: ['cancelled', 'completed', 'expired'],
        },
      },
      {
        currentPeriodStart: { $lte: input.now },
        currentPeriodEnd: { $gt: input.now },
      },
      ...(cycle ? [{ _id: cycle.subscriptionId }] : []),
    ],
  })
    .select(
      'providerMode planKey catalogVersion ' +
        'razorpaySubscriptionId status currentPeriodKey ' +
        'currentPeriodStart currentPeriodEnd',
    )
    .sort({ updatedAt: -1, _id: -1 })
    .session(session)
    .lean<SubscriptionAuthorityRow[]>()
  if (cycle) {
    if (
      currentComps[0] &&
      currentComps[0].lifecycleState !== 'suspended_paid'
    ) {
      throw failure(
        'authority_review',
        'Admin comp authority is not suspended by the paid cycle',
      )
    }
    const matchingSubscriptions =
      relevantSubscriptions.filter(
      (candidate) =>
        candidate._id.equals(cycle.subscriptionId) &&
        candidate.providerMode === providerMode &&
        candidate.planKey === cycle.planKey &&
        candidate.catalogVersion === cycle.catalogVersion &&
        candidate.currentPeriodKey === cycle.periodKey &&
        sameDate(
          candidate.currentPeriodStart,
          cycle.periodStart,
        ) &&
        sameDate(
          candidate.currentPeriodEnd,
          cycle.periodEnd,
        ),
      )
    const conflictingSubscriptions =
      relevantSubscriptions.filter(
        (candidate) =>
          !candidate._id.equals(cycle.subscriptionId) &&
          (
            !TERMINAL_SUBSCRIPTION_STATUSES.has(
              candidate.status,
            ) ||
            (
              validDate(candidate.currentPeriodStart) &&
              validDate(candidate.currentPeriodEnd) &&
              candidate.currentPeriodStart <= input.now &&
              candidate.currentPeriodEnd > input.now
            )
          ),
      )
    if (
      matchingSubscriptions.length !== 1 ||
      conflictingSubscriptions.length > 0
    ) {
      throw failure(
        'authority_review',
        'Active paid cycle subscription authority is ambiguous',
      )
    }
    const subscription = matchingSubscriptions[0]
    if (
      !ACTIVE_CYCLE_SUBSCRIPTION_STATUSES.has(
        subscription.status,
      ) ||
      !/^sub_[A-Za-z0-9]+$/.test(
        subscription.razorpaySubscriptionId,
      )
    ) {
      throw failure(
        'authority_review',
        'Active paid cycle subscription lineage requires review',
      )
    }
    includedAuthority = paidAuthority(
      user,
      subscription,
      cycle,
      providerMode,
      input.now,
    )
  } else {
    const operational = relevantSubscriptions.filter(
      (candidate) =>
        !TERMINAL_SUBSCRIPTION_STATUSES.has(
          candidate.status,
        ),
    )
    const activationPendingOnly =
      operational.length === 1 &&
      ACTIVATION_SUBSCRIPTION_STATUSES.has(
        operational[0].status,
      ) &&
      operational[0].providerMode === providerMode &&
      operational[0].currentPeriodKey === undefined &&
      operational[0].currentPeriodStart === undefined &&
      operational[0].currentPeriodEnd === undefined
    const pendingGraceOnly =
      operational.length === 1 &&
      operational[0].status === 'pending' &&
      operational[0].providerMode === providerMode &&
      validDate(operational[0].currentPeriodStart) &&
      validDate(operational[0].currentPeriodEnd) &&
      operational[0].currentPeriodStart <
        operational[0].currentPeriodEnd &&
      operational[0].currentPeriodEnd <= input.now &&
      typeof operational[0].currentPeriodKey === 'string' &&
      /^sub_[A-Za-z0-9]+$/.test(
        operational[0].razorpaySubscriptionId,
      )
    const comp = currentComps[0]
    if (pendingGraceOnly) {
      const subscription = operational[0]
      if (
        comp &&
        comp.lifecycleState !== 'suspended_paid'
      ) {
        throw failure(
          'authority_review',
          'Subscription grace conflicts with admin compensation',
        )
      }
      assertSubscriptionGraceProjection(user, subscription)
      const grace = await options.subscriptionGracePort
        ?.loadAuthority({
          userId: input.userId.toHexString(),
          providerMode,
          now: new Date(input.now),
          subscriptionId: subscription._id.toHexString(),
          razorpaySubscriptionId:
            subscription.razorpaySubscriptionId,
          planKey: subscription.planKey,
          catalogVersion: subscription.catalogVersion,
          paidPeriodKey: subscription.currentPeriodKey!,
          paidPeriodStart:
            new Date(subscription.currentPeriodStart!),
          paidPeriodEnd:
            new Date(subscription.currentPeriodEnd!),
        }, session)
      if (
        !grace ||
        grace.kind !== 'subscription_grace' ||
        grace.providerMode !== providerMode ||
        grace.subscriptionId !== subscription._id.toHexString() ||
        grace.razorpaySubscriptionId !==
          subscription.razorpaySubscriptionId ||
        grace.planKey !== subscription.planKey ||
        grace.catalogVersion !== subscription.catalogVersion ||
        grace.paidPeriodKey !== subscription.currentPeriodKey ||
        !sameDate(
          grace.paidPeriodStart,
          subscription.currentPeriodStart!,
        ) ||
        !sameDate(
          grace.paidPeriodEnd,
          subscription.currentPeriodEnd!,
        )
      ) {
        throw failure(
          'authority_review',
          'Subscription grace authority is unavailable',
        )
      }
      includedAuthority = grace
    } else {
      if (
        (
          operational.length > 0 &&
          !activationPendingOnly
        ) ||
        relevantSubscriptions.some(
          (candidate) =>
            validDate(candidate.currentPeriodStart) &&
            validDate(candidate.currentPeriodEnd) &&
            candidate.currentPeriodStart <= input.now &&
            candidate.currentPeriodEnd > input.now,
        )
      ) {
        throw failure(
          'authority_review',
          'Subscription state without an active paid cycle requires review',
        )
      }
      if (comp) {
        includedAuthority = adminCompAuthority(
          user,
          comp,
          input.now,
        )
      } else {
        if (user.entitlementSource === 'admin_grant') {
          throw failure(
            'authority_review',
            'Admin comp User authority has no current projection',
          )
        }
        const readProjection =
          projectBasicCalendarMonthEntitlementReadOnly({
            userId: input.userId.toHexString(),
            row: user,
            now: input.now,
          })
        if (
          readProjection.transitionRequired &&
          options.transitionBasicProjection
        ) {
          const transitioned =
            await transitionBasicCalendarMonthEntitlementInSession(
              { userId: input.userId.toHexString() },
              {
                session,
                claimedUserId: input.userId,
                noActivePaidCycleConfirmed: true,
              },
            )
          user = {
            ...user,
            usagePeriodKey: transitioned.usagePeriodKey,
            interviewsUsed: transitioned.interviewsUsed,
            interviewLimit: transitioned.interviewLimit,
            usageResetAt: transitioned.usageResetAt,
            entitlementVersion:
              transitioned.entitlementVersion,
          }
        } else {
          user = {
            ...user,
            usagePeriodKey: readProjection.usagePeriodKey,
            interviewsUsed: readProjection.interviewsUsed,
            interviewLimit: readProjection.interviewLimit,
            usageResetAt: readProjection.usageResetAt,
            entitlementVersion:
              readProjection.entitlementVersion,
          }
        }
        const period = basicCalendarMonthPeriod(input.now)
        includedAuthority = basicAuthority(user, period)
      }
    }
  }

  const unlocks = await PaidInterviewUnlock.find({
    userId: input.userId,
    providerMode,
    status: { $in: ['available', 'restored'] },
    maxDurationMinutes: 30,
    validUntil: { $gt: input.now },
  })
    .select(
      '_id providerMode status maxDurationMinutes ' +
        'validUntil createdAt',
    )
    .sort({ validUntil: 1, createdAt: 1, _id: 1 })
    .limit(
      MAX_INTERVIEW_ENTITLEMENT_UNLOCK_CANDIDATES + 1,
    )
    .session(session)
    .lean<Array<{
      _id: mongoose.Types.ObjectId
      providerMode: ProviderMode
      status: 'available' | 'restored'
      maxDurationMinutes: 30
      validUntil: Date
      createdAt: Date
    }>>()
  if (
    unlocks.length >
      MAX_INTERVIEW_ENTITLEMENT_UNLOCK_CANDIDATES
  ) {
    throw failure(
      'authority_review',
      'Paid interview unlock authority exceeds the review bound',
    )
  }
  const adminGrants = await AdminEntitlementProjection.find({
    userId: input.userId,
    kind: 'interview',
    lifecycleState: 'active',
    startsAt: { $lte: input.now },
    endsAt: { $gt: input.now },
    $or: [
      { revokeEffectiveAt: { $exists: false } },
      { revokeEffectiveAt: { $gt: input.now } },
    ],
    quantity: 1,
    interviewTypeScope: 'any',
    maxDurationMinutes: 30,
    interviewState: { $in: ['available', 'restored'] },
    'authorityEnvelope.version': 1,
    'authorityEnvelope.interviewCounterEpoch': {
      $exists: false,
    },
    'authorityEnvelope.premiumResumeCounterEpoch': {
      $exists: false,
    },
  })
    .select(
      '_id grantId grantVersion startsAt endsAt interviewState ' +
        'maxDurationMinutes consumedSessionId consumedUsageId ' +
        'consumedAt restorationId restoredAt createdAt',
    )
    .sort({ endsAt: 1, createdAt: 1, _id: 1 })
    .limit(MAX_ADMIN_INTERVIEW_GRANT_CANDIDATES + 1)
    .session(session)
    .lean<AdminInterviewAuthorityRow[]>()
  if (
    adminGrants.length >
      MAX_ADMIN_INTERVIEW_GRANT_CANDIDATES
  ) {
    throw failure(
      'authority_review',
      'Admin interview authority exceeds the review bound',
    )
  }

  return {
    providerMode,
    interviewTypeAuthority: {
      interviewType: input.interviewType,
      supported: true,
    },
    includedAuthority,
    paidInterviewUnlocks: unlocks.map((unlock) => ({
          unlockId: unlock._id.toHexString(),
          providerMode: unlock.providerMode,
          status: unlock.status,
          maxDurationMinutes: unlock.maxDurationMinutes,
          validUntil: new Date(unlock.validUntil),
          createdAt: new Date(unlock.createdAt),
        })),
    adminInterviewGrants: adminGrants.map((grant) => ({
      projectionId: grant._id.toHexString(),
      grantId: grant.grantId,
      grantVersion: grant.grantVersion,
      interviewState: grant.interviewState,
      maxDurationMinutes: grant.maxDurationMinutes,
      startsAt: new Date(grant.startsAt),
      endsAt: new Date(grant.endsAt),
      createdAt: new Date(grant.createdAt),
      ...(grant.consumedSessionId
        ? {
            consumedSessionId:
              grant.consumedSessionId.toHexString(),
          }
        : {}),
      ...(grant.consumedUsageId
        ? {
            consumedUsageId:
              grant.consumedUsageId.toHexString(),
          }
        : {}),
      ...(grant.consumedAt
        ? { consumedAt: new Date(grant.consumedAt) }
        : {}),
      ...(grant.restorationId
        ? {
            restorationId:
              grant.restorationId.toHexString(),
          }
        : {}),
      ...(grant.restoredAt
        ? { restoredAt: new Date(grant.restoredAt) }
        : {}),
    })),
  }
}

function exactReservationUsage(
  usage: StoredInterviewUsage,
  input: {
    userId: mongoose.Types.ObjectId
    sessionId: mongoose.Types.ObjectId
    decision: InterviewEntitlementReservationDecision
  },
): void {
  const reservation = input.decision.reservation
  const snapshot = reservation.entitlementSnapshot
  const expectedEnvelope =
    snapshot.source === 'admin'
      ? {
          version: 1 as const,
          adminGrantId: snapshot.grantId,
          ...(snapshot.adminGrantKind === 'comp_period'
            ? { counterEpoch: snapshot.counterEpoch }
            : {}),
        }
      : undefined
  if (
    !usage.userId.equals(input.userId) ||
    !usage.sessionId.equals(input.sessionId) ||
    usage.source !== reservation.source ||
    usage.sourceId.toHexString() !== reservation.sourceId ||
    usage.periodKey !== reservation.periodKey ||
    usage.normalizedDurationMinutes !==
      reservation.normalizedDurationMinutes ||
    !validDate(usage.reservedAt) ||
    (
      reservation.source === 'paid_interview' ||
      reservation.source === 'subscription_grace'
        ? usage.consumedAt !== undefined
        : !sameDate(usage.consumedAt, usage.reservedAt)
    ) ||
    usage.restorationId !== undefined ||
    usage.entitlementSnapshotDigest !==
      sha256CanonicalJson(
        reservation.entitlementSnapshot,
      ) ||
    canonicalJson(usage.authorityEnvelope) !==
      canonicalJson(expectedEnvelope) ||
    canonicalJson(usage.entitlementSnapshot) !==
      canonicalJson(reservation.entitlementSnapshot)
  ) {
    throw failure(
      'reservation_conflict',
      'Persisted interview usage does not match the decision',
    )
  }
}

async function reserveMongoDecision(
  input: {
    userId: mongoose.Types.ObjectId
    sessionId: mongoose.Types.ObjectId
    now: Date
    providerMode: ProviderMode
    decision: InterviewEntitlementReservationDecision
  },
  session: ClientSession,
  subscriptionGracePort?:
    SubscriptionGraceInterviewEntitlementPort,
): Promise<StoredInterviewUsage> {
  const { reservation } = input.decision
  const snapshot = reservation.entitlementSnapshot
  const usageId = new mongoose.Types.ObjectId()
  let authorityEnvelope:
    StoredInterviewUsage['authorityEnvelope']

  if (
    reservation.source === 'free_period' ||
    reservation.source === 'subscription_cycle'
  ) {
    if (
      snapshot.source !== reservation.source ||
      snapshot.entitlementVersion < 1
    ) {
      throw failure(
        'reservation_conflict',
        'Included entitlement snapshot is inconsistent',
      )
    }
    const updated =
      await findAndCommitUserEntitlementProjectionUpdateInSession(
      'interview_reservation',
      {
        _id: input.userId,
        buyerState: { $ne: 'deletion_pending' },
        deletionPendingAt: { $exists: false },
        entitlementVersion:
          snapshot.entitlementVersion,
        entitlementSource: snapshot.entitlementSource,
        usagePeriodKey: snapshot.periodKey,
        interviewsUsed: snapshot.interviewsUsedBefore,
        interviewLimit: snapshot.interviewLimit,
        usageResetAt: new Date(snapshot.periodEnd),
        $expr: {
          $lt: ['$interviewsUsed', '$interviewLimit'],
        },
      },
      {
        $inc: {
          interviewsUsed: 1,
          entitlementVersion: 1,
          interviewCount: 1,
        },
        $set: { lastInterviewAt: input.now },
      },
      session,
    )
      .select('interviewsUsed entitlementVersion')
      .lean<{
        interviewsUsed: number
        entitlementVersion: number
      }>()
    if (
      !updated ||
      updated.interviewsUsed !==
        snapshot.interviewsUsedBefore + 1 ||
      updated.entitlementVersion !==
        snapshot.entitlementVersion + 1
    ) {
      throw failure(
        'reservation_conflict',
        'Included interview allowance changed concurrently',
      )
    }
  } else if (reservation.source === 'subscription_grace') {
    if (
      snapshot.source !== 'subscription_grace' ||
      snapshot.providerMode !== input.providerMode ||
      snapshot.sourceId !== reservation.sourceId ||
      snapshot.grantId !== reservation.sourceId ||
      !subscriptionGracePort
    ) {
      throw failure(
        'reservation_conflict',
        'Subscription grace interview snapshot is inconsistent',
      )
    }
    const reserved = await subscriptionGracePort.reserve({
      userId: input.userId.toHexString(),
      sessionId: input.sessionId.toHexString(),
      usageId: usageId.toHexString(),
      providerMode: input.providerMode,
      occurredAt: new Date(input.now),
      authority: snapshot,
    }, session)
    if (
      reserved.caseId !== snapshot.caseId ||
      reserved.grantId !== snapshot.grantId ||
      reserved.state !== 'reserved' ||
      reserved.reservedSessionId !== input.sessionId.toHexString() ||
      !sameDate(reserved.reservedAt, input.now)
    ) {
      throw failure(
        'reservation_conflict',
        'Subscription grace grant reservation is not exact',
      )
    }
    const touchedUser = await User.updateOne(
      {
        _id: input.userId,
        buyerState: { $ne: 'deletion_pending' },
        deletionPendingAt: { $exists: false },
      },
      {
        $inc: { interviewCount: 1 },
        $set: { lastInterviewAt: input.now },
      },
      { session },
    )
    if (touchedUser.matchedCount !== 1) {
      throw failure(
        'reservation_conflict',
        'Interview user disappeared during grace reservation',
      )
    }
  } else if (reservation.source === 'admin') {
    if (
      snapshot.source !== 'admin' ||
      snapshot.providerMode !== input.providerMode
    ) {
      throw failure(
        'reservation_conflict',
        'Admin interview snapshot is inconsistent',
      )
    }
    authorityEnvelope = {
      version: 1,
      adminGrantId: snapshot.grantId,
      ...(snapshot.adminGrantKind === 'comp_period'
        ? { counterEpoch: snapshot.counterEpoch }
        : {}),
    }
    const projectionId = new mongoose.Types.ObjectId(
      reservation.sourceId,
    )
    if (snapshot.adminGrantKind === 'comp_period') {
      const projection = await AdminEntitlementProjection.updateOne(
        {
          _id: projectionId,
          userId: input.userId,
          kind: 'comp_period',
          grantId: snapshot.grantId,
          grantVersion: snapshot.grantVersion,
          lifecycleState: 'active',
          startsAt: new Date(snapshot.periodStart),
          endsAt: new Date(snapshot.periodEnd),
          $or: [
            { revokeEffectiveAt: { $exists: false } },
            { revokeEffectiveAt: { $gt: input.now } },
          ],
          planKey: snapshot.effectiveTier,
          periodKey: snapshot.periodKey,
          catalogVersion: snapshot.catalogVersion,
          catalogContentHash: snapshot.catalogContentHash,
          interviewLimitSnapshot: snapshot.interviewLimit,
          interviewsUsed: snapshot.interviewsUsedBefore,
          'authorityEnvelope.version': 1,
          'authorityEnvelope.interviewCounterEpoch.epochId':
            snapshot.counterEpoch.epochId,
          'authorityEnvelope.interviewCounterEpoch.epochNumber':
            snapshot.counterEpoch.epochNumber,
        },
        { $inc: { interviewsUsed: 1 } },
        { session, runValidators: true },
      )
      const user =
        await commitUserEntitlementProjectionUpdateInSession(
        'interview_reservation',
        {
          _id: input.userId,
          buyerState: { $ne: 'deletion_pending' },
          deletionPendingAt: { $exists: false },
          plan: snapshot.effectiveTier,
          planVocabularyVersion: 2,
          entitlementSource: 'admin_grant',
          planExpiresAt: new Date(snapshot.periodEnd),
          usagePeriodKey: snapshot.periodKey,
          usageResetAt: new Date(snapshot.periodEnd),
          interviewsUsed: snapshot.interviewsUsedBefore,
          interviewLimit: snapshot.interviewLimit,
          entitlementVersion: snapshot.entitlementVersion,
          'entitlementAuthority.version': 1,
          'entitlementAuthority.adminGrantId': snapshot.grantId,
          'entitlementAuthority.adminCompPeriodId': projectionId,
          'entitlementAuthority.interviewCounterEpoch.epochId':
            snapshot.counterEpoch.epochId,
          'entitlementAuthority.interviewCounterEpoch.epochNumber':
            snapshot.counterEpoch.epochNumber,
        },
        {
          $inc: {
            interviewsUsed: 1,
            entitlementVersion: 1,
            interviewCount: 1,
          },
          $set: { lastInterviewAt: input.now },
        },
        session,
      )
      if (
        projection.matchedCount !== 1 ||
        user.matchedCount !== 1
      ) {
        throw failure(
          'reservation_conflict',
          'Admin comp allowance changed concurrently',
        )
      }
    } else {
      const prior = snapshot.previousConsumption
      const projection =
        await AdminEntitlementProjection.updateOne(
          {
            _id: projectionId,
            userId: input.userId,
            kind: 'interview',
            grantId: snapshot.grantId,
            grantVersion: snapshot.grantVersion,
            lifecycleState: 'active',
            startsAt: new Date(snapshot.startsAt),
            endsAt: new Date(snapshot.endsAt),
            $or: [
              { revokeEffectiveAt: { $exists: false } },
              { revokeEffectiveAt: { $gt: input.now } },
            ],
            quantity: 1,
            interviewTypeScope: 'any',
            maxDurationMinutes: 30,
            interviewState: snapshot.interviewState,
            ...(prior
              ? {
                  consumedSessionId:
                    new mongoose.Types.ObjectId(prior.sessionId),
                  consumedUsageId:
                    new mongoose.Types.ObjectId(prior.usageId),
                  consumedAt: new Date(prior.consumedAt),
                  restorationId:
                    new mongoose.Types.ObjectId(prior.restorationId),
                  restoredAt: new Date(prior.restoredAt),
                }
              : {
                  consumedSessionId: { $exists: false },
                  consumedUsageId: { $exists: false },
                  consumedAt: { $exists: false },
                  restorationId: { $exists: false },
                  restoredAt: { $exists: false },
                }),
          },
          {
            $set: {
              interviewState: 'consumed',
              consumedSessionId: input.sessionId,
              consumedUsageId: usageId,
              consumedAt: input.now,
            },
            $unset: { restorationId: 1, restoredAt: 1 },
          },
          { session, runValidators: true },
        )
      const user = await User.updateOne(
        {
          _id: input.userId,
          buyerState: { $ne: 'deletion_pending' },
          deletionPendingAt: { $exists: false },
        },
        {
          $inc: { interviewCount: 1 },
          $set: { lastInterviewAt: input.now },
        },
        { session },
      )
      if (
        projection.matchedCount !== 1 ||
        user.matchedCount !== 1
      ) {
        throw failure(
          'reservation_conflict',
          'Admin interview grant changed concurrently',
        )
      }
    }
  } else {
    if (
      snapshot.source !== 'paid_interview' ||
      snapshot.providerMode !== input.providerMode
    ) {
      throw failure(
        'reservation_conflict',
        'Paid interview snapshot is inconsistent',
      )
    }
    const unlockId = new mongoose.Types.ObjectId(
      reservation.sourceId,
    )
    const unlock = await PaidInterviewUnlock.findOneAndUpdate(
      {
        _id: unlockId,
        userId: input.userId,
        providerMode: input.providerMode,
        status: snapshot.unlockStatus,
        maxDurationMinutes: 30,
        validUntil: new Date(snapshot.validUntil),
        createdAt: new Date(snapshot.createdAt),
      },
      {
        $set: {
          status: 'reserved',
          reservedSessionId: input.sessionId,
          reservedAt: input.now,
        },
        $unset: {
          consumedSessionId: 1,
          consumedAt: 1,
        },
      },
      {
        new: true,
        runValidators: true,
        session,
      },
    )
      .select(
        '_id status reservedSessionId consumedSessionId ' +
          'reservedAt consumedAt',
      )
      .lean<{
        _id: mongoose.Types.ObjectId
        status: string
        reservedSessionId?: mongoose.Types.ObjectId
        consumedSessionId?: mongoose.Types.ObjectId
        reservedAt?: Date
        consumedAt?: Date
      }>()
    if (
      !unlock ||
      unlock.status !== 'reserved' ||
      !unlock.reservedSessionId?.equals(input.sessionId) ||
      !sameDate(unlock.reservedAt, input.now) ||
      unlock.consumedSessionId !== undefined ||
      unlock.consumedAt !== undefined
    ) {
      throw failure(
        'reservation_conflict',
        'Paid interview unlock changed concurrently',
      )
    }
    const touchedUser = await User.updateOne(
      {
        _id: input.userId,
        buyerState: { $ne: 'deletion_pending' },
        deletionPendingAt: { $exists: false },
      },
      {
        $inc: { interviewCount: 1 },
        $set: { lastInterviewAt: input.now },
      },
      { session },
    )
    if (touchedUser.matchedCount !== 1) {
      throw failure(
        'reservation_conflict',
        'Interview user disappeared during reservation',
      )
    }
  }

  const [created] = await InterviewUsage.create([{
    _id: usageId,
    sessionId: input.sessionId,
    userId: input.userId,
    source: reservation.source,
    sourceId: new mongoose.Types.ObjectId(
      reservation.sourceId,
    ),
    ...(reservation.periodKey
      ? { periodKey: reservation.periodKey }
      : {}),
    reservedAt: input.now,
    ...(
      reservation.source === 'paid_interview' ||
      reservation.source === 'subscription_grace'
      ? {}
      : { consumedAt: input.now }
    ),
    normalizedDurationMinutes:
      reservation.normalizedDurationMinutes,
    entitlementSnapshot:
      reservation.entitlementSnapshot,
    entitlementSnapshotDigest:
      sha256CanonicalJson(
        reservation.entitlementSnapshot,
      ),
    ...(authorityEnvelope ? { authorityEnvelope } : {}),
  }], { session })
  const usage = storedUsage(
    created.toObject() as unknown as UsageRow,
  )
  exactReservationUsage(usage, {
    userId: input.userId,
    sessionId: input.sessionId,
    decision: input.decision,
  })
  return usage
}

export const mongoInterviewSessionEntitlementStore:
  InterviewSessionEntitlementStore = {
    async assertUserActive(userId, session) {
      const user = await User.findOne({
        _id: userId,
        buyerState: { $ne: 'deletion_pending' },
        deletionPendingAt: { $exists: false },
      })
        .select('_id')
        .session(session)
        .lean<{ _id: mongoose.Types.ObjectId }>()
      if (!user?._id.equals(userId)) {
        throw failure(
          'authority_review',
          'Interview entitlement user claim is unavailable',
        )
      }
    },
    async findUsageBySession(sessionId, session) {
      const row = await InterviewUsage.findOne({ sessionId })
        .session(session)
        .lean<UsageRow>()
      return row ? storedUsage(row) : null
    },
    loadAuthority: (input, session) =>
      loadMongoAuthority(
        input,
        session,
        { transitionBasicProjection: true },
      ),
    reserve: reserveMongoDecision,
  }

async function readMongoAuthoritySnapshot(input: {
  userId: mongoose.Types.ObjectId
  now: Date
  interviewType: string
}, subscriptionGracePort?:
  SubscriptionGraceInterviewEntitlementPort): Promise<
  InterviewSessionEntitlementAuthority
> {
  await connectDB()
  const session = await mongoose.startSession()
  try {
    let authority:
      | InterviewSessionEntitlementAuthority
      | undefined
    await session.withTransaction(async () => {
      authority = await loadMongoAuthority(
        input,
        session,
        {
          transitionBasicProjection: false,
          subscriptionGracePort,
        },
      )
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary',
    })
    if (!authority) {
      throw failure(
        'authority_review',
        'Interview authority snapshot was unavailable',
      )
    }
    return authority
  } finally {
    await session.endSession()
  }
}

/**
 * Read-only preflight classifier. It shares the production authority loader
 * and decision kernel with atomic session creation, but virtualizes a safe
 * dormant-Basic month transition instead of writing the User projection.
 */
export async function resolveInterviewSessionEntitlementReadOnly(
  rawInput: Omit<InterviewSessionEntitlementInput, 'sessionId'>,
  dependencies:
  InterviewSessionEntitlementReadDependencies = {},
): Promise<InterviewSessionEntitlementReadResult> {
  const hasTestOverrides = (
    dependencies.decisionReady !== undefined ||
    dependencies.readAuthority !== undefined ||
    dependencies.decide !== undefined
  )
  if (
    hasTestOverrides &&
    process.env.NODE_ENV !== 'test'
  ) {
    throw failure(
      'invalid_request',
      'Interview preflight overrides are test-only',
    )
  }
  if (
    (dependencies.decisionReady ??
      PR8_INTERVIEW_ENTITLEMENT_DECISION_READY) !== true
  ) {
    throw failure(
      'not_ready',
      'Authoritative interview preflight is not ready',
    )
  }
  const userId = exactObjectId(rawInput.userId, 'userId')
  const now = observedNow(dependencies.now)
  const readAuthority = dependencies.readAuthority ?? (
    (input: {
      userId: mongoose.Types.ObjectId
      now: Date
      interviewType: string
    }) => readMongoAuthoritySnapshot(
      input,
      dependencies.subscriptionGracePort,
    )
  )
  const authority = await readAuthority({
    userId,
    now,
    interviewType: rawInput.interviewType,
  })
  if (
    authority.interviewTypeAuthority.supported !== true ||
    authority.interviewTypeAuthority.interviewType !==
      rawInput.interviewType
  ) {
    throw failure(
      'authority_review',
      'Interview type authority does not match the request',
    )
  }
  const decision = (
    dependencies.decide ??
    decideAuthoritativeInterviewEntitlement
  )({
    userId: rawInput.userId,
    providerMode: authority.providerMode,
    now,
    configuration: {
      interviewType: rawInput.interviewType,
      interviewTypeSupported: true,
      durationMinutes: rawInput.durationMinutes,
    },
    includedAuthority:
      authority.includedAuthority,
    paidInterviewUnlocks:
      authority.paidInterviewUnlocks,
    adminInterviewGrants:
      authority.adminInterviewGrants,
  })
  return { authority, decision }
}

function snapshotRecord(
  value: unknown,
): Record<string, unknown> | null {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  )
    ? value as Record<string, unknown>
    : null
}

function exactIsoString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const parsed = new Date(value)
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString() === value
  )
    ? value
    : null
}

function exactRecordKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(record).sort()
  const normalizedExpected = [...expected].sort()
  return (
    actual.length === normalizedExpected.length &&
    actual.every(
      (key, index) => key === normalizedExpected[index],
    )
  )
}

const SNAPSHOT_BASE_KEYS = [
  'schemaVersion',
  'policyVersion',
  'decidedAt',
  'userId',
  'providerMode',
  'interviewType',
  'normalizedDurationMinutes',
  'normalizedDurationSeconds',
  'source',
  'sourceId',
] as const

interface StrictReplaySnapshot {
  snapshot: Readonly<InterviewUsageEntitlementSnapshot>
  source:
    | 'free_period'
    | 'subscription_cycle'
    | 'subscription_grace'
    | 'paid_interview'
    | 'admin'
  sourceId: string
  providerMode: ProviderMode
  effectiveTier: 'basic' | 'plus' | 'pro'
  periodKey?: string
  expiresAt: string
}

function strictReplaySnapshot(
  usage: StoredInterviewUsage,
  input: InterviewSessionEntitlementInput,
  normalized: ReturnType<
    typeof normalizeInterviewEntitlementConfiguration
  >,
): StrictReplaySnapshot | null {
  const snapshot = snapshotRecord(
    usage.entitlementSnapshot,
  )
  const decidedAtIso = exactIsoString(
    snapshot?.decidedAt,
  )
  const decidedAt = decidedAtIso
    ? new Date(decidedAtIso)
    : null
  const currentPolicy = (
    snapshot?.schemaVersion ===
      INTERVIEW_ENTITLEMENT_DECISION_SCHEMA_VERSION &&
    snapshot.policyVersion ===
      INTERVIEW_ENTITLEMENT_DECISION_POLICY_VERSION
  )
  const legacyPolicy = (
    snapshot?.schemaVersion ===
      LEGACY_INTERVIEW_ENTITLEMENT_DECISION_SCHEMA_VERSION &&
    snapshot.policyVersion ===
      LEGACY_INTERVIEW_ENTITLEMENT_DECISION_POLICY_VERSION
  )
  if (
    !snapshot ||
    !decidedAt ||
    decidedAt.getTime() !== usage.reservedAt.getTime() ||
    (!currentPolicy && !legacyPolicy) ||
    snapshot.userId !== input.userId ||
    (
      snapshot.providerMode !== 'test' &&
      snapshot.providerMode !== 'live'
    ) ||
    snapshot.interviewType !== normalized.interviewType ||
    snapshot.normalizedDurationMinutes !==
      normalized.durationMinutes ||
    snapshot.normalizedDurationSeconds !==
      normalized.durationSeconds ||
    snapshot.source !== usage.source ||
    snapshot.sourceId !== usage.sourceId.toHexString() ||
    usage.normalizedDurationMinutes !==
      normalized.durationMinutes ||
    usage.entitlementSnapshotDigest !==
      sha256CanonicalJson(snapshot)
  ) {
    return null
  }

  if (snapshot.source === 'free_period') {
    if (
      !exactRecordKeys(snapshot, [
        ...SNAPSHOT_BASE_KEYS,
        'activePaidCycleState',
        'entitlementSource',
        'effectiveTier',
        'periodKey',
        'periodStart',
        'periodEnd',
        'interviewLimit',
        'interviewsUsedBefore',
        'interviewsRemainingBefore',
        'maxDurationMinutes',
        'entitlementVersion',
      ]) ||
      snapshot.sourceId !== input.userId ||
      snapshot.activePaidCycleState !== 'none' ||
      snapshot.entitlementSource !== 'free' ||
      snapshot.effectiveTier !== 'basic' ||
      snapshot.interviewLimit !== 1 ||
      snapshot.interviewsUsedBefore !== 0 ||
      snapshot.interviewsRemainingBefore !== 1 ||
      snapshot.maxDurationMinutes !== 10 ||
      !safeCounter(snapshot.entitlementVersion) ||
      snapshot.entitlementVersion < 1
    ) {
      return null
    }
    const periodStart = exactIsoString(
      snapshot.periodStart,
    )
    const periodEnd = exactIsoString(snapshot.periodEnd)
    const period = basicCalendarMonthPeriod(decidedAt)
    if (
      snapshot.periodKey !== period.key ||
      periodStart !== period.start.toISOString() ||
      periodEnd !== period.end.toISOString() ||
      usage.periodKey !== snapshot.periodKey ||
      !sameDate(usage.consumedAt, usage.reservedAt)
    ) {
      return null
    }
    return {
      snapshot:
        snapshot as unknown as Readonly<
          InterviewUsageEntitlementSnapshot
        >,
      source: 'free_period',
      sourceId: snapshot.sourceId,
      providerMode: snapshot.providerMode,
      effectiveTier: 'basic',
      periodKey: snapshot.periodKey,
      expiresAt: periodEnd,
    }
  }

  if (snapshot.source === 'subscription_cycle') {
    const periodStart = exactIsoString(
      snapshot.periodStart,
    )
    const periodEnd = exactIsoString(snapshot.periodEnd)
    const subscriptionId =
      typeof snapshot.subscriptionId === 'string' &&
      OBJECT_ID_PATTERN.test(snapshot.subscriptionId)
        ? snapshot.subscriptionId
        : null
    const expectedPeriodKey =
      periodStart &&
      periodEnd &&
      typeof snapshot.razorpaySubscriptionId === 'string'
        ? `paid:${snapshot.razorpaySubscriptionId}:${Math.floor(
            new Date(periodStart).getTime() / 1000,
          )}:${Math.floor(
            new Date(periodEnd).getTime() / 1000,
          )}`
        : null
    if (
      !exactRecordKeys(snapshot, [
        ...SNAPSHOT_BASE_KEYS,
        'entitlementSource',
        'effectiveTier',
        'subscriptionId',
        'razorpaySubscriptionId',
        'catalogVersion',
        'periodKey',
        'periodStart',
        'periodEnd',
        'interviewLimit',
        'interviewsUsedBefore',
        'interviewsRemainingBefore',
        'maxDurationMinutes',
        'entitlementVersion',
      ]) ||
      snapshot.entitlementSource !== 'subscription' ||
      (
        snapshot.effectiveTier !== 'plus' &&
        snapshot.effectiveTier !== 'pro'
      ) ||
      !subscriptionId ||
      typeof snapshot.razorpaySubscriptionId !== 'string' ||
      !/^sub_[A-Za-z0-9]+$/.test(
        snapshot.razorpaySubscriptionId,
      ) ||
      typeof snapshot.catalogVersion !== 'string' ||
      snapshot.catalogVersion.length < 1 ||
      snapshot.catalogVersion.length > 100 ||
      snapshot.catalogVersion !==
        snapshot.catalogVersion.trim() ||
      !periodStart ||
      !periodEnd ||
      typeof snapshot.periodKey !== 'string' ||
      new Date(periodStart) > decidedAt ||
      new Date(periodEnd) <= decidedAt ||
      snapshot.periodKey !== expectedPeriodKey ||
      !safeCounter(snapshot.interviewLimit) ||
      snapshot.interviewLimit < 1 ||
      !safeCounter(snapshot.interviewsUsedBefore) ||
      snapshot.interviewsUsedBefore >=
        snapshot.interviewLimit ||
      snapshot.interviewsRemainingBefore !==
        snapshot.interviewLimit -
          snapshot.interviewsUsedBefore ||
      snapshot.maxDurationMinutes !== 30 ||
      !safeCounter(snapshot.entitlementVersion) ||
      snapshot.entitlementVersion < 1 ||
      usage.periodKey !== snapshot.periodKey ||
      !sameDate(usage.consumedAt, usage.reservedAt)
    ) {
      return null
    }
    return {
      snapshot:
        snapshot as unknown as Readonly<
          InterviewUsageEntitlementSnapshot
        >,
      source: 'subscription_cycle',
      sourceId: snapshot.sourceId,
      providerMode: snapshot.providerMode,
      effectiveTier: snapshot.effectiveTier,
      periodKey: snapshot.periodKey,
      expiresAt: periodEnd,
    }
  }

  if (snapshot.source === 'subscription_grace' && currentPolicy) {
    const periodStart = exactIsoString(snapshot.periodStart)
    const periodEnd = exactIsoString(snapshot.periodEnd)
    const graceEndsAt = exactIsoString(snapshot.graceEndsAt)
    const expectedPeriodKey =
      periodStart &&
      periodEnd &&
      typeof snapshot.razorpaySubscriptionId === 'string'
        ? `paid:${snapshot.razorpaySubscriptionId}:${Math.floor(
            new Date(periodStart).getTime() / 1000,
          )}:${Math.floor(
            new Date(periodEnd).getTime() / 1000,
          )}`
        : null
    const availableGrant = snapshot.grantState === 'available'
    if (
      !exactRecordKeys(snapshot, [
        ...SNAPSHOT_BASE_KEYS,
        'entitlementSource',
        'effectiveTier',
        'caseId',
        'caseRevision',
        'statusVersion',
        'grantId',
        'grantRevision',
        'grantState',
        ...(snapshot.grantDigest === undefined
          ? []
          : ['grantDigest']),
        'subscriptionId',
        'razorpaySubscriptionId',
        'catalogVersion',
        'periodKey',
        'periodStart',
        'periodEnd',
        'graceEndsAt',
        'sourceEvidenceDigest',
        'decisionDigest',
        'interviewLimit',
        'interviewsUsedBefore',
        'interviewsRemainingBefore',
        'maxDurationMinutes',
      ]) ||
      snapshot.entitlementSource !== 'subscription_grace' ||
      (
        snapshot.effectiveTier !== 'plus' &&
        snapshot.effectiveTier !== 'pro'
      ) ||
      typeof snapshot.caseId !== 'string' ||
      !OBJECT_ID_PATTERN.test(snapshot.caseId) ||
      !safeCounter(snapshot.caseRevision) ||
      snapshot.caseRevision < 1 ||
      !safeCounter(snapshot.statusVersion) ||
      typeof snapshot.grantId !== 'string' ||
      !OBJECT_ID_PATTERN.test(snapshot.grantId) ||
      snapshot.sourceId !== snapshot.grantId ||
      !safeCounter(snapshot.grantRevision) ||
      (
        snapshot.grantState !== 'not_offered' &&
        snapshot.grantState !== 'available'
      ) ||
      (
        availableGrant
          ? (
              snapshot.grantRevision < 1 ||
              typeof snapshot.grantDigest !== 'string' ||
              !/^[a-f0-9]{64}$/.test(snapshot.grantDigest)
            )
          : (
              snapshot.grantRevision !== 0 ||
              snapshot.grantDigest !== undefined
            )
      ) ||
      typeof snapshot.subscriptionId !== 'string' ||
      !OBJECT_ID_PATTERN.test(snapshot.subscriptionId) ||
      typeof snapshot.razorpaySubscriptionId !== 'string' ||
      !/^sub_[A-Za-z0-9]+$/.test(
        snapshot.razorpaySubscriptionId,
      ) ||
      typeof snapshot.catalogVersion !== 'string' ||
      snapshot.catalogVersion.length < 1 ||
      snapshot.catalogVersion.length > 100 ||
      snapshot.catalogVersion !== snapshot.catalogVersion.trim() ||
      typeof snapshot.periodKey !== 'string' ||
      snapshot.periodKey !== expectedPeriodKey ||
      !periodStart ||
      !periodEnd ||
      !graceEndsAt ||
      new Date(periodStart) >= new Date(periodEnd) ||
      new Date(periodEnd) > decidedAt ||
      new Date(graceEndsAt) <= decidedAt ||
      new Date(graceEndsAt) <= new Date(periodEnd) ||
      new Date(graceEndsAt).getTime() -
        new Date(periodEnd).getTime() > 72 * 60 * 60 * 1_000 ||
      typeof snapshot.sourceEvidenceDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(snapshot.sourceEvidenceDigest) ||
      typeof snapshot.decisionDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(snapshot.decisionDigest) ||
      snapshot.interviewLimit !== 1 ||
      snapshot.interviewsUsedBefore !== 0 ||
      snapshot.interviewsRemainingBefore !== 1 ||
      snapshot.maxDurationMinutes !== 30 ||
      usage.periodKey !== snapshot.periodKey ||
      usage.authorityEnvelope !== undefined ||
      (
        usage.consumedAt !== undefined &&
        (
          !validDate(usage.consumedAt) ||
          usage.consumedAt < usage.reservedAt
        )
      )
    ) {
      return null
    }
    return {
      snapshot: snapshot as unknown as Readonly<
        InterviewUsageEntitlementSnapshot
      >,
      source: 'subscription_grace',
      sourceId: snapshot.sourceId,
      providerMode: snapshot.providerMode,
      effectiveTier: snapshot.effectiveTier,
      periodKey: snapshot.periodKey,
      expiresAt: graceEndsAt,
    }
  }

  if (snapshot.source === 'paid_interview') {
    const createdAt = exactIsoString(snapshot.createdAt)
    const validUntil = exactIsoString(
      snapshot.validUntil,
    )
    if (
      !exactRecordKeys(snapshot, [
        ...SNAPSHOT_BASE_KEYS,
        'entitlementSource',
        'effectiveTier',
        'unlockStatus',
        'validUntil',
        'createdAt',
        'maxDurationMinutes',
      ]) ||
      snapshot.entitlementSource !==
        'one_time_purchase' ||
      (
        snapshot.effectiveTier !== 'basic' &&
        snapshot.effectiveTier !== 'plus' &&
        snapshot.effectiveTier !== 'pro'
      ) ||
      (
        snapshot.unlockStatus !== 'available' &&
        snapshot.unlockStatus !== 'restored'
      ) ||
      !createdAt ||
      !validUntil ||
      new Date(createdAt) > decidedAt ||
      new Date(validUntil) <= decidedAt ||
      new Date(validUntil) <= new Date(createdAt) ||
      snapshot.maxDurationMinutes !== 30 ||
      usage.periodKey !== undefined ||
      (
        usage.consumedAt !== undefined &&
        (
          !validDate(usage.consumedAt) ||
          usage.consumedAt < usage.reservedAt
        )
      )
    ) {
      return null
    }
    return {
      snapshot:
        snapshot as unknown as Readonly<
          InterviewUsageEntitlementSnapshot
        >,
      source: 'paid_interview',
      sourceId: snapshot.sourceId,
      providerMode: snapshot.providerMode,
      effectiveTier: snapshot.effectiveTier,
      expiresAt: validUntil,
    }
  }
  if (snapshot.source === 'admin' && currentPolicy) {
    const startsAt = exactIsoString(
      snapshot.adminGrantKind === 'comp_period'
        ? snapshot.periodStart
        : snapshot.startsAt,
    )
    const endsAt = exactIsoString(
      snapshot.adminGrantKind === 'comp_period'
        ? snapshot.periodEnd
        : snapshot.endsAt,
    )
    const commonValid = (
      typeof snapshot.sourceId === 'string' &&
      OBJECT_ID_PATTERN.test(snapshot.sourceId) &&
      (
        snapshot.adminGrantKind === 'comp_period' ||
        snapshot.adminGrantKind === 'interview'
      ) &&
      typeof snapshot.grantId === 'string' &&
      snapshot.grantId.length >= 8 &&
      snapshot.grantId.length <= 200 &&
      /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(
        snapshot.grantId,
      ) &&
      safeCounter(snapshot.grantVersion) &&
      snapshot.grantVersion >= 1 &&
      startsAt !== null &&
      endsAt !== null &&
      new Date(startsAt) <= decidedAt &&
      new Date(endsAt) > decidedAt &&
      new Date(endsAt).getTime() - new Date(startsAt).getTime() <=
        (snapshot.adminGrantKind === 'comp_period' ? 90 : 30) *
          24 * 60 * 60 * 1_000 &&
      snapshot.maxDurationMinutes === 30 &&
      (
        snapshot.effectiveTier === 'basic' ||
        snapshot.effectiveTier === 'plus' ||
        snapshot.effectiveTier === 'pro'
      )
    )
    if (!commonValid) return null
    if (snapshot.adminGrantKind === 'comp_period') {
      const epoch = snapshotRecord(snapshot.counterEpoch)
      if (
        !exactRecordKeys(snapshot, [
          ...SNAPSHOT_BASE_KEYS,
          'entitlementSource', 'adminGrantKind',
          'effectiveTier', 'grantId', 'grantVersion',
          'catalogVersion', 'catalogContentHash',
          'periodKey', 'periodStart', 'periodEnd',
          'interviewLimit', 'interviewsUsedBefore',
          'interviewsRemainingBefore', 'maxDurationMinutes',
          'entitlementVersion', 'counterEpoch',
        ]) ||
        snapshot.entitlementSource !== 'admin_grant' ||
        snapshot.effectiveTier === 'basic' ||
        typeof snapshot.catalogVersion !== 'string' ||
        snapshot.catalogVersion.length < 1 ||
        snapshot.catalogVersion.length > 100 ||
        snapshot.catalogVersion !== snapshot.catalogVersion.trim() ||
        typeof snapshot.catalogContentHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(snapshot.catalogContentHash) ||
        snapshot.periodKey !== `admin-comp:${snapshot.grantId}` ||
        !safeCounter(snapshot.interviewLimit) ||
        snapshot.interviewLimit < 1 ||
        !safeCounter(snapshot.interviewsUsedBefore) ||
        snapshot.interviewsUsedBefore >= snapshot.interviewLimit ||
        snapshot.interviewsRemainingBefore !==
          snapshot.interviewLimit - snapshot.interviewsUsedBefore ||
        !safeCounter(snapshot.entitlementVersion) ||
        snapshot.entitlementVersion < 1 ||
        !epoch ||
        !exactRecordKeys(epoch, ['epochId', 'epochNumber']) ||
        typeof epoch.epochId !== 'string' ||
        epoch.epochId.length < 8 ||
        epoch.epochId.length > 200 ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(epoch.epochId) ||
        !safeCounter(epoch.epochNumber) ||
        epoch.epochNumber < 1 ||
        usage.periodKey !== snapshot.periodKey ||
        !sameDate(usage.consumedAt, usage.reservedAt) ||
        canonicalJson(usage.authorityEnvelope) !==
          canonicalJson({
            version: 1,
            adminGrantId: snapshot.grantId,
            counterEpoch: snapshot.counterEpoch,
          })
      ) return null
      return {
        snapshot: snapshot as unknown as Readonly<
          InterviewUsageEntitlementSnapshot
        >,
        source: 'admin',
        sourceId: snapshot.sourceId,
        providerMode: snapshot.providerMode,
        effectiveTier: snapshot.effectiveTier as 'plus' | 'pro',
        periodKey: snapshot.periodKey,
        expiresAt: endsAt,
      }
    }
    const previous = snapshot.previousConsumption === undefined
      ? null
      : snapshotRecord(snapshot.previousConsumption)
    const createdAt = exactIsoString(snapshot.createdAt)
    const consumedAt = exactIsoString(previous?.consumedAt)
    const restoredAt = exactIsoString(previous?.restoredAt)
    if (
      !exactRecordKeys(snapshot, [
        ...SNAPSHOT_BASE_KEYS,
        'entitlementSource', 'adminGrantKind',
        'effectiveTier', 'grantId', 'grantVersion',
        'interviewState', 'startsAt', 'endsAt',
        'createdAt', 'maxDurationMinutes',
        ...(previous ? ['previousConsumption'] : []),
      ]) ||
      snapshot.entitlementSource !== 'admin_grant' ||
      (
        snapshot.interviewState !== 'available' &&
        snapshot.interviewState !== 'restored'
      ) ||
      (snapshot.interviewState === 'restored') !== Boolean(previous) ||
      !createdAt ||
      new Date(createdAt) > decidedAt ||
      (
        previous !== null &&
        (
          !exactRecordKeys(previous, [
            'sessionId', 'usageId', 'consumedAt',
            'restorationId', 'restoredAt',
          ]) ||
          !OBJECT_ID_PATTERN.test(String(previous.sessionId)) ||
          !OBJECT_ID_PATTERN.test(String(previous.usageId)) ||
          !OBJECT_ID_PATTERN.test(String(previous.restorationId)) ||
          !consumedAt ||
          !restoredAt ||
          new Date(consumedAt) < new Date(startsAt) ||
          new Date(consumedAt) >= new Date(endsAt) ||
          new Date(restoredAt) < new Date(consumedAt) ||
          new Date(restoredAt) > decidedAt
        )
      ) ||
      usage.periodKey !== undefined ||
      !sameDate(usage.consumedAt, usage.reservedAt) ||
      canonicalJson(usage.authorityEnvelope) !==
        canonicalJson({
          version: 1,
          adminGrantId: snapshot.grantId,
        })
    ) return null
    return {
      snapshot: snapshot as unknown as Readonly<
        InterviewUsageEntitlementSnapshot
      >,
      source: 'admin',
      sourceId: snapshot.sourceId,
      providerMode: snapshot.providerMode,
      effectiveTier: snapshot.effectiveTier as
        'basic' | 'plus' | 'pro',
      expiresAt: endsAt,
    }
  }
  return null
}

function replayResult(
  usage: StoredInterviewUsage,
  input: InterviewSessionEntitlementInput,
): InterviewSessionEntitlementResult {
  const normalized =
    normalizeInterviewEntitlementConfiguration({
      interviewType: input.interviewType,
      // A persisted PR8 snapshot proves that the type was authorized when
      // this exact idempotent session reservation was first created.
      interviewTypeSupported: true,
      durationMinutes: input.durationMinutes,
    })
  const strict = strictReplaySnapshot(
    usage,
    input,
    normalized,
  )
  if (
    !usage.userId.equals(
      exactObjectId(input.userId, 'userId'),
    ) ||
    !usage.sessionId.equals(
      exactObjectId(input.sessionId, 'sessionId'),
    ) ||
    usage.restorationId !== undefined ||
    !strict
  ) {
    throw failure(
      'replay_conflict',
      'Existing interview usage cannot be replayed safely',
    )
  }
  return {
    kind: 'reserved',
    reused: true,
    usageId: usage.id.toHexString(),
    providerMode: strict.providerMode,
    source: strict.source,
    sourceId: strict.sourceId,
    ...(strict.periodKey
      ? { periodKey: strict.periodKey }
      : {}),
    expiresAt: strict.expiresAt,
    effectiveTier: strict.effectiveTier,
    normalizedConfiguration: normalized,
    entitlementSnapshot: strict.snapshot,
  }
}

function reservationResult(
  usage: StoredInterviewUsage,
  providerMode: ProviderMode,
  decision: InterviewEntitlementReservationDecision,
): InterviewSessionEntitlementResult {
  exactReservationUsage(usage, {
    userId: new mongoose.Types.ObjectId(
      decision.reservation.entitlementSnapshot.userId,
    ),
    sessionId: usage.sessionId,
    decision,
  })
  return {
    kind: 'reserved',
    reused: false,
    usageId: usage.id.toHexString(),
    providerMode,
    source: decision.reservation.source,
    sourceId: decision.reservation.sourceId,
    ...(decision.reservation.periodKey
      ? { periodKey: decision.reservation.periodKey }
      : {}),
    expiresAt: decision.selection.expiresAt,
    effectiveTier: decision.effectiveTier,
    normalizedConfiguration:
      decision.normalizedConfiguration,
    entitlementSnapshot:
      decision.reservation.entitlementSnapshot,
  }
}

export async function resolveAndReserveInterviewSessionEntitlement(
  rawInput: InterviewSessionEntitlementInput,
  session: ClientSession,
  claimedUserId: mongoose.Types.ObjectId,
  dependencies:
    InterviewSessionEntitlementDependencies = {},
): Promise<InterviewSessionEntitlementResult> {
  const hasTestOverrides = (
    dependencies.decisionReady !== undefined ||
    dependencies.reservationReady !== undefined ||
    dependencies.now !== undefined ||
    dependencies.store !== undefined ||
    dependencies.decide !== undefined
  )
  if (
    hasTestOverrides &&
    process.env.NODE_ENV !== 'test'
  ) {
    throw failure(
      'invalid_request',
      'Interview reservation overrides are test-only',
    )
  }
  if (
    (dependencies.decisionReady ??
      PR8_INTERVIEW_ENTITLEMENT_DECISION_READY) !== true ||
    (dependencies.reservationReady ??
      PR8_INTERVIEW_USAGE_RESERVATION_READY) !== true
  ) {
    throw failure(
      'not_ready',
      'Authoritative interview reservation is not ready',
    )
  }
  if (
    typeof session?.inTransaction !== 'function' ||
    session.inTransaction() !== true
  ) {
    throw failure(
      'invalid_request',
      'Interview reservation requires an active transaction',
    )
  }
  const userId = exactObjectId(rawInput.userId, 'userId')
  const sessionId = exactObjectId(
    rawInput.sessionId,
    'sessionId',
  )
  if (!userId.equals(claimedUserId)) {
    throw failure(
      'invalid_request',
      'Transaction user does not match the request',
    )
  }
  const now = observedNow(dependencies.now)
  const store = dependencies.store ?? (
    dependencies.subscriptionGracePort
      ? {
          ...mongoInterviewSessionEntitlementStore,
          loadAuthority: (input, activeSession) =>
            loadMongoAuthority(input, activeSession, {
              transitionBasicProjection: true,
              subscriptionGracePort:
                dependencies.subscriptionGracePort,
            }),
          reserve: (input, activeSession) =>
            reserveMongoDecision(
              input,
              activeSession,
              dependencies.subscriptionGracePort,
            ),
        }
      : mongoInterviewSessionEntitlementStore
  )
  await store.assertUserActive(userId, session)
  const existing = await store.findUsageBySession(
    sessionId,
    session,
  )
  if (existing) {
    return replayResult(existing, rawInput)
  }
  const authority = await store.loadAuthority(
    {
      userId,
      now,
      interviewType: rawInput.interviewType,
    },
    session,
  )
  if (
    authority.interviewTypeAuthority.supported !== true ||
    authority.interviewTypeAuthority.interviewType !==
      rawInput.interviewType
  ) {
    throw failure(
      'authority_review',
      'Interview type authority does not match the request',
    )
  }
  const decision = (
    dependencies.decide ??
    decideAuthoritativeInterviewEntitlement
  )({
    userId: rawInput.userId,
    providerMode: authority.providerMode,
    now,
    configuration: {
      interviewType: rawInput.interviewType,
      interviewTypeSupported: true,
      durationMinutes: rawInput.durationMinutes,
    },
    includedAuthority:
      authority.includedAuthority,
    paidInterviewUnlocks:
      authority.paidInterviewUnlocks,
    adminInterviewGrants:
      authority.adminInterviewGrants,
  })
  if (decision.decision === 'payment_required') {
    return {
      kind: 'payment_required',
      decision,
    }
  }
  const usage = await store.reserve(
    {
      userId,
      sessionId,
      now,
      providerMode: authority.providerMode,
      decision,
    },
    session,
  )
  return reservationResult(
    usage,
    authority.providerMode,
    decision,
  )
}
