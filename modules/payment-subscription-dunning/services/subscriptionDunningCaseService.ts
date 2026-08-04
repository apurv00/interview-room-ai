import { createHash } from 'node:crypto'
import {
  SUBSCRIPTION_DUNNING_CASE_SCHEMA_VERSION,
  SUBSCRIPTION_DUNNING_EVENT_SCHEMA_VERSION,
  SUBSCRIPTION_DUNNING_POLICY_VERSION,
  SUBSCRIPTION_DUNNING_SCAN_MAX_PAGES,
  SUBSCRIPTION_DUNNING_SCAN_PAGE_SIZE,
  SubscriptionDunningDueCandidateSchema,
  SubscriptionDunningObservationSchema,
  SubscriptionDunningProvisionalGrantSchema,
  SubscriptionDunningScanCursorSchema,
  SubscriptionDunningScanInputSchema,
  provisionalInterviewStateFromGrant,
  type StoredSubscriptionDunningCase,
  type SubscriptionDunningCaseDraft,
  type SubscriptionDunningCaseIdentity,
  type SubscriptionDunningCaseUpdate,
  type SubscriptionDunningDueCandidate,
  type SubscriptionDunningEventDraft,
  type SubscriptionDunningEventKind,
  type SubscriptionDunningObservation,
  type SubscriptionDunningProvisionalGrant,
  type SubscriptionDunningProviderMode,
  type SubscriptionDunningScanCursor,
} from '../contracts'
import {
  PAYMENT_SUBSCRIPTION_DUNNING_CASE_WRITES_READY,
  PAYMENT_SUBSCRIPTION_DUNNING_JOB_EXECUTION_READY,
} from '../gates'
import {
  classifySubscriptionDunning,
  type SubscriptionDunningPolicyError,
} from '../subscriptionDunningPolicyKernel'

const OBJECT_ID = /^[a-f0-9]{24}$/
const DIGEST = /^[a-f0-9]{64}$/

export const SUBSCRIPTION_DUNNING_CASE_ERROR_CODES = [
  'invalid_input',
  'dependency_not_configured',
  'identity_conflict',
  'version_conflict',
  'observation_order_conflict',
  'persistence_conflict',
  'candidate_page_invalid',
] as const
export type SubscriptionDunningCaseErrorCode =
  (typeof SUBSCRIPTION_DUNNING_CASE_ERROR_CODES)[number]

export class SubscriptionDunningCaseError extends Error {
  constructor(
    readonly code: SubscriptionDunningCaseErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SubscriptionDunningCaseError'
  }
}

function failure(
  code: SubscriptionDunningCaseErrorCode,
  message: string,
  cause?: unknown,
): SubscriptionDunningCaseError {
  return new SubscriptionDunningCaseError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  )
}

export interface SubscriptionDunningCasePersistenceTransaction {
  loadCase(
    identity: SubscriptionDunningCaseIdentity,
  ): Promise<StoredSubscriptionDunningCase | null>
  createCase(
    draft: SubscriptionDunningCaseDraft,
  ): Promise<StoredSubscriptionDunningCase>
  compareAndSwapCase(input: {
    readonly caseId: string
    readonly expectedRevision: number
    readonly update: SubscriptionDunningCaseUpdate
  }): Promise<StoredSubscriptionDunningCase | null>
  appendEvent(
    event: SubscriptionDunningEventDraft,
  ): Promise<void>
}

export interface SubscriptionDunningCasePersistencePort {
  runTransaction<T>(
    work: (
      transaction: SubscriptionDunningCasePersistenceTransaction,
    ) => Promise<T>,
  ): Promise<T>
}

export interface SubscriptionDunningDueCandidatePort {
  listDueCandidates(input: {
    readonly providerMode: SubscriptionDunningProviderMode
    readonly asOf: Date
    readonly after?: SubscriptionDunningScanCursor
    readonly limit: typeof SUBSCRIPTION_DUNNING_SCAN_PAGE_SIZE
  }): Promise<ReadonlyArray<unknown>>
}

const TEST_AUTHORITY = Symbol(
  'subscription-dunning-case-service-test-authority',
)
export interface SubscriptionDunningCaseServiceTestAuthority {
  readonly token: symbol
}

/**
 * Deliberately absent from the public module barrel. It permits injected,
 * in-memory contract tests to exercise dark services without weakening any
 * production gate.
 */
export function createSubscriptionDunningCaseServiceTestAuthorityForTest():
SubscriptionDunningCaseServiceTestAuthority {
  return Object.freeze({ token: TEST_AUTHORITY })
}

function testAuthorized(
  authority:
    | SubscriptionDunningCaseServiceTestAuthority
    | undefined,
): boolean {
  return authority?.token === TEST_AUTHORITY
}

export type SubscriptionDunningObservationResult =
  | {
      readonly outcome: 'disabled'
      readonly reason: 'case_writes_not_ready'
    }
  | {
      readonly outcome:
        | 'created'
        | 'updated'
        | 'replayed'
        | 'stale'
      readonly case: StoredSubscriptionDunningCase
    }

export type SubscriptionDunningScanResult =
  | {
      readonly outcome: 'disabled'
      readonly reason: 'job_execution_not_ready'
      readonly candidates: readonly []
      readonly pagesProcessed: 0
    }
  | {
      readonly outcome: 'completed' | 'work_limit_reached'
      readonly providerMode: SubscriptionDunningProviderMode
      readonly asOf: string
      readonly candidates:
        readonly SubscriptionDunningDueCandidate[]
      readonly pagesProcessed: number
      readonly continuationCursor?:
        SubscriptionDunningScanCursor
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
    'Dunning digest input is not canonicalizable',
  )
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function provisionalGrantDigest(
  grant: SubscriptionDunningProvisionalGrant,
): string {
  const { grantDigest: _storedDigest, ...authority } = grant
  return digest(authority)
}

function exactNow(now: (() => Date) | undefined): Date {
  const value = now?.() ?? new Date()
  if (
    !(value instanceof Date) ||
    !Number.isFinite(value.getTime())
  ) {
    throw failure('invalid_input', 'Dunning service clock is invalid')
  }
  return new Date(value)
}

function parseObservation(
  raw: unknown,
): SubscriptionDunningObservation {
  try {
    return SubscriptionDunningObservationSchema.parse(raw)
  } catch (error) {
    throw failure(
      'invalid_input',
      'Dunning observation contract is invalid',
      error,
    )
  }
}

function identity(
  observation: SubscriptionDunningObservation,
): SubscriptionDunningCaseIdentity {
  return Object.freeze({
    providerMode: observation.providerMode,
    subscriptionId: observation.subscriptionId,
    paidPeriodKey: observation.paidPeriod.key,
  })
}

function assertStoredCase(
  row: StoredSubscriptionDunningCase,
  expected: SubscriptionDunningCaseIdentity,
): void {
  if (
    !row ||
    typeof row !== 'object' ||
    !OBJECT_ID.test(row.id) ||
    row.schemaVersion !==
      SUBSCRIPTION_DUNNING_CASE_SCHEMA_VERSION ||
    row.policyVersion !== SUBSCRIPTION_DUNNING_POLICY_VERSION ||
    row.providerMode !== expected.providerMode ||
    row.subscriptionId !== expected.subscriptionId ||
    row.paidPeriodKey !== expected.paidPeriodKey ||
    !OBJECT_ID.test(row.userId) ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    !Number.isSafeInteger(row.lastEventSequence) ||
    row.lastEventSequence < 1 ||
    !DIGEST.test(row.sourceEvidenceDigest) ||
    !DIGEST.test(row.decisionDigest) ||
    (
      row.provisionalGrant !== null &&
      (
        !SubscriptionDunningProvisionalGrantSchema.safeParse(
          row.provisionalGrant,
        ).success ||
        provisionalGrantDigest(row.provisionalGrant) !==
          row.provisionalGrant.grantDigest
      )
    ) ||
    row.provisionalInterviewState !==
      provisionalInterviewStateFromGrant(row.provisionalGrant)
  ) {
    throw failure(
      'persistence_conflict',
      'Stored dunning case crossed its authority boundary',
    )
  }
}

function assertCaseLineage(
  row: StoredSubscriptionDunningCase,
  observation: SubscriptionDunningObservation,
): void {
  if (
    row.userId !== observation.userId ||
    row.paidPeriodStart !== observation.paidPeriod.start ||
    row.paidPeriodEnd !== observation.paidPeriod.end
  ) {
    throw failure(
      'identity_conflict',
      'Dunning case immutable paid authority changed',
    )
  }
}

export function policyDecisionDigest(input: {
  observation: SubscriptionDunningObservation
  configuredGraceMs: number
  classification: string
  reason: string
  graceEndsAt: string | null
  nextActionAt: string | null
  provisionalInterviewState: string
  provisionalGrantDigest: string | null
}): string {
  return digest({
    schemaVersion: SUBSCRIPTION_DUNNING_CASE_SCHEMA_VERSION,
    policyVersion: SUBSCRIPTION_DUNNING_POLICY_VERSION,
    observation: input.observation,
    configuredGraceMs: input.configuredGraceMs,
    classification: input.classification,
    reason: input.reason,
    graceEndsAt: input.graceEndsAt,
    nextActionAt: input.nextActionAt,
    provisionalInterviewState:
      input.provisionalInterviewState,
    ...(input.provisionalGrantDigest === null
      ? {}
      : {
          provisionalGrantDigest:
            input.provisionalGrantDigest,
        }),
  })
}

function caseFields(input: {
  observation: SubscriptionDunningObservation
  configuredGraceMs: unknown
  now: Date
  provisionalGrant: SubscriptionDunningProvisionalGrant | null
}): Omit<
  SubscriptionDunningCaseDraft,
  'revision' | 'lastEventSequence'
> {
  const provisionalInterviewState =
    provisionalInterviewStateFromGrant(input.provisionalGrant)
  let policy
  try {
    policy = classifySubscriptionDunning({
      observation: input.observation,
      now: input.now,
      configuredGraceMs: input.configuredGraceMs,
      provisionalInterviewState:
        provisionalInterviewState,
    })
  } catch (error) {
    throw failure(
      'invalid_input',
      'Dunning policy rejected its observation',
      error as SubscriptionDunningPolicyError,
    )
  }
  const graceEndsAt =
    policy.graceEndsAt?.toISOString() ?? null
  const nextActionAt =
    policy.nextActionAt?.toISOString() ?? null
  const decisionDigest = policyDecisionDigest({
    observation: input.observation,
    configuredGraceMs: policy.configuredGraceMs,
    classification: policy.classification,
    reason: policy.reason,
    graceEndsAt,
    nextActionAt,
    provisionalInterviewState:
      provisionalInterviewState,
    provisionalGrantDigest:
      input.provisionalGrant?.grantDigest ?? null,
  })
  return Object.freeze({
    schemaVersion: SUBSCRIPTION_DUNNING_CASE_SCHEMA_VERSION,
    policyVersion: SUBSCRIPTION_DUNNING_POLICY_VERSION,
    providerMode: input.observation.providerMode,
    subscriptionId: input.observation.subscriptionId,
    userId: input.observation.userId,
    paidPeriodKey: input.observation.paidPeriod.key,
    paidPeriodStart: input.observation.paidPeriod.start,
    paidPeriodEnd: input.observation.paidPeriod.end,
    providerStatus: input.observation.providerStatus,
    statusVersion: input.observation.statusVersion,
    clockAuthority: input.observation.clockAuthority,
    statusObservedAt: input.observation.statusObservedAt,
    firstPendingObservedAt:
      input.observation.firstPendingObservedAt,
    remoteRetryingConfirmed:
      input.observation.remoteRetryingConfirmed,
    renewalCycleCaptured:
      input.observation.renewalCycleCaptured,
    accessOverride: input.observation.accessOverride,
    sourceEvidenceDigest:
      input.observation.sourceEvidenceDigest,
    classification: policy.classification,
    reason: policy.reason,
    configuredGraceMs: policy.configuredGraceMs,
    graceEndsAt,
    nextActionAt,
    provisionalInterviewState:
      provisionalInterviewState,
    provisionalGrant: input.provisionalGrant,
    decisionDigest,
  })
}

function eventKind(
  classification: string,
  creating: boolean,
): SubscriptionDunningEventKind {
  if (creating) return 'created'
  if (classification === 'review') return 'reviewed'
  if (classification === 'recovered') return 'recovered'
  return 'transitioned'
}

function eventDraft(input: {
  caseId: string
  sequence: number
  fields: ReturnType<typeof caseFields>
  priorClassification:
    StoredSubscriptionDunningCase['classification'] | null
}): SubscriptionDunningEventDraft {
  const event = {
    schemaVersion: SUBSCRIPTION_DUNNING_EVENT_SCHEMA_VERSION,
    policyVersion: SUBSCRIPTION_DUNNING_POLICY_VERSION,
    caseId: input.caseId,
    sequence: input.sequence,
    kind: eventKind(
      input.fields.classification,
      input.priorClassification === null,
    ),
    providerMode: input.fields.providerMode,
    providerStatus: input.fields.providerStatus,
    statusVersion: input.fields.statusVersion,
    priorClassification: input.priorClassification,
    classification: input.fields.classification,
    reason: input.fields.reason,
    occurredAt: input.fields.statusObservedAt,
    sourceEvidenceDigest:
      input.fields.sourceEvidenceDigest,
    decisionDigest: input.fields.decisionDigest,
  } as const
  return Object.freeze({
    ...event,
    eventDigest: digest(event),
  })
}

function sameVersionReplay(
  current: StoredSubscriptionDunningCase,
  fields: ReturnType<typeof caseFields>,
): boolean {
  return (
    current.providerStatus === fields.providerStatus &&
    current.statusObservedAt === fields.statusObservedAt &&
    current.sourceEvidenceDigest ===
      fields.sourceEvidenceDigest &&
    current.decisionDigest === fields.decisionDigest
  )
}

function observationDisposition(input: {
  current: StoredSubscriptionDunningCase
  observation: SubscriptionDunningObservation
  fields: ReturnType<typeof caseFields>
}): 'advance' | 'replay' | 'stale' {
  const { current, observation, fields } = input
  if (observation.statusVersion === null) {
    if (current.statusVersion !== null) return 'stale'
    if (sameVersionReplay(current, fields)) return 'replay'
    throw failure(
      'version_conflict',
      'Unversioned legacy evidence cannot replace a dunning case',
    )
  }
  if (current.statusVersion === null) {
    if (
      new Date(observation.statusObservedAt) <
        new Date(current.statusObservedAt)
    ) return 'stale'
    return 'advance'
  }
  if (observation.statusVersion < current.statusVersion) {
    return 'stale'
  }
  if (observation.statusVersion === current.statusVersion) {
    if (sameVersionReplay(current, fields)) return 'replay'
    throw failure(
      'version_conflict',
      'One provider status version has conflicting evidence',
    )
  }
  if (
    new Date(observation.statusObservedAt) <
      new Date(current.statusObservedAt)
  ) {
    throw failure(
      'observation_order_conflict',
      'A newer status version has an older observation clock',
    )
  }
  return 'advance'
}

/**
 * Records only a local policy case and append-only event through an injected
 * transactional port. The literal false gate is checked before parsing input,
 * reading a clock, or touching the port.
 */
export async function observeSubscriptionDunningCase(
  rawObservation: unknown,
  dependencies: {
    readonly configuredGraceMs?: unknown
    readonly persistence?: SubscriptionDunningCasePersistencePort
    readonly now?: () => Date
    readonly testAuthority?:
      SubscriptionDunningCaseServiceTestAuthority
  } = {},
): Promise<SubscriptionDunningObservationResult> {
  if (
    !PAYMENT_SUBSCRIPTION_DUNNING_CASE_WRITES_READY &&
    !testAuthorized(dependencies.testAuthority)
  ) {
    return {
      outcome: 'disabled',
      reason: 'case_writes_not_ready',
    }
  }
  if (!dependencies.persistence) {
    throw failure(
      'dependency_not_configured',
      'Dunning case persistence is not configured',
    )
  }
  const observation = parseObservation(rawObservation)
  const caseIdentity = identity(observation)
  const now = exactNow(dependencies.now)
  const configuredGraceMs =
    dependencies.configuredGraceMs ?? 0

  return dependencies.persistence.runTransaction(
    async (transaction) => {
      const current = await transaction.loadCase(caseIdentity)
      if (current) {
        assertStoredCase(current, caseIdentity)
        assertCaseLineage(current, observation)
      }
      const fields = caseFields({
        observation,
        configuredGraceMs,
        now,
        provisionalGrant: current?.provisionalGrant ?? null,
      })
      if (!current) {
        const created = await transaction.createCase({
          ...fields,
          revision: 1,
          lastEventSequence: 1,
        })
        assertStoredCase(created, caseIdentity)
        assertCaseLineage(created, observation)
        await transaction.appendEvent(eventDraft({
          caseId: created.id,
          sequence: 1,
          fields,
          priorClassification: null,
        }))
        return { outcome: 'created', case: created }
      }

      const disposition = observationDisposition({
        current,
        observation,
        fields,
      })
      if (disposition === 'replay') {
        return { outcome: 'replayed', case: current }
      }
      if (disposition === 'stale') {
        return { outcome: 'stale', case: current }
      }
      if (
        current.revision >= Number.MAX_SAFE_INTEGER ||
        current.lastEventSequence >= Number.MAX_SAFE_INTEGER
      ) {
        throw failure(
          'persistence_conflict',
          'Dunning case counters are exhausted',
        )
      }
      const update: SubscriptionDunningCaseUpdate = {
        ...fields,
        revision: current.revision + 1,
        lastEventSequence: current.lastEventSequence + 1,
      }
      const updated = await transaction.compareAndSwapCase({
        caseId: current.id,
        expectedRevision: current.revision,
        update,
      })
      if (!updated) {
        throw failure(
          'persistence_conflict',
          'Dunning case CAS did not match',
        )
      }
      assertStoredCase(updated, caseIdentity)
      assertCaseLineage(updated, observation)
      await transaction.appendEvent(eventDraft({
        caseId: current.id,
        sequence: update.lastEventSequence,
        fields,
        priorClassification: current.classification,
      }))
      return { outcome: 'updated', case: updated }
    },
  )
}

function exactCandidatePage(input: {
  values: ReadonlyArray<unknown>
  providerMode: SubscriptionDunningProviderMode
  asOf: Date
  cursor?: SubscriptionDunningScanCursor
}): SubscriptionDunningDueCandidate[] {
  if (
    !Array.isArray(input.values) ||
    input.values.length >
      SUBSCRIPTION_DUNNING_SCAN_PAGE_SIZE
  ) {
    throw failure(
      'candidate_page_invalid',
      'Dunning candidate page exceeded its bound',
    )
  }
  let prior = input.cursor
  return input.values.map((raw) => {
    let candidate: SubscriptionDunningDueCandidate
    try {
      candidate =
        SubscriptionDunningDueCandidateSchema.parse(raw)
    } catch (error) {
      throw failure(
        'candidate_page_invalid',
        'Dunning candidate contract is invalid',
        error,
      )
    }
    if (
      candidate.providerMode !== input.providerMode ||
      (
        prior !== undefined &&
        (
          candidate.nextActionAt < prior.nextActionAt ||
          (
            candidate.nextActionAt === prior.nextActionAt &&
            candidate.caseId <= prior.caseId
          )
        )
      ) ||
      new Date(candidate.nextActionAt) > input.asOf
    ) {
      throw failure(
        'candidate_page_invalid',
        'Dunning candidate crossed its stable scan boundary',
      )
    }
    prior = SubscriptionDunningScanCursorSchema.parse({
      nextActionAt: candidate.nextActionAt,
      caseId: candidate.caseId,
    })
    return Object.freeze({ ...candidate })
  })
}

/**
 * Bounded read-only scanner. It returns candidate contracts for an app-owned
 * scheduler; it does not enqueue, mutate, fetch provider state, communicate,
 * grant access, or perform fallback.
 */
export async function scanDueSubscriptionDunningCases(
  rawInput: unknown,
  dependencies: {
    readonly candidates?: SubscriptionDunningDueCandidatePort
    readonly testAuthority?:
      SubscriptionDunningCaseServiceTestAuthority
  } = {},
): Promise<SubscriptionDunningScanResult> {
  if (
    !PAYMENT_SUBSCRIPTION_DUNNING_JOB_EXECUTION_READY &&
    !testAuthorized(dependencies.testAuthority)
  ) {
    return {
      outcome: 'disabled',
      reason: 'job_execution_not_ready',
      candidates: [],
      pagesProcessed: 0,
    }
  }
  if (!dependencies.candidates) {
    throw failure(
      'dependency_not_configured',
      'Dunning candidate port is not configured',
    )
  }
  let input
  try {
    input = SubscriptionDunningScanInputSchema.parse(rawInput)
  } catch (error) {
    throw failure(
      'invalid_input',
      'Dunning scan input is invalid',
      error,
    )
  }
  const asOf = new Date(input.asOf)
  const candidates: SubscriptionDunningDueCandidate[] = []
  let cursor = input.cursor

  for (
    let pageNumber = 0;
    pageNumber < SUBSCRIPTION_DUNNING_SCAN_MAX_PAGES;
    pageNumber += 1
  ) {
    const page = exactCandidatePage({
      values: await dependencies.candidates.listDueCandidates({
        providerMode: input.providerMode,
        asOf: new Date(asOf),
        ...(cursor ? { after: cursor } : {}),
        limit: SUBSCRIPTION_DUNNING_SCAN_PAGE_SIZE,
      }),
      providerMode: input.providerMode,
      asOf,
      cursor,
    })
    candidates.push(...page)
    if (page.length < SUBSCRIPTION_DUNNING_SCAN_PAGE_SIZE) {
      return {
        outcome: 'completed',
        providerMode: input.providerMode,
        asOf: input.asOf,
        candidates: Object.freeze([...candidates]),
        pagesProcessed: pageNumber + 1,
      }
    }
    const last = page[page.length - 1]
    cursor = last
      ? SubscriptionDunningScanCursorSchema.parse({
          nextActionAt: last.nextActionAt,
          caseId: last.caseId,
        })
      : cursor
  }

  return {
    outcome: 'work_limit_reached',
    providerMode: input.providerMode,
    asOf: input.asOf,
    candidates: Object.freeze([...candidates]),
    pagesProcessed: SUBSCRIPTION_DUNNING_SCAN_MAX_PAGES,
    ...(cursor ? { continuationCursor: cursor } : {}),
  }
}
