import { createHash } from 'node:crypto'
import {
  SUBSCRIPTION_DUNNING_CASE_SCHEMA_VERSION,
  SUBSCRIPTION_DUNNING_EVENT_SCHEMA_VERSION,
  SUBSCRIPTION_DUNNING_OBSERVATION_SCHEMA_VERSION,
  SUBSCRIPTION_DUNNING_POLICY_VERSION,
  SUBSCRIPTION_DUNNING_PROVISIONAL_GRANT_SCHEMA_VERSION,
  SUBSCRIPTION_DUNNING_PROVISIONAL_RESERVATION_MAX_MS,
  SubscriptionDunningProvisionalGrantCommandSchema,
  SubscriptionDunningProvisionalGrantSchema,
  provisionalInterviewStateFromGrant,
  type StoredSubscriptionDunningCase,
  type SubscriptionDunningCaseIdentity,
  type SubscriptionDunningCaseUpdate,
  type SubscriptionDunningEventDraft,
  type SubscriptionDunningEventKind,
  type SubscriptionDunningObservation,
  type SubscriptionDunningProvisionalGrant,
  type SubscriptionDunningProvisionalGrantCommand,
} from '../contracts'
import {
  PAYMENT_SUBSCRIPTION_DUNNING_GRACE_INTERVIEW_READY,
} from '../gates'
import {
  policyDecisionDigest,
  type SubscriptionDunningCasePersistenceTransaction,
} from './subscriptionDunningCaseService'

const OBJECT_ID = /^[a-f0-9]{24}$/
const DIGEST = /^[a-f0-9]{64}$/

export const SUBSCRIPTION_DUNNING_PROVISIONAL_GRANT_ERROR_CODES = [
  'invalid_input',
  'dependency_not_configured',
  'case_missing',
  'identity_conflict',
  'persistence_conflict',
  'grant_exists',
  'grant_missing',
  'stale_revision',
  'status_version_conflict',
  'session_conflict',
  'usage_conflict',
  'lifecycle_conflict',
  'eligibility_conflict',
  'terminal_conflict',
] as const
export type SubscriptionDunningProvisionalGrantErrorCode =
  (typeof SUBSCRIPTION_DUNNING_PROVISIONAL_GRANT_ERROR_CODES)[number]

export class SubscriptionDunningProvisionalGrantError
  extends Error {
  constructor(
    readonly code: SubscriptionDunningProvisionalGrantErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SubscriptionDunningProvisionalGrantError'
  }
}

function failure(
  code: SubscriptionDunningProvisionalGrantErrorCode,
  message: string,
  cause?: unknown,
): SubscriptionDunningProvisionalGrantError {
  return new SubscriptionDunningProvisionalGrantError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  )
}

const TEST_AUTHORITY = Symbol(
  'subscription-dunning-provisional-grant-test-authority',
)
export interface SubscriptionDunningProvisionalGrantTestAuthority {
  readonly token: symbol
}

/**
 * Deliberately absent from the public barrel. It exists only so in-memory
 * contract tests can exercise a production-dark service.
 */
export function createSubscriptionDunningProvisionalGrantTestAuthorityForTest():
SubscriptionDunningProvisionalGrantTestAuthority {
  return Object.freeze({ token: TEST_AUTHORITY })
}

function testAuthorized(
  authority:
    | SubscriptionDunningProvisionalGrantTestAuthority
    | undefined,
): boolean {
  return authority?.token === TEST_AUTHORITY
}

export type SubscriptionDunningProvisionalGrantResult =
  | {
      readonly outcome: 'disabled'
      readonly reason: 'grace_interview_not_ready'
    }
  | {
      readonly outcome: 'transitioned' | 'replayed'
      readonly case: StoredSubscriptionDunningCase
      readonly grant: SubscriptionDunningProvisionalGrant
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
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(
      (key) => `${JSON.stringify(key)}:${canonical(record[key])}`,
    ).join(',')}}`
  }
  throw failure(
    'invalid_input',
    'Provisional grant digest input is not canonicalizable',
  )
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function grantDigest(
  grant: SubscriptionDunningProvisionalGrant,
): string {
  const { grantDigest: _storedDigest, ...authority } = grant
  return digest(authority)
}

function completeGrant(
  authority: Omit<
    SubscriptionDunningProvisionalGrant,
    'grantDigest'
  > | SubscriptionDunningProvisionalGrant,
): SubscriptionDunningProvisionalGrant {
  const {
    grantDigest: _priorDigest,
    ...digestAuthority
  } = authority as SubscriptionDunningProvisionalGrant
  const grant = {
    ...digestAuthority,
    grantDigest: digest(digestAuthority),
  } satisfies SubscriptionDunningProvisionalGrant
  const parsed =
    SubscriptionDunningProvisionalGrantSchema.safeParse(grant)
  if (!parsed.success) {
    throw failure(
      'lifecycle_conflict',
      'Provisional grant transition produced invalid authority',
      parsed.error,
    )
  }
  return Object.freeze({
    ...parsed.data,
    capturedTargetCycle: parsed.data.capturedTargetCycle
      ? Object.freeze({ ...parsed.data.capturedTargetCycle })
      : null,
  })
}

function parseCommand(
  raw: unknown,
): SubscriptionDunningProvisionalGrantCommand {
  try {
    return SubscriptionDunningProvisionalGrantCommandSchema
      .parse(raw)
  } catch (error) {
    throw failure(
      'invalid_input',
      'Provisional grant command is invalid',
      error,
    )
  }
}

function identity(
  command: SubscriptionDunningProvisionalGrantCommand,
): SubscriptionDunningCaseIdentity {
  return Object.freeze({
    providerMode: command.providerMode,
    subscriptionId: command.subscriptionId,
    paidPeriodKey: command.paidPeriodKey,
  })
}

function assertStoredCase(
  row: StoredSubscriptionDunningCase,
  command: SubscriptionDunningProvisionalGrantCommand,
): void {
  const grant = row.provisionalGrant
  if (
    !row ||
    typeof row !== 'object' ||
    !OBJECT_ID.test(row.id) ||
    row.schemaVersion !== SUBSCRIPTION_DUNNING_CASE_SCHEMA_VERSION ||
    row.policyVersion !== SUBSCRIPTION_DUNNING_POLICY_VERSION ||
    row.id !== command.caseId ||
    row.providerMode !== command.providerMode ||
    row.subscriptionId !== command.subscriptionId ||
    row.paidPeriodKey !== command.paidPeriodKey ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    !Number.isSafeInteger(row.lastEventSequence) ||
    row.lastEventSequence < 1 ||
    !DIGEST.test(row.sourceEvidenceDigest) ||
    !DIGEST.test(row.decisionDigest) ||
    (
      grant !== null &&
      (
        !SubscriptionDunningProvisionalGrantSchema.safeParse(grant)
          .success ||
        grantDigest(grant) !== grant.grantDigest
      )
    ) ||
    row.provisionalInterviewState !==
      provisionalInterviewStateFromGrant(grant)
  ) {
    throw failure(
      'persistence_conflict',
      'Stored dunning case crossed provisional authority',
    )
  }
}

function assertNoCompetingAuthority(
  grant: SubscriptionDunningProvisionalGrant | null,
  command: SubscriptionDunningProvisionalGrantCommand,
): void {
  if (command.operation === 'offer') {
    if (grant !== null) {
      throw failure(
        'grant_exists',
        'One paid period may carry only one provisional grant',
      )
    }
    return
  }
  if (grant === null) {
    throw failure(
      'grant_missing',
      'Provisional grant does not exist for this paid period',
    )
  }
  if (grant.grantId !== command.grantId) {
    throw failure(
      'identity_conflict',
      'Command grant ID does not match the period authority',
    )
  }
  if (
    command.operation === 'reserve' &&
    grant.reservedSessionId !== null &&
    grant.reservedSessionId !== command.reservedSessionId
  ) {
    throw failure(
      'session_conflict',
      'A competing session cannot reserve this grant',
    )
  }
  if (
    command.operation === 'consume' &&
    grant.reservedSessionId !== command.reservedSessionId
  ) {
    throw failure(
      'session_conflict',
      'A competing session cannot consume this grant',
    )
  }
  if (
    command.operation === 'consume' &&
    grant.usageReferenceId !== null &&
    grant.usageReferenceId !== command.usageReferenceId
  ) {
    throw failure(
      'usage_conflict',
      'A consumed grant cannot bind competing usage evidence',
    )
  }
  assertNotTerminal(grant)
}

function assertExpectedAuthority(
  current: StoredSubscriptionDunningCase,
  command: SubscriptionDunningProvisionalGrantCommand,
): void {
  if (
    current.clockAuthority !== 'authoritative' ||
    current.statusVersion === null ||
    current.statusVersion !== command.expectedStatusVersion
  ) {
    throw failure(
      'status_version_conflict',
      'Provider status authority changed before grant mutation',
    )
  }
  if (current.revision !== command.expectedCaseRevision) {
    throw failure(
      'stale_revision',
      'Dunning case revision changed before grant mutation',
    )
  }
  if (
    command.operation !== 'offer' &&
    current.provisionalGrant?.revision !==
      command.expectedGrantRevision
  ) {
    throw failure(
      'stale_revision',
      'Provisional grant revision changed before mutation',
    )
  }
}

function assertPendingEligibility(
  current: StoredSubscriptionDunningCase,
): string {
  if (
    current.classification !== 'pending_grace_candidate' ||
    current.providerStatus !== 'pending' ||
    !current.remoteRetryingConfirmed ||
    current.renewalCycleCaptured ||
    current.graceEndsAt === null
  ) {
    throw failure(
      'eligibility_conflict',
      'Case is not authoritative pending-grace eligibility',
    )
  }
  return current.graceEndsAt
}

function assertNotTerminal(
  grant: SubscriptionDunningProvisionalGrant,
): void {
  if (grant.terminalOutcome !== null) {
    throw failure(
      'terminal_conflict',
      'A terminal provisional grant cannot transition again',
    )
  }
}

function offeredGrant(
  current: StoredSubscriptionDunningCase,
  command: Extract<
    SubscriptionDunningProvisionalGrantCommand,
    { operation: 'offer' }
  >,
  commandDigest: string,
): SubscriptionDunningProvisionalGrant {
  const graceEndsAt = assertPendingEligibility(current)
  if (
    new Date(command.occurredAt) <
      new Date(current.paidPeriodEnd) ||
    new Date(command.occurredAt) <
      new Date(current.statusObservedAt) ||
    new Date(command.occurredAt) >= new Date(graceEndsAt)
  ) {
    throw failure(
      'eligibility_conflict',
      'Grant offer is outside the exact pending-grace window',
    )
  }
  return completeGrant({
    schemaVersion:
      SUBSCRIPTION_DUNNING_PROVISIONAL_GRANT_SCHEMA_VERSION,
    grantId: command.grantId,
    revision: 1,
    state: 'available',
    originStatusVersion: command.expectedStatusVersion,
    lastStatusVersion: command.expectedStatusVersion,
    offeredAt: command.occurredAt,
    reservedSessionId: null,
    usageReferenceId: null,
    reservedAt: null,
    consumedAt: null,
    terminalOutcome: null,
    finalizedAt: null,
    capturedTargetCycle: null,
    offerEvidenceDigest: command.evidenceDigest,
    lastEvidenceDigest: command.evidenceDigest,
    lastCommandDigest: commandDigest,
  })
}

function reservedGrant(
  current: StoredSubscriptionDunningCase,
  grant: SubscriptionDunningProvisionalGrant,
  command: Extract<
    SubscriptionDunningProvisionalGrantCommand,
    { operation: 'reserve' }
  >,
  commandDigest: string,
): SubscriptionDunningProvisionalGrant {
  const graceEndsAt = assertPendingEligibility(current)
  assertNotTerminal(grant)
  if (
    grant.state !== 'available' ||
    new Date(command.occurredAt) < new Date(grant.offeredAt) ||
    new Date(command.occurredAt) >= new Date(graceEndsAt)
  ) {
    throw failure(
      'lifecycle_conflict',
      'Only an available in-window grant can be reserved',
    )
  }
  return completeGrant({
    ...grant,
    revision: grant.revision + 1,
    state: 'reserved',
    lastStatusVersion: command.expectedStatusVersion,
    reservedSessionId: command.reservedSessionId,
    reservedAt: command.occurredAt,
    lastEvidenceDigest: command.evidenceDigest,
    lastCommandDigest: commandDigest,
  })
}

function consumedGrant(
  current: StoredSubscriptionDunningCase,
  grant: SubscriptionDunningProvisionalGrant,
  command: Extract<
    SubscriptionDunningProvisionalGrantCommand,
    { operation: 'consume' }
  >,
  commandDigest: string,
): SubscriptionDunningProvisionalGrant {
  assertPendingEligibility(current)
  assertNotTerminal(grant)
  const reservedAt = grant.reservedAt
  if (
    grant.state !== 'reserved' ||
    reservedAt === null ||
    grant.reservedSessionId !== command.reservedSessionId ||
    new Date(command.occurredAt) < new Date(reservedAt) ||
    new Date(command.occurredAt).getTime() >
      new Date(reservedAt).getTime() +
        SUBSCRIPTION_DUNNING_PROVISIONAL_RESERVATION_MAX_MS
  ) {
    throw failure(
      'lifecycle_conflict',
      'Only the reserved session may consume within 30 minutes',
    )
  }
  return completeGrant({
    ...grant,
    revision: grant.revision + 1,
    state: 'consumed',
    lastStatusVersion: command.expectedStatusVersion,
    usageReferenceId: command.usageReferenceId,
    consumedAt: command.occurredAt,
    lastEvidenceDigest: command.evidenceDigest,
    lastCommandDigest: commandDigest,
  })
}

function expiredGrant(
  current: StoredSubscriptionDunningCase,
  grant: SubscriptionDunningProvisionalGrant,
  command: Extract<
    SubscriptionDunningProvisionalGrantCommand,
    { operation: 'finalize_uncaptured_expiry' }
  >,
  commandDigest: string,
): SubscriptionDunningProvisionalGrant {
  assertNotTerminal(grant)
  const fallbackClassifications = [
    'pending_fallback_due',
    'halted_fallback_due',
    'paused_action_required',
    'terminal_fallback_due',
  ] as const
  if (
    current.renewalCycleCaptured ||
    !fallbackClassifications.includes(
      current.classification as
        (typeof fallbackClassifications)[number],
    ) ||
    current.graceEndsAt === null ||
    (
      grant.state !== 'available' &&
      grant.state !== 'reserved' &&
      grant.state !== 'consumed'
    )
  ) {
    throw failure(
      'eligibility_conflict',
      'Case is not eligible for uncaptured expiry finalization',
    )
  }
  let finalizationAt = new Date(current.graceEndsAt).getTime()
  if (grant.state === 'reserved' && grant.reservedAt !== null) {
    finalizationAt = Math.max(
      finalizationAt,
      new Date(grant.reservedAt).getTime() +
        SUBSCRIPTION_DUNNING_PROVISIONAL_RESERVATION_MAX_MS,
    )
  }
  if (new Date(command.occurredAt).getTime() < finalizationAt) {
    throw failure(
      'eligibility_conflict',
      'Provisional grant expiry is not yet due',
    )
  }
  const consumed = grant.state === 'consumed'
  return completeGrant({
    ...grant,
    revision: grant.revision + 1,
    state: consumed ? 'tracked_goodwill' : 'revoked',
    lastStatusVersion: command.expectedStatusVersion,
    terminalOutcome:
      consumed ? 'tracked_goodwill' : 'revoked',
    finalizedAt: command.occurredAt,
    lastEvidenceDigest: command.evidenceDigest,
    lastCommandDigest: commandDigest,
  })
}

function capturedGrant(
  current: StoredSubscriptionDunningCase,
  grant: SubscriptionDunningProvisionalGrant,
  command: Extract<
    SubscriptionDunningProvisionalGrantCommand,
    { operation: 'finalize_captured_renewal' }
  >,
  commandDigest: string,
): SubscriptionDunningProvisionalGrant {
  assertNotTerminal(grant)
  if (
    grant.state !== 'consumed' ||
    current.classification !== 'recovered' ||
    current.reason !== 'renewal_cycle_captured' ||
    current.providerStatus !== 'active' ||
    !current.renewalCycleCaptured ||
    command.targetCycle.subscriptionId !==
      current.subscriptionId ||
    command.targetCycle.paidPeriodKey ===
      current.paidPeriodKey ||
    new Date(command.targetCycle.capturedAt) <
      new Date(current.paidPeriodEnd) ||
    new Date(command.targetCycle.capturedAt) >
      new Date(command.occurredAt)
  ) {
    throw failure(
      'eligibility_conflict',
      'Captured target cycle is not exact renewal authority',
    )
  }
  return completeGrant({
    ...grant,
    revision: grant.revision + 1,
    state: 'counted_against_cycle',
    lastStatusVersion: command.expectedStatusVersion,
    terminalOutcome: 'counted_against_cycle',
    finalizedAt: command.occurredAt,
    capturedTargetCycle: Object.freeze({
      ...command.targetCycle,
    }),
    lastEvidenceDigest: command.evidenceDigest,
    lastCommandDigest: commandDigest,
  })
}

function nextGrant(
  current: StoredSubscriptionDunningCase,
  command: SubscriptionDunningProvisionalGrantCommand,
  commandDigest: string,
): SubscriptionDunningProvisionalGrant {
  const grant = current.provisionalGrant
  if (command.operation === 'offer') {
    if (grant !== null) {
      throw failure(
        'grant_exists',
        'One paid period may carry only one provisional grant',
      )
    }
    return offeredGrant(current, command, commandDigest)
  }
  if (grant === null) {
    throw failure(
      'grant_missing',
      'Provisional grant does not exist for this paid period',
    )
  }
  if (grant.grantId !== command.grantId) {
    throw failure(
      'identity_conflict',
      'Command grant ID does not match the period authority',
    )
  }
  if (
    command.operation === 'reserve' &&
    grant.reservedSessionId !== null &&
    grant.reservedSessionId !== command.reservedSessionId
  ) {
    throw failure(
      'session_conflict',
      'A competing session cannot reserve this grant',
    )
  }
  if (
    command.operation === 'consume' &&
    grant.reservedSessionId !== command.reservedSessionId
  ) {
    throw failure(
      'session_conflict',
      'A competing session cannot consume this grant',
    )
  }
  if (
    command.operation === 'consume' &&
    grant.usageReferenceId !== null &&
    grant.usageReferenceId !== command.usageReferenceId
  ) {
    throw failure(
      'usage_conflict',
      'A consumed grant cannot bind competing usage evidence',
    )
  }
  if (command.operation === 'reserve') {
    return reservedGrant(current, grant, command, commandDigest)
  }
  if (command.operation === 'consume') {
    return consumedGrant(current, grant, command, commandDigest)
  }
  if (command.operation === 'finalize_uncaptured_expiry') {
    return expiredGrant(current, grant, command, commandDigest)
  }
  return capturedGrant(current, grant, command, commandDigest)
}

function observationFromCase(
  current: StoredSubscriptionDunningCase,
): SubscriptionDunningObservation {
  return {
    schemaVersion: SUBSCRIPTION_DUNNING_OBSERVATION_SCHEMA_VERSION,
    providerMode: current.providerMode,
    subscriptionId: current.subscriptionId,
    userId: current.userId,
    providerStatus: current.providerStatus,
    statusVersion: current.statusVersion,
    clockAuthority: current.clockAuthority,
    statusObservedAt: current.statusObservedAt,
    firstPendingObservedAt: current.firstPendingObservedAt,
    remoteRetryingConfirmed: current.remoteRetryingConfirmed,
    renewalCycleCaptured: current.renewalCycleCaptured,
    accessOverride: current.accessOverride,
    paidPeriod: {
      key: current.paidPeriodKey,
      start: current.paidPeriodStart,
      end: current.paidPeriodEnd,
    },
    sourceEvidenceDigest: current.sourceEvidenceDigest,
  }
}

function caseUpdate(
  current: StoredSubscriptionDunningCase,
  grant: SubscriptionDunningProvisionalGrant,
): SubscriptionDunningCaseUpdate {
  const { id: _caseId, ...storedFields } = current
  return Object.freeze({
    ...storedFields,
    provisionalInterviewState:
      provisionalInterviewStateFromGrant(grant),
    provisionalGrant: grant,
    revision: current.revision + 1,
    lastEventSequence: current.lastEventSequence + 1,
    decisionDigest: policyDecisionDigest({
      observation: observationFromCase(current),
      configuredGraceMs: current.configuredGraceMs,
      classification: current.classification,
      reason: current.reason,
      graceEndsAt: current.graceEndsAt,
      nextActionAt: current.nextActionAt,
      provisionalInterviewState:
        provisionalInterviewStateFromGrant(grant),
      provisionalGrantDigest: grant.grantDigest,
    }),
  })
}

function grantEventKind(
  grant: SubscriptionDunningProvisionalGrant,
): SubscriptionDunningEventKind {
  if (grant.state === 'available') {
    return 'provisional_grant_offered'
  }
  if (grant.state === 'reserved') {
    return 'provisional_grant_reserved'
  }
  if (grant.state === 'consumed') {
    return 'provisional_grant_consumed'
  }
  if (grant.state === 'revoked') {
    return 'provisional_grant_revoked'
  }
  if (grant.state === 'tracked_goodwill') {
    return 'provisional_goodwill_tracked'
  }
  return 'provisional_grant_captured'
}

function grantEvent(input: {
  current: StoredSubscriptionDunningCase
  update: SubscriptionDunningCaseUpdate
  grant: SubscriptionDunningProvisionalGrant
  command: SubscriptionDunningProvisionalGrantCommand
}): SubscriptionDunningEventDraft {
  const event = {
    schemaVersion: SUBSCRIPTION_DUNNING_EVENT_SCHEMA_VERSION,
    policyVersion: SUBSCRIPTION_DUNNING_POLICY_VERSION,
    caseId: input.current.id,
    sequence: input.update.lastEventSequence,
    kind: grantEventKind(input.grant),
    providerMode: input.current.providerMode,
    providerStatus: input.current.providerStatus,
    statusVersion: input.current.statusVersion,
    priorClassification: input.current.classification,
    classification: input.current.classification,
    reason: input.current.reason,
    occurredAt: input.command.occurredAt,
    sourceEvidenceDigest: input.command.evidenceDigest,
    decisionDigest: input.update.decisionDigest,
  } as const
  return Object.freeze({
    ...event,
    eventDigest: digest(event),
  })
}

/**
 * Mutates only a local dunning case and its append-only event using one
 * caller-owned transaction. The literal false gate is checked before parsing
 * input or touching that transaction.
 */
export async function transitionSubscriptionDunningProvisionalGrant(
  rawCommand: unknown,
  dependencies: {
    readonly transaction?:
      SubscriptionDunningCasePersistenceTransaction
    readonly testAuthority?:
      SubscriptionDunningProvisionalGrantTestAuthority
  } = {},
): Promise<SubscriptionDunningProvisionalGrantResult> {
  if (
    !PAYMENT_SUBSCRIPTION_DUNNING_GRACE_INTERVIEW_READY &&
    !testAuthorized(dependencies.testAuthority)
  ) {
    return {
      outcome: 'disabled',
      reason: 'grace_interview_not_ready',
    }
  }
  if (!dependencies.transaction) {
    throw failure(
      'dependency_not_configured',
      'Caller-owned dunning transaction is not configured',
    )
  }
  const command = parseCommand(rawCommand)
  const commandDigest = digest(command)
  const current =
    await dependencies.transaction.loadCase(identity(command))
  if (!current) {
    throw failure(
      'case_missing',
      'Dunning case does not exist for this paid period',
    )
  }
  assertStoredCase(current, command)
  const existingGrant = current.provisionalGrant
  if (
    existingGrant !== null &&
    existingGrant.grantId === command.grantId &&
    existingGrant.lastCommandDigest === commandDigest
  ) {
    return {
      outcome: 'replayed',
      case: current,
      grant: existingGrant,
    }
  }
  assertNoCompetingAuthority(existingGrant, command)
  assertExpectedAuthority(current, command)
  if (
    current.revision >= Number.MAX_SAFE_INTEGER ||
    current.lastEventSequence >= Number.MAX_SAFE_INTEGER ||
    (
      existingGrant !== null &&
      existingGrant.revision >= Number.MAX_SAFE_INTEGER
    )
  ) {
    throw failure(
      'persistence_conflict',
      'Provisional grant counters are exhausted',
    )
  }
  const grant = nextGrant(current, command, commandDigest)
  const update = caseUpdate(current, grant)
  const updated =
    await dependencies.transaction.compareAndSwapCase({
      caseId: current.id,
      expectedRevision: current.revision,
      update,
    })
  if (!updated) {
    throw failure(
      'persistence_conflict',
      'Provisional grant case CAS did not match',
    )
  }
  assertStoredCase(updated, command)
  if (
    updated.provisionalGrant?.grantDigest !== grant.grantDigest
  ) {
    throw failure(
      'persistence_conflict',
      'Stored provisional grant did not match its transition',
    )
  }
  await dependencies.transaction.appendEvent(grantEvent({
    current,
    update,
    grant,
    command,
  }))
  return {
    outcome: 'transitioned',
    case: updated,
    grant,
  }
}
