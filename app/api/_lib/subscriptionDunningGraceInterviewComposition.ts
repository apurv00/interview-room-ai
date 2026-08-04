import { createHash } from 'node:crypto'
import mongoose, { type ClientSession } from 'mongoose'
import {
  PAYMENT_SUBSCRIPTION_DUNNING_GRACE_INTERVIEW_READY,
  SUBSCRIPTION_DUNNING_MAX_GRACE_MS,
  SUBSCRIPTION_DUNNING_OBSERVATION_SCHEMA_VERSION,
  observeSubscriptionDunningCase,
  transitionSubscriptionDunningProvisionalGrant,
  type StoredSubscriptionDunningCase,
  type SubscriptionDunningCaseIdentity,
  type SubscriptionDunningCasePersistencePort,
  type SubscriptionDunningProvisionalGrantResult,
} from '@payment-subscription-dunning'
import { InterviewUsage } from '@payments/models/InterviewUsage'
import {
  canonicalJson,
  sha256CanonicalJson,
} from '@payments/lib/canonicalJson'
import type {
  SubscriptionGraceInterviewEntitlementPort,
} from '@payments/services/interviewSessionEntitlementCoordinator'
import type {
  SubscriptionGraceInterviewAuthority,
} from '@payments/services/interviewEntitlementDecisionKernel'
import type {
  SubscriptionGraceInterviewConsumptionPort,
} from '@payments/services/consumerInterviewStartService'
import type {
  SubscriptionGraceCapturedRenewalSettlementPort,
} from '@payments/services/subscriptionCycleFulfillmentService'
import {
  createMongoDunningPersistence,
} from './subscriptionStateDunningComposition'

const OBJECT_ID = /^[a-f0-9]{24}$/
const DIGEST = /^[a-f0-9]{64}$/
const RAZORPAY_SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]+$/
const TEST_AUTHORITY = Symbol(
  'subscription-dunning-grace-interview-composition-test-authority',
)

type GraceInterviewPort =
  SubscriptionGraceInterviewEntitlementPort &
  SubscriptionGraceInterviewConsumptionPort &
  SubscriptionGraceCapturedRenewalSettlementPort
type LoadInput = Parameters<
  SubscriptionGraceInterviewEntitlementPort['loadAuthority']
>[0]
type ReserveInput = Parameters<
  SubscriptionGraceInterviewEntitlementPort['reserve']
>[0]
type ConsumeInput = Parameters<
  SubscriptionGraceInterviewConsumptionPort['consume']
>[0]
type SettleInput = Parameters<
  SubscriptionGraceCapturedRenewalSettlementPort[
    'settleCapturedRenewal'
  ]
>[0]
type PersistenceFactory = (
  session: ClientSession,
) => Promise<SubscriptionDunningCasePersistencePort>
type Transition = typeof transitionSubscriptionDunningProvisionalGrant
type Observe = typeof observeSubscriptionDunningCase

interface GraceCompositionTestAuthority {
  readonly token: symbol
}

interface GraceCompositionConstruction {
  readonly testAuthority?: GraceCompositionTestAuthority
  readonly persistenceFactory?: PersistenceFactory
  readonly transition?: Transition
  readonly observe?: Observe
}

interface ExactGraceSnapshot {
  readonly schemaVersion: 2
  readonly policyVersion:
    'pr8-interview-entitlement-decision-v2'
  readonly userId: string
  readonly providerMode: 'test' | 'live'
  readonly source: 'subscription_grace'
  readonly sourceId: string
  readonly entitlementSource: 'subscription_grace'
  readonly caseId: string
  readonly caseRevision: number
  readonly statusVersion: number
  readonly grantId: string
  readonly grantRevision: number
  readonly grantState: 'not_offered' | 'available'
  readonly grantDigest?: string
  readonly subscriptionId: string
  readonly razorpaySubscriptionId: string
  readonly effectiveTier: 'plus' | 'pro'
  readonly catalogVersion: string
  readonly periodKey: string
  readonly periodStart: string
  readonly periodEnd: string
  readonly graceEndsAt: string
  readonly sourceEvidenceDigest: string
  readonly decisionDigest: string
  readonly interviewLimit: 1
  readonly interviewsUsedBefore: 0
  readonly interviewsRemainingBefore: 1
  readonly maxDurationMinutes: 30
}

interface UsageRow {
  readonly _id: mongoose.Types.ObjectId
  readonly sessionId: mongoose.Types.ObjectId
  readonly userId: mongoose.Types.ObjectId
  readonly source: string
  readonly sourceId: mongoose.Types.ObjectId
  readonly periodKey?: string
  readonly reservedAt: Date
  readonly consumedAt?: Date
  readonly restorationId?: mongoose.Types.ObjectId
  readonly entitlementSnapshot: unknown
  readonly entitlementSnapshotDigest?: string
}

function fail(message: string): never {
  throw new Error(`Subscription grace interview: ${message}`)
}

function enabled(
  construction: GraceCompositionConstruction,
): boolean {
  return (
    PAYMENT_SUBSCRIPTION_DUNNING_GRACE_INTERVIEW_READY ||
    construction.testAuthority?.token === TEST_AUTHORITY
  )
}

function exactObjectId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !OBJECT_ID.test(value)) {
    return fail(`${label} is invalid`)
  }
  return value
}

function exactDate(value: unknown, label: string): Date {
  const date = value instanceof Date
    ? value
    : typeof value === 'string'
      ? new Date(value)
      : null
  if (!date || !Number.isFinite(date.getTime())) {
    return fail(`${label} is invalid`)
  }
  return new Date(date)
}

function safeCounter(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) return fail(`${label} is invalid`)
  return value
}

function exactSession(session: ClientSession): void {
  if (
    typeof session?.inTransaction !== 'function' ||
    session.inTransaction() !== true
  ) return fail('caller transaction is unavailable')
}

function deterministicGrantId(input: {
  providerMode: 'test' | 'live'
  caseId: string
  subscriptionId: string
  paidPeriodKey: string
}): string {
  return createHash('sha256').update(JSON.stringify([
    'subscription-dunning-grace-interview-grant-v1',
    input.providerMode,
    input.caseId,
    input.subscriptionId,
    input.paidPeriodKey,
  ])).digest('hex').slice(0, 24)
}

function identity(input: {
  providerMode: 'test' | 'live'
  subscriptionId: string
  paidPeriodKey: string
}): SubscriptionDunningCaseIdentity {
  return {
    providerMode: input.providerMode,
    subscriptionId: input.subscriptionId,
    paidPeriodKey: input.paidPeriodKey,
  }
}

function assertCaseLineage(input: {
  current: StoredSubscriptionDunningCase | null
  providerMode: 'test' | 'live'
  subscriptionId: string
  userId: string
  paidPeriodKey: string
  paidPeriodStart: Date
  paidPeriodEnd: Date
}): StoredSubscriptionDunningCase {
  const current = input.current
  if (
    !current ||
    current.providerMode !== input.providerMode ||
    current.subscriptionId !== input.subscriptionId ||
    current.userId !== input.userId ||
    current.paidPeriodKey !== input.paidPeriodKey ||
    current.paidPeriodStart !== input.paidPeriodStart.toISOString() ||
    current.paidPeriodEnd !== input.paidPeriodEnd.toISOString() ||
    !DIGEST.test(current.sourceEvidenceDigest) ||
    !DIGEST.test(current.decisionDigest)
  ) return fail('dunning case lineage is inconsistent')
  return current
}

function assertEligibleCase(
  current: StoredSubscriptionDunningCase,
  now: Date,
): Date {
  const paidPeriodEnd = exactDate(
    current.paidPeriodEnd,
    'paid-period end',
  )
  const graceEndsAt = current.graceEndsAt === null
    ? null
    : exactDate(current.graceEndsAt, 'grace end')
  if (
    current.clockAuthority !== 'authoritative' ||
    current.statusVersion === null ||
    current.providerStatus !== 'pending' ||
    current.classification !== 'pending_grace_candidate' ||
    !current.remoteRetryingConfirmed ||
    current.renewalCycleCaptured ||
    current.accessOverride !== 'none' ||
    !graceEndsAt ||
    paidPeriodEnd > now ||
    graceEndsAt <= now ||
    graceEndsAt <= paidPeriodEnd ||
    graceEndsAt.getTime() - paidPeriodEnd.getTime() >
      SUBSCRIPTION_DUNNING_MAX_GRACE_MS ||
    current.configuredGraceMs !==
      graceEndsAt.getTime() - paidPeriodEnd.getTime() ||
    exactDate(current.statusObservedAt, 'status observation') > now
  ) return fail('dunning case is not eligible for grace access')
  return graceEndsAt
}

function exactSnapshot(value: unknown): ExactGraceSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail('entitlement snapshot is invalid')
  }
  const row = value as Record<string, unknown>
  const snapshot = row as unknown as ExactGraceSnapshot
  const periodStart = exactDate(row.periodStart, 'snapshot period start')
  const periodEnd = exactDate(row.periodEnd, 'snapshot period end')
  const graceEndsAt = exactDate(row.graceEndsAt, 'snapshot grace end')
  if (
    row.schemaVersion !== 2 ||
    row.policyVersion !== 'pr8-interview-entitlement-decision-v2' ||
    row.source !== 'subscription_grace' ||
    row.entitlementSource !== 'subscription_grace' ||
    exactObjectId(row.userId, 'snapshot user ID') !== row.userId ||
    (row.providerMode !== 'test' && row.providerMode !== 'live') ||
    exactObjectId(row.sourceId, 'snapshot source ID') !== row.sourceId ||
    exactObjectId(row.caseId, 'snapshot case ID') !== row.caseId ||
    exactObjectId(row.grantId, 'snapshot grant ID') !== row.grantId ||
    row.sourceId !== row.grantId ||
    exactObjectId(row.subscriptionId, 'snapshot subscription ID') !==
      row.subscriptionId ||
    safeCounter(row.caseRevision, 'snapshot case revision') < 1 ||
    safeCounter(row.statusVersion, 'snapshot status version') < 0 ||
    safeCounter(row.grantRevision, 'snapshot grant revision') < 0 ||
    (
      row.grantState !== 'not_offered' &&
      row.grantState !== 'available'
    ) ||
    (
      row.grantState === 'not_offered'
        ? row.grantRevision !== 0 || row.grantDigest !== undefined
        : (
            safeCounter(row.grantRevision, 'snapshot grant revision') < 1 ||
            typeof row.grantDigest !== 'string' ||
            !DIGEST.test(row.grantDigest)
          )
    ) ||
    typeof row.razorpaySubscriptionId !== 'string' ||
    !RAZORPAY_SUBSCRIPTION_ID.test(row.razorpaySubscriptionId) ||
    (row.effectiveTier !== 'plus' && row.effectiveTier !== 'pro') ||
    typeof row.catalogVersion !== 'string' ||
    row.catalogVersion.length < 1 ||
    row.catalogVersion.length > 100 ||
    row.catalogVersion !== row.catalogVersion.trim() ||
    typeof row.periodKey !== 'string' ||
    row.periodKey.length < 1 ||
    row.periodKey.length > 255 ||
    periodStart >= periodEnd ||
    graceEndsAt <= periodEnd ||
    graceEndsAt.getTime() - periodEnd.getTime() >
      SUBSCRIPTION_DUNNING_MAX_GRACE_MS ||
    typeof row.sourceEvidenceDigest !== 'string' ||
    !DIGEST.test(row.sourceEvidenceDigest) ||
    typeof row.decisionDigest !== 'string' ||
    !DIGEST.test(row.decisionDigest) ||
    row.interviewLimit !== 1 ||
    row.interviewsUsedBefore !== 0 ||
    row.interviewsRemainingBefore !== 1 ||
    row.maxDurationMinutes !== 30
  ) return fail('entitlement snapshot is inconsistent')
  return snapshot
}

function assertSnapshotCase(
  snapshot: ExactGraceSnapshot,
  current: StoredSubscriptionDunningCase,
  requireExactRevision: boolean,
): void {
  const grant = current.provisionalGrant
  const expectedGrantId = grant?.grantId ?? deterministicGrantId({
    providerMode: current.providerMode,
    caseId: current.id,
    subscriptionId: current.subscriptionId,
    paidPeriodKey: current.paidPeriodKey,
  })
  if (
    snapshot.caseId !== current.id ||
    snapshot.statusVersion !== current.statusVersion ||
    snapshot.grantId !== expectedGrantId ||
    snapshot.sourceEvidenceDigest !== current.sourceEvidenceDigest ||
    snapshot.periodStart !== current.paidPeriodStart ||
    snapshot.periodEnd !== current.paidPeriodEnd ||
    snapshot.graceEndsAt !== current.graceEndsAt ||
    (
      requireExactRevision &&
      (
        snapshot.caseRevision !== current.revision ||
        snapshot.decisionDigest !== current.decisionDigest ||
        snapshot.grantRevision !== (grant?.revision ?? 0) ||
        snapshot.grantState !== (grant?.state ?? 'not_offered') ||
        snapshot.grantDigest !== grant?.grantDigest
      )
    )
  ) return fail('dunning case changed after entitlement decision')
}

function exactTransition(
  result: SubscriptionDunningProvisionalGrantResult,
): Exclude<
  SubscriptionDunningProvisionalGrantResult,
  { outcome: 'disabled' }
> {
  if (result.outcome === 'disabled') {
    return fail('provisional grant transition is disabled')
  }
  return result
}

function exactObservation(
  result: Awaited<ReturnType<Observe>>,
): Exclude<
  Awaited<ReturnType<Observe>>,
  { outcome: 'disabled' | 'stale' }
> {
  if (
    result.outcome === 'disabled' ||
    result.outcome === 'stale'
  ) {
    return fail('captured renewal observation is not current')
  }
  return result
}

function targetCycleEvidence(input: {
  providerMode: 'test' | 'live'
  userId: string
  subscriptionId: string
  razorpaySubscriptionId: string
  sourcePaidPeriodKey: string
  targetCycleId: string
  targetPaidPeriodKey: string
  targetPeriodStart: string
  targetPeriodEnd: string
  capturedAt: string
}) {
  const evidenceDigest = sha256CanonicalJson({
    domain:
      'subscription-dunning-captured-renewal-target-cycle:v1',
    ...input,
  })
  return Object.freeze({
    cycleId: input.targetCycleId,
    subscriptionId: input.subscriptionId,
    paidPeriodKey: input.targetPaidPeriodKey,
    capturedAt: input.capturedAt,
    evidenceDigest,
  })
}

function buildAdapter(
  construction: GraceCompositionConstruction,
): GraceInterviewPort {
  const persistenceFactory =
    construction.persistenceFactory ?? createMongoDunningPersistence
  const transition =
    construction.transition ?? transitionSubscriptionDunningProvisionalGrant
  const observe =
    construction.observe ?? observeSubscriptionDunningCase

  return Object.freeze({
    async loadAuthority(input: LoadInput, session: ClientSession) {
      if (!enabled(construction)) return null
      exactSession(session)
      const now = exactDate(input.now, 'authority clock')
      const userId = exactObjectId(input.userId, 'user ID')
      const subscriptionId = exactObjectId(
        input.subscriptionId,
        'subscription ID',
      )
      if (
        (input.providerMode !== 'test' && input.providerMode !== 'live') ||
        !RAZORPAY_SUBSCRIPTION_ID.test(input.razorpaySubscriptionId) ||
        (input.planKey !== 'plus' && input.planKey !== 'pro') ||
        typeof input.catalogVersion !== 'string' ||
        input.catalogVersion.length < 1 ||
        input.catalogVersion.length > 100
      ) return fail('authority input is invalid')
      const paidPeriodStart = exactDate(
        input.paidPeriodStart,
        'paid-period start',
      )
      const paidPeriodEnd = exactDate(
        input.paidPeriodEnd,
        'paid-period end',
      )
      const persistence = await persistenceFactory(session)
      return persistence.runTransaction(async (transaction) => {
        const current = assertCaseLineage({
          current: await transaction.loadCase(identity({
            providerMode: input.providerMode,
            subscriptionId,
            paidPeriodKey: input.paidPeriodKey,
          })),
          providerMode: input.providerMode,
          subscriptionId,
          userId,
          paidPeriodKey: input.paidPeriodKey,
          paidPeriodStart,
          paidPeriodEnd,
        })
        const graceEndsAt = assertEligibleCase(current, now)
        const grant = current.provisionalGrant
        const grantId = grant?.grantId ?? deterministicGrantId({
          providerMode: current.providerMode,
          caseId: current.id,
          subscriptionId: current.subscriptionId,
          paidPeriodKey: current.paidPeriodKey,
        })
        const authority = {
          kind: 'subscription_grace' as const,
          entitlementSource: 'subscription_grace' as const,
          providerMode: input.providerMode,
          caseId: current.id,
          caseRevision: current.revision,
          statusVersion: current.statusVersion!,
          grantId,
          grantRevision: grant?.revision ?? 0,
          grantState: grant?.state ?? ('not_offered' as const),
          ...(grant ? { grantDigest: grant.grantDigest } : {}),
          subscriptionId,
          razorpaySubscriptionId: input.razorpaySubscriptionId,
          planKey: input.planKey,
          catalogVersion: input.catalogVersion,
          paidPeriodKey: input.paidPeriodKey,
          paidPeriodStart,
          paidPeriodEnd,
          graceEndsAt,
          sourceEvidenceDigest: current.sourceEvidenceDigest,
          decisionDigest: current.decisionDigest,
          maxDurationMinutes: 30 as const,
        } satisfies SubscriptionGraceInterviewAuthority
        return authority
      })
    },

    async reserve(input: ReserveInput, session: ClientSession) {
      if (!enabled(construction)) return fail('composition is disabled')
      exactSession(session)
      const occurredAt = exactDate(input.occurredAt, 'reservation clock')
      const snapshot = exactSnapshot(input.authority)
      const userId = exactObjectId(input.userId, 'user ID')
      const sessionId = exactObjectId(input.sessionId, 'session ID')
      exactObjectId(input.usageId, 'usage ID')
      if (
        snapshot.userId !== userId ||
        snapshot.providerMode !== input.providerMode
      ) return fail('reservation identity is inconsistent')
      const persistence = await persistenceFactory(session)
      return persistence.runTransaction(async (transaction) => {
        let current = assertCaseLineage({
          current: await transaction.loadCase(identity({
            providerMode: snapshot.providerMode,
            subscriptionId: snapshot.subscriptionId,
            paidPeriodKey: snapshot.periodKey,
          })),
          providerMode: snapshot.providerMode,
          subscriptionId: snapshot.subscriptionId,
          userId,
          paidPeriodKey: snapshot.periodKey,
          paidPeriodStart: exactDate(snapshot.periodStart, 'period start'),
          paidPeriodEnd: exactDate(snapshot.periodEnd, 'period end'),
        })
        assertEligibleCase(current, occurredAt)
        assertSnapshotCase(snapshot, current, true)
        if (current.provisionalGrant === null) {
          const offered = exactTransition(await transition({
            schemaVersion:
              'payment_subscription_dunning_provisional_command_v1',
            operation: 'offer',
            providerMode: current.providerMode,
            subscriptionId: current.subscriptionId,
            paidPeriodKey: current.paidPeriodKey,
            caseId: current.id,
            expectedCaseRevision: current.revision,
            expectedStatusVersion: current.statusVersion!,
            grantId: snapshot.grantId,
            expectedGrantRevision: 0,
            occurredAt: occurredAt.toISOString(),
            evidenceDigest: current.sourceEvidenceDigest,
          }, { transaction }))
          if (
            offered.grant.state !== 'available' ||
            offered.grant.grantId !== snapshot.grantId ||
            offered.grant.reservedSessionId !== null
          ) return fail('provisional grant offer postcondition failed')
          current = offered.case
        }
        const grant = current.provisionalGrant
        if (!grant || grant.state !== 'available') {
          return fail('provisional grant is not available')
        }
        const reserved = exactTransition(await transition({
          schemaVersion:
            'payment_subscription_dunning_provisional_command_v1',
          operation: 'reserve',
          providerMode: current.providerMode,
          subscriptionId: current.subscriptionId,
          paidPeriodKey: current.paidPeriodKey,
          caseId: current.id,
          expectedCaseRevision: current.revision,
          expectedStatusVersion: current.statusVersion!,
          grantId: grant.grantId,
          expectedGrantRevision: grant.revision,
          occurredAt: occurredAt.toISOString(),
          evidenceDigest: current.sourceEvidenceDigest,
          reservedSessionId: sessionId,
        }, { transaction }))
        if (
          reserved.grant.state !== 'reserved' ||
          reserved.grant.grantId !== snapshot.grantId ||
          reserved.grant.reservedSessionId !== sessionId ||
          reserved.grant.reservedAt !== occurredAt.toISOString() ||
          reserved.grant.usageReferenceId !== null
        ) return fail('provisional grant reservation postcondition failed')
        return {
          caseId: reserved.case.id,
          grantId: reserved.grant.grantId,
          state: 'reserved' as const,
          reservedSessionId: sessionId,
          reservedAt: occurredAt,
        }
      })
    },

    async consume(input: ConsumeInput, session: ClientSession) {
      if (!enabled(construction)) return fail('composition is disabled')
      exactSession(session)
      const userId = exactObjectId(input.userId, 'user ID')
      const sessionId = exactObjectId(input.sessionId, 'session ID')
      const usageId = exactObjectId(input.usageId, 'usage ID')
      const occurredAt = exactDate(input.occurredAt, 'consumption clock')
      const snapshot = exactSnapshot(input.authority.entitlementSnapshot)
      if (
        snapshot.userId !== userId ||
        snapshot.providerMode !== input.providerMode ||
        snapshot.sourceId !== input.authority.sourceId ||
        snapshot.periodKey !== input.authority.periodKey ||
        sha256CanonicalJson(snapshot) !==
          input.authority.entitlementSnapshotDigest
      ) return fail('consumption authority is inconsistent')
      const persistence = await persistenceFactory(session)
      return persistence.runTransaction(async (transaction) => {
        const usage = await InterviewUsage.findOne({
          _id: usageId,
          userId,
          sessionId,
        }).session(session).lean<UsageRow>()
        if (
          !usage ||
          usage.source !== 'subscription_grace' ||
          usage.sourceId.toHexString() !== snapshot.grantId ||
          usage.periodKey !== snapshot.periodKey ||
          !(usage.reservedAt instanceof Date) ||
          !Number.isFinite(usage.reservedAt.getTime()) ||
          usage.restorationId !== undefined ||
          usage.entitlementSnapshotDigest !==
            input.authority.entitlementSnapshotDigest ||
          canonicalJson(usage.entitlementSnapshot) !==
            canonicalJson(snapshot)
        ) return fail('persisted grace usage is inconsistent')
        const current = assertCaseLineage({
          current: await transaction.loadCase(identity({
            providerMode: snapshot.providerMode,
            subscriptionId: snapshot.subscriptionId,
            paidPeriodKey: snapshot.periodKey,
          })),
          providerMode: snapshot.providerMode,
          subscriptionId: snapshot.subscriptionId,
          userId,
          paidPeriodKey: snapshot.periodKey,
          paidPeriodStart: exactDate(snapshot.periodStart, 'period start'),
          paidPeriodEnd: exactDate(snapshot.periodEnd, 'period end'),
        })
        const grant = current.provisionalGrant
        if (
          grant?.state === 'consumed' &&
          grant.grantId === snapshot.grantId &&
          grant.reservedSessionId === sessionId &&
          grant.usageReferenceId === usageId &&
          grant.consumedAt !== null &&
          usage.consumedAt instanceof Date &&
          usage.consumedAt.toISOString() === grant.consumedAt
        ) {
          return {
            caseId: current.id,
            grantId: grant.grantId,
            state: 'consumed' as const,
            reservedSessionId: sessionId,
            usageReferenceId: usageId,
            consumedAt: new Date(grant.consumedAt),
          }
        }
        assertEligibleCase(current, occurredAt)
        if (
          current.statusVersion !== snapshot.statusVersion ||
          current.sourceEvidenceDigest !== snapshot.sourceEvidenceDigest ||
          !grant ||
          grant.state !== 'reserved' ||
          grant.grantId !== snapshot.grantId ||
          grant.reservedSessionId !== sessionId ||
          grant.reservedAt !== usage.reservedAt.toISOString() ||
          usage.consumedAt !== undefined
        ) return fail('reserved provisional grant is inconsistent')
        const consumed = exactTransition(await transition({
          schemaVersion:
            'payment_subscription_dunning_provisional_command_v1',
          operation: 'consume',
          providerMode: current.providerMode,
          subscriptionId: current.subscriptionId,
          paidPeriodKey: current.paidPeriodKey,
          caseId: current.id,
          expectedCaseRevision: current.revision,
          expectedStatusVersion: current.statusVersion!,
          grantId: grant.grantId,
          expectedGrantRevision: grant.revision,
          occurredAt: occurredAt.toISOString(),
          evidenceDigest: current.sourceEvidenceDigest,
          reservedSessionId: sessionId,
          usageReferenceId: usageId,
        }, { transaction }))
        if (
          consumed.grant.state !== 'consumed' ||
          consumed.grant.reservedSessionId !== sessionId ||
          consumed.grant.usageReferenceId !== usageId ||
          consumed.grant.consumedAt !== occurredAt.toISOString()
        ) return fail('provisional grant consumption postcondition failed')
        const updated = await InterviewUsage.findOneAndUpdate(
          {
            _id: usageId,
            userId,
            sessionId,
            source: 'subscription_grace',
            sourceId: snapshot.grantId,
            periodKey: snapshot.periodKey,
            reservedAt: usage.reservedAt,
            consumedAt: { $exists: false },
            restorationId: { $exists: false },
            entitlementSnapshotDigest:
              input.authority.entitlementSnapshotDigest,
          },
          { $set: { consumedAt: occurredAt } },
          { new: true, runValidators: true, session },
        ).lean<UsageRow>()
        if (
          !updated?.consumedAt ||
          updated.consumedAt.getTime() !== occurredAt.getTime()
        ) return fail('grace usage consumption CAS did not match')
        return {
          caseId: consumed.case.id,
          grantId: consumed.grant.grantId,
          state: 'consumed' as const,
          reservedSessionId: sessionId,
          usageReferenceId: usageId,
          consumedAt: occurredAt,
        }
      })
    },

    async settleCapturedRenewal(
      input: SettleInput,
      session: ClientSession,
    ) {
      if (!enabled(construction)) return fail('composition is disabled')
      exactSession(session)
      const userId = exactObjectId(input.userId, 'user ID')
      const subscriptionId = exactObjectId(
        input.subscriptionId,
        'subscription ID',
      )
      const targetCycleId = exactObjectId(
        input.targetCycle.id,
        'target cycle ID',
      )
      if (
        (input.providerMode !== 'test' &&
          input.providerMode !== 'live') ||
        !RAZORPAY_SUBSCRIPTION_ID.test(
          input.razorpaySubscriptionId,
        ) ||
        typeof input.sourcePaidPeriod.key !== 'string' ||
        input.sourcePaidPeriod.key.length < 1 ||
        input.sourcePaidPeriod.key.length > 255 ||
        typeof input.targetCycle.paidPeriodKey !== 'string' ||
        input.targetCycle.paidPeriodKey.length < 1 ||
        input.targetCycle.paidPeriodKey.length > 255 ||
        input.sourcePaidPeriod.key ===
          input.targetCycle.paidPeriodKey
      ) return fail('captured renewal input is invalid')
      const sourceStart = exactDate(
        input.sourcePaidPeriod.start,
        'source paid-period start',
      )
      const sourceEnd = exactDate(
        input.sourcePaidPeriod.end,
        'source paid-period end',
      )
      const targetStart = exactDate(
        input.targetCycle.periodStart,
        'target paid-period start',
      )
      const targetEnd = exactDate(
        input.targetCycle.periodEnd,
        'target paid-period end',
      )
      const capturedAt = exactDate(
        input.targetCycle.capturedAt,
        'captured renewal clock',
      )
      if (
        sourceStart >= sourceEnd ||
        sourceEnd.getTime() !== targetStart.getTime() ||
        targetStart >= targetEnd ||
        capturedAt < targetStart ||
        capturedAt >= targetEnd
      ) return fail('captured renewal periods are inconsistent')
      const persistence = await persistenceFactory(session)
      return persistence.runTransaction(async (transaction) => {
        const loaded = await transaction.loadCase(identity({
            providerMode: input.providerMode,
            subscriptionId,
            paidPeriodKey: input.sourcePaidPeriod.key,
          }))
        if (!loaded) {
          return { outcome: 'not_applicable' as const }
        }
        let current = assertCaseLineage({
          current: loaded,
          providerMode: input.providerMode,
          subscriptionId,
          userId,
          paidPeriodKey: input.sourcePaidPeriod.key,
          paidPeriodStart: sourceStart,
          paidPeriodEnd: sourceEnd,
        })
        const targetCycle = targetCycleEvidence({
          providerMode: input.providerMode,
          userId,
          subscriptionId,
          razorpaySubscriptionId:
            input.razorpaySubscriptionId,
          sourcePaidPeriodKey: input.sourcePaidPeriod.key,
          targetCycleId,
          targetPaidPeriodKey:
            input.targetCycle.paidPeriodKey,
          targetPeriodStart: targetStart.toISOString(),
          targetPeriodEnd: targetEnd.toISOString(),
            capturedAt: capturedAt.toISOString(),
        })
        if (
          input.providerSubscriptionStatus !== 'active' ||
          capturedAt < new Date(current.paidPeriodEnd) ||
          capturedAt < new Date(current.statusObservedAt)
        ) return fail('captured renewal lacks active provider authority')

        if (
          current.classification !== 'recovered' ||
          current.reason !== 'renewal_cycle_captured' ||
          current.providerStatus !== 'active' ||
          !current.renewalCycleCaptured
        ) {
          if (
            current.statusVersion === null ||
            current.statusVersion >= Number.MAX_SAFE_INTEGER
          ) return fail('captured renewal status version is unavailable')
          const sourceEvidenceDigest = sha256CanonicalJson({
            domain:
              'subscription-dunning-captured-renewal-observation:v1',
            caseId: current.id,
            priorCaseRevision: current.revision,
            priorStatusVersion: current.statusVersion,
            targetCycle,
          })
          const observation = exactObservation(await observe({
            schemaVersion:
              SUBSCRIPTION_DUNNING_OBSERVATION_SCHEMA_VERSION,
            providerMode: current.providerMode,
            subscriptionId: current.subscriptionId,
            userId: current.userId,
            providerStatus: 'active',
            statusVersion: current.statusVersion + 1,
            clockAuthority: 'authoritative',
            statusObservedAt: capturedAt.toISOString(),
            firstPendingObservedAt: null,
            remoteRetryingConfirmed: false,
            renewalCycleCaptured: true,
            accessOverride: current.accessOverride,
            paidPeriod: {
              key: current.paidPeriodKey,
              start: current.paidPeriodStart,
              end: current.paidPeriodEnd,
            },
            sourceEvidenceDigest,
          }, {
            configuredGraceMs: current.configuredGraceMs,
            persistence,
            now: () => new Date(capturedAt),
          }))
          current = observation.case
        }
        const grant = current.provisionalGrant
        if (
          current.classification !== 'recovered' ||
          current.reason !== 'renewal_cycle_captured' ||
          current.providerStatus !== 'active' ||
          !current.renewalCycleCaptured ||
          current.statusVersion === null
        ) return fail('captured renewal did not recover its grace case')
        if (grant?.state === 'counted_against_cycle') {
          if (
            grant.capturedTargetCycle === null ||
            canonicalJson(grant.capturedTargetCycle) !==
              canonicalJson(targetCycle)
          ) return fail('captured grace settlement conflicts with replay')
          return {
            outcome: 'counted' as const,
            caseId: current.id,
            grantId: grant.grantId,
            sourcePaidPeriodKey: current.paidPeriodKey,
            targetCycleId,
            targetPaidPeriodKey: targetCycle.paidPeriodKey,
            reused: true,
          }
        }
        if (grant?.state !== 'consumed') {
          return { outcome: 'not_applicable' as const }
        }
        const settled = exactTransition(await transition({
          schemaVersion:
            'payment_subscription_dunning_provisional_command_v1',
          operation: 'finalize_captured_renewal',
          providerMode: current.providerMode,
          subscriptionId: current.subscriptionId,
          paidPeriodKey: current.paidPeriodKey,
          caseId: current.id,
          expectedCaseRevision: current.revision,
          expectedStatusVersion: current.statusVersion,
          grantId: grant.grantId,
          expectedGrantRevision: grant.revision,
          occurredAt: capturedAt.toISOString(),
          evidenceDigest: current.sourceEvidenceDigest,
          targetCycle,
        }, { transaction }))
        if (
          settled.grant.state !== 'counted_against_cycle' ||
          settled.grant.capturedTargetCycle === null ||
          canonicalJson(settled.grant.capturedTargetCycle) !==
            canonicalJson(targetCycle)
        ) return fail('captured grace settlement postcondition failed')
        return {
          outcome: 'counted' as const,
          caseId: settled.case.id,
          grantId: settled.grant.grantId,
          sourcePaidPeriodKey: settled.case.paidPeriodKey,
          targetCycleId,
          targetPaidPeriodKey: targetCycle.paidPeriodKey,
          reused: settled.outcome === 'replayed',
        }
      })
    },
  })
}

export function createSubscriptionDunningGraceInterviewTestAuthorityForTest():
GraceCompositionTestAuthority {
  if (process.env.NODE_ENV !== 'test') {
    return fail('test authority is unavailable outside tests')
  }
  return Object.freeze({ token: TEST_AUTHORITY })
}

export function createSubscriptionDunningGraceInterviewPortForTest(input: {
  readonly testAuthority: GraceCompositionTestAuthority
  readonly persistenceFactory: PersistenceFactory
  readonly transition?: Transition
  readonly observe?: Observe
}): GraceInterviewPort {
  if (
    process.env.NODE_ENV !== 'test' ||
    input.testAuthority.token !== TEST_AUTHORITY
  ) return fail('test construction is unauthorized')
  return buildAdapter(input)
}

export const productionSubscriptionDunningGraceInterviewPort:
  GraceInterviewPort | undefined =
  PAYMENT_SUBSCRIPTION_DUNNING_GRACE_INTERVIEW_READY
    ? buildAdapter({})
    : undefined
