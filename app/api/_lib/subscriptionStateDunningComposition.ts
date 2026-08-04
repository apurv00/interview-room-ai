import { createHash } from 'node:crypto'
import type { ClientSession } from 'mongoose'
import {
  PAYMENT_SUBSCRIPTION_DUNNING_CASE_WRITES_READY,
  SUBSCRIPTION_DUNNING_ACCESS_OVERRIDES,
  SUBSCRIPTION_DUNNING_CASE_SCHEMA_VERSION,
  SUBSCRIPTION_DUNNING_CLASSIFICATIONS,
  SUBSCRIPTION_DUNNING_CLOCK_AUTHORITIES,
  SUBSCRIPTION_DUNNING_EVENT_SCHEMA_VERSION,
  SUBSCRIPTION_DUNNING_MAX_GRACE_MS,
  SUBSCRIPTION_DUNNING_OBSERVATION_SCHEMA_VERSION,
  SUBSCRIPTION_DUNNING_POLICY_VERSION,
  SUBSCRIPTION_DUNNING_PROVIDER_MODES,
  SUBSCRIPTION_DUNNING_PROVIDER_STATUSES,
  SUBSCRIPTION_DUNNING_PROVISIONAL_STATES,
  SUBSCRIPTION_DUNNING_REASON_CODES,
  SubscriptionDunningProvisionalGrantSchema,
  observeSubscriptionDunningCase,
  provisionalInterviewStateFromGrant,
  type StoredSubscriptionDunningCase,
  type SubscriptionDunningCaseDraft,
  type SubscriptionDunningCaseIdentity,
  type SubscriptionDunningCasePersistencePort,
  type SubscriptionDunningCasePersistenceTransaction,
  type SubscriptionDunningCaseUpdate,
  type SubscriptionDunningEventDraft,
  type SubscriptionDunningProvisionalGrant,
} from '@payment-subscription-dunning'
import type {
  SubscriptionStateDunningEvidence,
  SubscriptionStateDunningProducer,
} from '@payments/services/subscriptionStatePersistenceService'

const OBJECT_ID = /^[a-f0-9]{24}$/
const DIGEST = /^[a-f0-9]{64}$/
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const SOURCE_KEY_MAX_LENGTH = 600
const CASE_PROJECTION = [
  '_id',
  'schemaVersion',
  'policyVersion',
  'providerMode',
  'subscriptionId',
  'userId',
  'paidPeriodKey',
  'paidPeriodStart',
  'paidPeriodEnd',
  'providerStatus',
  'statusVersion',
  'clockAuthority',
  'statusObservedAt',
  'firstPendingObservedAt',
  'remoteRetryingConfirmed',
  'renewalCycleCaptured',
  'accessOverride',
  'sourceEvidenceDigest',
  'classification',
  'reason',
  'configuredGraceMs',
  'graceEndsAt',
  'nextActionAt',
  'provisionalGrant',
  'provisionalInterviewState',
  'revision',
  'lastEventSequence',
  'decisionDigest',
].join(' ')

interface DunningCaseServiceTestAuthority {
  readonly token: symbol
}

interface ExactDunningSourceAuthority {
  readonly cycleId: string
  readonly webhook: null | {
    readonly inboxEventId: string
    readonly eventType: string
    readonly payloadHash: string
    readonly receivedAt: string
  }
}

type DunningSourceAuthorityReader = (
  evidence: SubscriptionStateDunningEvidence,
  session: ClientSession,
) => Promise<ExactDunningSourceAuthority>

type DunningPersistenceFactory = (
  session: ClientSession,
) => Promise<SubscriptionDunningCasePersistencePort>

interface DunningProducerConstruction {
  readonly testAuthority?: DunningCaseServiceTestAuthority
  readonly authorityReader?: DunningSourceAuthorityReader
  readonly persistenceFactory?: DunningPersistenceFactory
}

export interface SubscriptionStateDunningCompositionTestInput {
  readonly testAuthority: DunningCaseServiceTestAuthority
  readonly authorityReader: DunningSourceAuthorityReader
  readonly persistenceFactory: DunningPersistenceFactory
}

function fail(message: string): never {
  throw new Error(`Subscription dunning observation: ${message}`)
}

function canonical(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(
      (key) => `${JSON.stringify(key)}:${canonical(record[key])}`,
    ).join(',')}}`
  }
  return fail('digest input is not canonicalizable')
}

function sha256(value: unknown): string {
  return createHash('sha256')
    .update(canonical(value))
    .digest('hex')
}

function canonicalObjectId(value: unknown, label: string): string {
  const candidate = typeof value === 'string'
    ? value
    : value && typeof value === 'object' &&
      'toHexString' in value &&
      typeof value.toHexString === 'function'
      ? value.toHexString()
      : undefined
  if (
    typeof candidate !== 'string' ||
    !OBJECT_ID.test(candidate.toLowerCase())
  ) return fail(`${label} is invalid`)
  return candidate.toLowerCase()
}

function canonicalDate(value: unknown, label: string): string {
  const date = value instanceof Date
    ? value
    : typeof value === 'string'
      ? new Date(value)
      : null
  if (!date || !Number.isFinite(date.getTime())) {
    return fail(`${label} is invalid`)
  }
  return date.toISOString()
}

function nullableDate(value: unknown, label: string): string | null {
  if (value === null) return null
  if (value === undefined) return fail(`${label} is missing`)
  return canonicalDate(value, label)
}

function safeCounter(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) return fail(`${label} is invalid`)
  return value
}

function boundedToken(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > SOURCE_KEY_MAX_LENGTH ||
    value !== value.trim() ||
    CONTROL.test(value)
  ) return fail(`${label} is invalid`)
  return value
}

function exactEvidence(
  raw: SubscriptionStateDunningEvidence,
): SubscriptionStateDunningEvidence {
  const observedAt = canonicalDate(raw.observedAt, 'observation clock')
  const periodStart = canonicalDate(
    raw.paidPeriod?.start,
    'paid-period start',
  )
  const periodEnd = canonicalDate(
    raw.paidPeriod?.end,
    'paid-period end',
  )
  const sourceEvidenceKey = boundedToken(
    raw.sourceEvidenceKey,
    'source evidence key',
  )
  const providerSubscriptionId = boundedToken(
    raw.providerSubscriptionId,
    'provider subscription ID',
  )
  if (
    raw.schemaVersion !==
      'subscription_state_dunning_evidence_v1' ||
    !SUBSCRIPTION_DUNNING_PROVIDER_MODES.includes(raw.providerMode) ||
    !SUBSCRIPTION_DUNNING_PROVIDER_STATUSES.includes(
      raw.remoteStatus,
    ) ||
    !SUBSCRIPTION_DUNNING_PROVIDER_STATUSES.includes(
      raw.persistedStatus,
    ) ||
    !(raw.observedAt instanceof Date) ||
    !(raw.paidPeriod.start instanceof Date) ||
    !(raw.paidPeriod.end instanceof Date) ||
    canonicalObjectId(
      raw.localSubscriptionId,
      'local subscription ID',
    ) !== raw.localSubscriptionId ||
    canonicalObjectId(raw.userId, 'user ID') !== raw.userId ||
    boundedToken(raw.paidPeriod?.key, 'paid-period key') !==
      raw.paidPeriod.key ||
    new Date(periodEnd) <= new Date(periodStart) ||
    new Date(observedAt) < new Date(periodStart) ||
    boundedToken(raw.providerSnapshot.planId, 'provider plan ID') !==
      raw.providerSnapshot.planId ||
    (
      raw.providerSnapshot.offerId !== null &&
      (
        raw.providerSnapshot.offerId.length === 0 ||
        raw.providerSnapshot.offerId !==
          raw.providerSnapshot.offerId.trim()
      )
    ) ||
    !Number.isSafeInteger(raw.providerSnapshot.createdAtEpochSeconds) ||
    raw.providerSnapshot.createdAtEpochSeconds < 0 ||
    (
      raw.providerSnapshot.hasScheduledChanges !== null &&
      typeof raw.providerSnapshot.hasScheduledChanges !== 'boolean'
    ) ||
    (
      raw.providerSnapshot.scheduledChangeAtEpochSeconds !== null &&
      raw.providerSnapshot.hasScheduledChanges !== true
    ) ||
    (
      raw.renewalCycleCaptured &&
      (
        raw.remoteStatus !== 'active' ||
        raw.persistedStatus !== 'active'
      )
    )
  ) return fail('payment-state evidence is invalid')

  for (const [label, value] of Object.entries({
    totalCount: raw.providerSnapshot.totalCount,
    paidCount: raw.providerSnapshot.paidCount,
    remainingCount: raw.providerSnapshot.remainingCount,
  })) safeCounter(value, `provider ${label}`)
  if (
    raw.providerSnapshot.paidCount >
      raw.providerSnapshot.totalCount ||
    raw.providerSnapshot.remainingCount >
      raw.providerSnapshot.totalCount
  ) return fail('provider counters are inconsistent')
  for (const [label, value] of Object.entries({
    currentStartEpochSeconds:
      raw.providerSnapshot.currentStartEpochSeconds,
    currentEndEpochSeconds:
      raw.providerSnapshot.currentEndEpochSeconds,
    startAtEpochSeconds: raw.providerSnapshot.startAtEpochSeconds,
    endAtEpochSeconds: raw.providerSnapshot.endAtEpochSeconds,
    chargeAtEpochSeconds: raw.providerSnapshot.chargeAtEpochSeconds,
    authorizationExpiresAtEpochSeconds:
      raw.providerSnapshot.authorizationExpiresAtEpochSeconds,
    endedAtEpochSeconds: raw.providerSnapshot.endedAtEpochSeconds,
    scheduledChangeAtEpochSeconds:
      raw.providerSnapshot.scheduledChangeAtEpochSeconds,
  })) {
    if (value !== null) safeCounter(value, `provider ${label}`)
  }

  if (raw.observationSource === 'signed_webhook') {
    const inboxEventId = canonicalObjectId(
      raw.webhookInboxEventId,
      'webhook inbox event ID',
    )
    const eventType = boundedToken(
      raw.webhookEventType,
      'webhook event type',
    )
    if (
      sourceEvidenceKey !==
        `${raw.providerMode}:webhook:${inboxEventId}` ||
      eventType !== raw.webhookEventType
    ) return fail('webhook source binding is invalid')
  } else if (
    raw.observationSource !== 'provider_fetch' ||
    raw.webhookInboxEventId !== null ||
    raw.webhookEventType !== null ||
    sourceEvidenceKey !==
      `${raw.providerMode}:subscription:` +
        `${providerSubscriptionId}:${raw.remoteStatus}`
  ) {
    return fail('provider-fetch source binding is invalid')
  }
  return raw
}

async function loadExactSourceAuthority(
  evidence: SubscriptionStateDunningEvidence,
  session: ClientSession,
): Promise<ExactDunningSourceAuthority> {
  if (!session?.inTransaction()) {
    return fail('caller transaction is unavailable')
  }
  const [{ SubscriptionCycle }, webhookModule] = await Promise.all([
    import('@payments/models/SubscriptionCycle'),
    evidence.observationSource === 'signed_webhook'
      ? import('@payments/models/PaymentWebhookEvent')
      : Promise.resolve(null),
  ])
  const cycles = await SubscriptionCycle.find({
    providerMode: evidence.providerMode,
    subscriptionId: evidence.localSubscriptionId,
    userId: evidence.userId,
    periodKey: evidence.paidPeriod.key,
    periodStart: evidence.paidPeriod.start,
    periodEnd: evidence.paidPeriod.end,
    fulfillmentStatus: 'captured',
    projectionDisposition: 'projected',
  })
    .select(
      '_id providerMode subscriptionId userId periodKey ' +
      'periodStart periodEnd fulfillmentStatus projectionDisposition',
    )
    .limit(2)
    .session(session)
    .lean()
    .exec()
  if (cycles.length !== 1) {
    return fail('exact projected paid cycle is unavailable')
  }
  const cycle = cycles[0] as unknown as {
    _id: unknown
    providerMode: unknown
    subscriptionId: unknown
    userId: unknown
    periodKey: unknown
    periodStart: unknown
    periodEnd: unknown
    fulfillmentStatus: unknown
    projectionDisposition: unknown
  }
  if (
    cycle.providerMode !== evidence.providerMode ||
    canonicalObjectId(cycle.subscriptionId, 'cycle subscription') !==
      evidence.localSubscriptionId ||
    canonicalObjectId(cycle.userId, 'cycle user') !== evidence.userId ||
    cycle.periodKey !== evidence.paidPeriod.key ||
    canonicalDate(cycle.periodStart, 'cycle period start') !==
      evidence.paidPeriod.start.toISOString() ||
    canonicalDate(cycle.periodEnd, 'cycle period end') !==
      evidence.paidPeriod.end.toISOString() ||
    cycle.fulfillmentStatus !== 'captured' ||
    cycle.projectionDisposition !== 'projected'
  ) return fail('paid cycle crossed its authority boundary')

  if (!webhookModule) {
    return {
      cycleId: canonicalObjectId(cycle._id, 'cycle ID'),
      webhook: null,
    }
  }
  const inboxEventId = canonicalObjectId(
    evidence.webhookInboxEventId,
    'webhook inbox event ID',
  )
  const webhookEventType = boundedToken(
    evidence.webhookEventType,
    'webhook event type',
  )
  const row = await webhookModule.PaymentWebhookEvent.findOne({
    _id: inboxEventId,
    providerMode: evidence.providerMode,
    eventType: webhookEventType,
    signatureVerified: true,
  })
    .select(
      '_id providerMode eventType payloadHash signatureVerified receivedAt',
    )
    .session(session)
    .lean()
    .exec() as null | {
      _id: unknown
      providerMode: unknown
      eventType: unknown
      payloadHash: unknown
      signatureVerified: unknown
      receivedAt: unknown
    }
  if (
    !row ||
    canonicalObjectId(row._id, 'webhook inbox event ID') !==
      inboxEventId ||
    row.providerMode !== evidence.providerMode ||
    row.eventType !== webhookEventType ||
    row.signatureVerified !== true ||
    typeof row.payloadHash !== 'string' ||
    !DIGEST.test(row.payloadHash)
  ) return fail('signed webhook authority is unavailable')
  return {
    cycleId: canonicalObjectId(cycle._id, 'cycle ID'),
    webhook: {
      inboxEventId,
      eventType: webhookEventType,
      payloadHash: row.payloadHash,
      receivedAt: canonicalDate(row.receivedAt, 'webhook receipt clock'),
    },
  }
}

function sourceEvidenceDigest(input: {
  readonly evidence: SubscriptionStateDunningEvidence
  readonly authority: ExactDunningSourceAuthority
}): string {
  const { evidence, authority } = input
  return sha256({
    domain: 'interviewprepguru:subscription-dunning-source:v1',
    schemaVersion: evidence.schemaVersion,
    observationSource: evidence.observationSource,
    sourceEvidenceKey: evidence.sourceEvidenceKey,
    webhook: authority.webhook,
    providerMode: evidence.providerMode,
    localSubscriptionId: evidence.localSubscriptionId,
    userId: evidence.userId,
    providerSubscriptionId: evidence.providerSubscriptionId,
    persistedStatus: evidence.persistedStatus,
    remoteStatus: evidence.remoteStatus,
    paidCycle: {
      cycleId: authority.cycleId,
      key: evidence.paidPeriod.key,
      start: evidence.paidPeriod.start.toISOString(),
      end: evidence.paidPeriod.end.toISOString(),
      fulfillmentStatus: 'captured',
      projectionDisposition: 'projected',
    },
    providerSnapshot: evidence.providerSnapshot,
    retryAuthority: 'unproven',
    renewalCycleCaptured: evidence.renewalCycleCaptured,
  })
}

function mapGrant(raw: unknown): SubscriptionDunningProvisionalGrant | null {
  if (raw === null || raw === undefined) return null
  const value = raw as Record<string, unknown>
  const target = value.capturedTargetCycle as
    | Record<string, unknown>
    | null
    | undefined
  if (value.capturedTargetCycle === undefined) {
    return fail('stored provisional target is missing')
  }
  const parsed = SubscriptionDunningProvisionalGrantSchema.safeParse({
    schemaVersion: value.schemaVersion,
    grantId: canonicalObjectId(value.grantId, 'grant ID'),
    revision: value.revision,
    state: value.state,
    originStatusVersion: value.originStatusVersion,
    lastStatusVersion: value.lastStatusVersion,
    offeredAt: canonicalDate(value.offeredAt, 'grant offer clock'),
    reservedSessionId: value.reservedSessionId == null
      ? null
      : canonicalObjectId(
          value.reservedSessionId,
          'grant reserved session',
        ),
    usageReferenceId: value.usageReferenceId == null
      ? null
      : canonicalObjectId(
          value.usageReferenceId,
          'grant usage reference',
        ),
    reservedAt: nullableDate(value.reservedAt, 'grant reservation clock'),
    consumedAt: nullableDate(value.consumedAt, 'grant consumption clock'),
    terminalOutcome: value.terminalOutcome,
    finalizedAt: nullableDate(value.finalizedAt, 'grant finalization clock'),
    capturedTargetCycle: target == null
      ? null
      : {
          cycleId: canonicalObjectId(target.cycleId, 'target cycle ID'),
          subscriptionId: canonicalObjectId(
            target.subscriptionId,
            'target subscription ID',
          ),
          paidPeriodKey: target.paidPeriodKey,
          capturedAt: canonicalDate(
            target.capturedAt,
            'target capture clock',
          ),
          evidenceDigest: target.evidenceDigest,
        },
    offerEvidenceDigest: value.offerEvidenceDigest,
    lastEvidenceDigest: value.lastEvidenceDigest,
    lastCommandDigest: value.lastCommandDigest,
    grantDigest: value.grantDigest,
  })
  if (!parsed.success) return fail('stored provisional grant is invalid')
  return parsed.data
}

function toStoredCase(raw: unknown): StoredSubscriptionDunningCase {
  if (!raw || typeof raw !== 'object') {
    return fail('stored case is invalid')
  }
  const value = raw as Record<string, unknown>
  const statusVersion = value.statusVersion === null
    ? null
    : safeCounter(value.statusVersion, 'case status version')
  const candidate: StoredSubscriptionDunningCase = {
    id: canonicalObjectId(value._id ?? value.id, 'case ID'),
    schemaVersion: value.schemaVersion as
      typeof SUBSCRIPTION_DUNNING_CASE_SCHEMA_VERSION,
    policyVersion: value.policyVersion as
      typeof SUBSCRIPTION_DUNNING_POLICY_VERSION,
    providerMode: value.providerMode as
      StoredSubscriptionDunningCase['providerMode'],
    subscriptionId: canonicalObjectId(
      value.subscriptionId,
      'case subscription ID',
    ),
    userId: canonicalObjectId(value.userId, 'case user ID'),
    paidPeriodKey: boundedToken(value.paidPeriodKey, 'case period key'),
    paidPeriodStart: canonicalDate(
      value.paidPeriodStart,
      'case period start',
    ),
    paidPeriodEnd: canonicalDate(value.paidPeriodEnd, 'case period end'),
    providerStatus: value.providerStatus as
      StoredSubscriptionDunningCase['providerStatus'],
    statusVersion,
    clockAuthority: value.clockAuthority as
      StoredSubscriptionDunningCase['clockAuthority'],
    statusObservedAt: canonicalDate(
      value.statusObservedAt,
      'case observation clock',
    ),
    firstPendingObservedAt: nullableDate(
      value.firstPendingObservedAt,
      'case first-pending clock',
    ),
    remoteRetryingConfirmed: value.remoteRetryingConfirmed as boolean,
    renewalCycleCaptured: value.renewalCycleCaptured as boolean,
    accessOverride: value.accessOverride as
      StoredSubscriptionDunningCase['accessOverride'],
    sourceEvidenceDigest: value.sourceEvidenceDigest as string,
    classification: value.classification as
      StoredSubscriptionDunningCase['classification'],
    reason: value.reason as StoredSubscriptionDunningCase['reason'],
    configuredGraceMs: safeCounter(
      value.configuredGraceMs,
      'case grace duration',
    ),
    graceEndsAt: nullableDate(value.graceEndsAt, 'case grace end'),
    nextActionAt: nullableDate(value.nextActionAt, 'case next action'),
    provisionalInterviewState: value.provisionalInterviewState as
      StoredSubscriptionDunningCase['provisionalInterviewState'],
    provisionalGrant: mapGrant(value.provisionalGrant),
    revision: safeCounter(value.revision, 'case revision'),
    lastEventSequence: safeCounter(
      value.lastEventSequence,
      'case event sequence',
    ),
    decisionDigest: value.decisionDigest as string,
  }
  if (
    candidate.schemaVersion !==
      SUBSCRIPTION_DUNNING_CASE_SCHEMA_VERSION ||
    candidate.policyVersion !== SUBSCRIPTION_DUNNING_POLICY_VERSION ||
    !SUBSCRIPTION_DUNNING_PROVIDER_MODES.includes(
      candidate.providerMode,
    ) ||
    !SUBSCRIPTION_DUNNING_PROVIDER_STATUSES.includes(
      candidate.providerStatus,
    ) ||
    !SUBSCRIPTION_DUNNING_CLOCK_AUTHORITIES.includes(
      candidate.clockAuthority,
    ) ||
    !SUBSCRIPTION_DUNNING_ACCESS_OVERRIDES.includes(
      candidate.accessOverride,
    ) ||
    !SUBSCRIPTION_DUNNING_CLASSIFICATIONS.includes(
      candidate.classification,
    ) ||
    !SUBSCRIPTION_DUNNING_REASON_CODES.includes(candidate.reason) ||
    !SUBSCRIPTION_DUNNING_PROVISIONAL_STATES.includes(
      candidate.provisionalInterviewState,
    ) ||
    typeof candidate.remoteRetryingConfirmed !== 'boolean' ||
    typeof candidate.renewalCycleCaptured !== 'boolean' ||
    !DIGEST.test(candidate.sourceEvidenceDigest) ||
    !DIGEST.test(candidate.decisionDigest) ||
    new Date(candidate.paidPeriodEnd) <=
      new Date(candidate.paidPeriodStart) ||
    new Date(candidate.statusObservedAt) <
      new Date(candidate.paidPeriodStart) ||
    (
      candidate.firstPendingObservedAt !== null &&
      new Date(candidate.firstPendingObservedAt) >
        new Date(candidate.statusObservedAt)
    ) ||
    (
      (candidate.clockAuthority === 'authoritative') !==
      (candidate.statusVersion !== null)
    ) ||
    candidate.configuredGraceMs >
      SUBSCRIPTION_DUNNING_MAX_GRACE_MS ||
    candidate.provisionalInterviewState !==
      provisionalInterviewStateFromGrant(candidate.provisionalGrant) ||
    candidate.revision < 1 ||
    candidate.lastEventSequence < 1 ||
    candidate.revision !== candidate.lastEventSequence
  ) return fail('stored case crossed its contract boundary')
  return Object.freeze(candidate)
}

function caseMongoFields(
  value: SubscriptionDunningCaseDraft | SubscriptionDunningCaseUpdate,
) {
  return {
    ...value,
    subscriptionId: value.subscriptionId,
    userId: value.userId,
    paidPeriodStart: new Date(value.paidPeriodStart),
    paidPeriodEnd: new Date(value.paidPeriodEnd),
    statusObservedAt: new Date(value.statusObservedAt),
    firstPendingObservedAt: value.firstPendingObservedAt === null
      ? null
      : new Date(value.firstPendingObservedAt),
    graceEndsAt: value.graceEndsAt === null
      ? null
      : new Date(value.graceEndsAt),
    nextActionAt: value.nextActionAt === null
      ? null
      : new Date(value.nextActionAt),
  }
}

export async function createMongoDunningPersistence(
  session: ClientSession,
): Promise<SubscriptionDunningCasePersistencePort> {
  if (!session?.inTransaction()) {
    return fail('caller transaction is unavailable')
  }
  const [caseModule, eventModule] = await Promise.all([
    import(
      '@payment-subscription-dunning/models/SubscriptionDunningCase'
    ),
    import(
      '@payment-subscription-dunning/models/SubscriptionDunningEvent'
    ),
  ])
  const transaction: SubscriptionDunningCasePersistenceTransaction = {
    async loadCase(identity: SubscriptionDunningCaseIdentity) {
      const row = await caseModule.SubscriptionDunningCase.findOne({
        providerMode: identity.providerMode,
        subscriptionId: identity.subscriptionId,
        paidPeriodKey: identity.paidPeriodKey,
      })
        .select(CASE_PROJECTION)
        .session(session)
        .lean()
        .exec()
      return row ? toStoredCase(row) : null
    },

    async createCase(draft: SubscriptionDunningCaseDraft) {
      const created = new caseModule.SubscriptionDunningCase({
          ...caseMongoFields(draft),
          attemptCount: 0,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
        } as never)
      await created.save({ session })
      const row = await caseModule.SubscriptionDunningCase.findById(
        created._id,
      )
        .select(CASE_PROJECTION)
        .session(session)
        .lean()
        .exec()
      if (!row) return fail('created case could not be reloaded')
      return toStoredCase(row)
    },

    async compareAndSwapCase(input) {
      const update = input.update
      if (
        update.revision !== input.expectedRevision + 1 ||
        update.lastEventSequence !== update.revision
      ) return fail('case CAS counters are inconsistent')
      const document = await caseModule.SubscriptionDunningCase
        .findOneAndUpdate(
          {
            _id: input.caseId,
            schemaVersion: update.schemaVersion,
            policyVersion: update.policyVersion,
            providerMode: update.providerMode,
            subscriptionId: update.subscriptionId,
            userId: update.userId,
            paidPeriodKey: update.paidPeriodKey,
            paidPeriodStart: new Date(update.paidPeriodStart),
            paidPeriodEnd: new Date(update.paidPeriodEnd),
            revision: input.expectedRevision,
            lastEventSequence: update.lastEventSequence - 1,
          },
          {
            $set: {
              providerStatus: update.providerStatus,
              statusVersion: update.statusVersion,
              clockAuthority: update.clockAuthority,
              statusObservedAt: new Date(update.statusObservedAt),
              firstPendingObservedAt:
                update.firstPendingObservedAt === null
                  ? null
                  : new Date(update.firstPendingObservedAt),
              remoteRetryingConfirmed:
                update.remoteRetryingConfirmed,
              renewalCycleCaptured: update.renewalCycleCaptured,
              accessOverride: update.accessOverride,
              sourceEvidenceDigest: update.sourceEvidenceDigest,
              classification: update.classification,
              reason: update.reason,
              configuredGraceMs: update.configuredGraceMs,
              graceEndsAt: update.graceEndsAt === null
                ? null
                : new Date(update.graceEndsAt),
              nextActionAt: update.nextActionAt === null
                ? null
                : new Date(update.nextActionAt),
              provisionalGrant: update.provisionalGrant,
              provisionalInterviewState:
                update.provisionalInterviewState,
              revision: update.revision,
              lastEventSequence: update.lastEventSequence,
              decisionDigest: update.decisionDigest,
            },
          },
          { new: true, runValidators: true, session },
        )
        .exec()
      if (!document) return null
      await document.validate()
      const row = await caseModule.SubscriptionDunningCase.findById(
        document._id,
      )
        .select(CASE_PROJECTION)
        .session(session)
        .lean()
        .exec()
      if (!row) return fail('updated case could not be reloaded')
      return toStoredCase(row)
    },

    async appendEvent(event: SubscriptionDunningEventDraft) {
      if (
        event.schemaVersion !==
          SUBSCRIPTION_DUNNING_EVENT_SCHEMA_VERSION
      ) return fail('event schema version is invalid')
      const caseFilter: Record<string, unknown> = {
        _id: event.caseId,
        schemaVersion: SUBSCRIPTION_DUNNING_CASE_SCHEMA_VERSION,
        policyVersion: event.policyVersion,
        providerMode: event.providerMode,
        revision: event.sequence,
        lastEventSequence: event.sequence,
        providerStatus: event.providerStatus,
        statusVersion: event.statusVersion,
        classification: event.classification,
        reason: event.reason,
        decisionDigest: event.decisionDigest,
      }
      if (
        event.kind === 'created' ||
        event.kind === 'transitioned' ||
        event.kind === 'reviewed' ||
        event.kind === 'recovered'
      ) {
        caseFilter.sourceEvidenceDigest = event.sourceEvidenceDigest
        caseFilter.statusObservedAt = new Date(event.occurredAt)
      }
      const current = await caseModule.SubscriptionDunningCase.exists(
        caseFilter,
      ).session(session)
      if (!current) return fail('event lacks its exact case transition')
      await eventModule.SubscriptionDunningEvent.create([{
        ...event,
        caseId: event.caseId,
        occurredAt: new Date(event.occurredAt),
      }], { session })
    },
  }
  return Object.freeze({
    async runTransaction<T>(work: (
      value: SubscriptionDunningCasePersistenceTransaction,
    ) => Promise<T>): Promise<T> {
      if (!session.inTransaction()) {
        return fail('caller transaction ended before dunning write')
      }
      return work(transaction)
    },
  })
}

function exactCurrentLineage(input: {
  current: StoredSubscriptionDunningCase
  evidence: SubscriptionStateDunningEvidence
}): void {
  if (
    input.current.providerMode !== input.evidence.providerMode ||
    input.current.subscriptionId !==
      input.evidence.localSubscriptionId ||
    input.current.userId !== input.evidence.userId ||
    input.current.paidPeriodKey !== input.evidence.paidPeriod.key ||
    input.current.paidPeriodStart !==
      input.evidence.paidPeriod.start.toISOString() ||
    input.current.paidPeriodEnd !==
      input.evidence.paidPeriod.end.toISOString()
  ) return fail('existing case crossed the paid-period lineage')
}

function buildProducer(
  construction: DunningProducerConstruction = {},
): SubscriptionStateDunningProducer {
  const producer: SubscriptionStateDunningProducer = {
    async appendSubscriptionDunningObservationInSession(
      factory: () => SubscriptionStateDunningEvidence,
      session: ClientSession,
    ) {
      if (
        !PAYMENT_SUBSCRIPTION_DUNNING_CASE_WRITES_READY &&
        !construction.testAuthority
      ) return
      if (!session?.inTransaction()) {
        return fail('caller transaction is unavailable')
      }
      const evidence = exactEvidence(factory())
      const authority = await (
        construction.authorityReader ?? loadExactSourceAuthority
      )(evidence, session)
      const digest = sourceEvidenceDigest({ evidence, authority })
      const persistence = await (
        construction.persistenceFactory ?? createMongoDunningPersistence
      )(session)
      const identity: SubscriptionDunningCaseIdentity = {
        providerMode: evidence.providerMode,
        subscriptionId: evidence.localSubscriptionId,
        paidPeriodKey: evidence.paidPeriod.key,
      }
      const current = await persistence.runTransaction(
        (transaction) => transaction.loadCase(identity),
      )
      if (current) exactCurrentLineage({ current, evidence })
      if (
        current?.sourceEvidenceDigest === digest &&
        current.statusVersion !== null
      ) {
        if (
          current.providerStatus !== evidence.remoteStatus ||
          current.renewalCycleCaptured !==
            evidence.renewalCycleCaptured
        ) return fail('replayed source digest has conflicting state')
        return
      }

      const observedAt = evidence.observedAt.toISOString()
      if (current) {
        if (observedAt < current.statusObservedAt) {
          return fail('older provider evidence cannot replace current state')
        }
        if (observedAt === current.statusObservedAt) {
          return fail('one observation clock has conflicting evidence')
        }
      }
      const currentVersion = current?.statusVersion
      if (currentVersion === Number.MAX_SAFE_INTEGER) {
        return fail('status version is exhausted')
      }
      const statusVersion = currentVersion === null ||
        currentVersion === undefined
        ? 1
        : currentVersion + 1
      const firstPendingObservedAt = evidence.remoteStatus === 'pending'
        ? current?.providerStatus === 'pending' &&
          current.firstPendingObservedAt !== null
          ? current.firstPendingObservedAt
          : observedAt
        : null
      const result = await observeSubscriptionDunningCase({
        schemaVersion:
          SUBSCRIPTION_DUNNING_OBSERVATION_SCHEMA_VERSION,
        providerMode: evidence.providerMode,
        subscriptionId: evidence.localSubscriptionId,
        userId: evidence.userId,
        providerStatus: evidence.remoteStatus,
        statusVersion,
        clockAuthority: 'authoritative',
        statusObservedAt: observedAt,
        firstPendingObservedAt,
        remoteRetryingConfirmed: false,
        renewalCycleCaptured: evidence.renewalCycleCaptured,
        accessOverride: current?.accessOverride ?? 'none',
        paidPeriod: {
          key: evidence.paidPeriod.key,
          start: evidence.paidPeriod.start.toISOString(),
          end: evidence.paidPeriod.end.toISOString(),
        },
        sourceEvidenceDigest: digest,
      }, {
        configuredGraceMs: SUBSCRIPTION_DUNNING_MAX_GRACE_MS,
        persistence,
        now: () => new Date(evidence.observedAt),
        testAuthority: construction.testAuthority,
      })
      if (
        result.outcome === 'disabled' ||
        result.outcome === 'stale'
      ) return fail('dunning observation did not join the transaction')
    },
  }
  return Object.freeze(producer)
}

export const subscriptionStateDunningProducer = buildProducer()

/**
 * Test-only composition constructor. It is intentionally absent from every
 * module barrel and still requires the domain service's private test token.
 */
export function createSubscriptionStateDunningProducerForTest(
  input: SubscriptionStateDunningCompositionTestInput,
): SubscriptionStateDunningProducer {
  if (process.env.NODE_ENV !== 'test') {
    return fail('test composition is unavailable outside tests')
  }
  return buildProducer({
    testAuthority: input.testAuthority,
    authorityReader: input.authorityReader,
    persistenceFactory: input.persistenceFactory,
  })
}
