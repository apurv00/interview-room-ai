import mongoose, { type ClientSession } from 'mongoose'
import {
  JOB_SOURCE_CONTROL_INDEX_NAMES,
  JOB_SOURCE_CONTROL_MAX_POSTINGS,
} from '../config/sourceControlLimits'
import { connectDB } from '@shared/db/connection'
import {
  JobIngestCursor,
  JobPosting,
  JobSourceConfig,
  JobSourceControlAudit,
  JobSourceControlMeta,
  JOB_SOURCE_ID_PATTERN,
  JOB_SOURCE_CONTROL_META_ID,
  JOB_SOURCE_LINEAGE_UNKNOWN,
  type JobSourceControlAction,
  type JobSourceHealth,
} from '@shared/db/models'

const TRANSACTION_OPTIONS = {
  readConcern: { level: 'snapshot' as const },
  writeConcern: { w: 'majority' as const },
  readPreference: 'primary' as const,
}

export class SourceAuthorityChangedError extends Error {
  constructor(public readonly sourceId: string, public readonly expectedRevision: number) {
    super(`source authority changed: ${sourceId}@${expectedRevision}`)
    this.name = 'SourceAuthorityChangedError'
  }
}

export class SourceControlNotFoundError extends Error {
  constructor(public readonly sourceId: string) {
    super(`unknown job source: ${sourceId}`)
    this.name = 'SourceControlNotFoundError'
  }
}

export class SourceControlConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SourceControlConflictError'
  }
}

/** Permanent audit/config/lineage evidence disagrees with itself. This is an
 * operational incident, never an ordinary caller conflict. */
export class SourceControlIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SourceControlIntegrityError'
  }
}

export class SourceControlCapacityError extends Error {
  constructor(public readonly postings: number, public readonly limit: number) {
    super(`job source control retained corpus ${postings} exceeds the smoke-proven limit ${limit}`)
    this.name = 'SourceControlCapacityError'
  }
}

export class SourceTransactionsRequiredError extends Error {
  constructor() {
    super('job source control requires MongoDB replica-set transactions')
    this.name = 'SourceTransactionsRequiredError'
  }
}

export class SourceLineageMigrationRequiredError extends Error {
  constructor(public readonly sourceId: string) {
    super(`job source control requires the durable-lineage repair for ${sourceId}`)
    this.name = 'SourceLineageMigrationRequiredError'
  }
}

export interface SourceWriteFenceOptions<T> {
  /** Re-read the physical corpus while holding the global ingest mutex. This
   * runs once before a source fetch so TTL deletions cannot leave a stale-high
   * admission counter indefinitely. */
  reconcileRetainedPostings?: boolean
  /** Number of JobPosting inserts performed by `work`. Merges and other writes
   * return zero. The transaction aborts if admitting them would exceed the
   * smoke-proven retained bound. */
  insertedPostings?: (result: T) => number
}

/** Existing source rows predate A02. Missing revisions are epoch zero so the
 * deployment can fence them without a mass write migration. */
export function controlRevisionOf(source: { controlRevision?: number | null }): number {
  return Number.isInteger(source.controlRevision) && (source.controlRevision as number) >= 0
    ? source.controlRevision as number
    : 0
}

/** Mongo predicate matching both explicit epoch zero and legacy missing rows. */
export function controlRevisionFilter(expectedRevision: number): Record<string, unknown> {
  return expectedRevision === 0
    ? { $or: [{ controlRevision: 0 }, { controlRevision: { $exists: false } }] }
    : { controlRevision: expectedRevision }
}

function syncAuthorityFilter(sourceId: string, expectedRevision: number): Record<string, unknown> {
  return {
    sourceId,
    enabled: true,
    health: { $in: ['active', 'degraded'] },
    ...controlRevisionFilter(expectedRevision),
  }
}

function isTransactionUnsupported(error: unknown): boolean {
  const err = error as { code?: number; codeName?: string; message?: string }
  return err?.code === 20 || err?.codeName === 'IllegalOperation' || /transaction numbers are only allowed/i.test(err?.message ?? '')
}

async function runSourceTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession()
  let result: T | undefined
  let completed = false
  try {
    await session.withTransaction(async () => {
      result = await work(session)
      completed = true
    }, TRANSACTION_OPTIONS)
  } catch (error) {
    if (isTransactionUnsupported(error)) throw new SourceTransactionsRequiredError()
    throw error
  } finally {
    await session.endSession()
  }
  if (!completed) throw new Error('source transaction completed without a result')
  return result as T
}

/** Fast pre-fetch guard. The transaction fence below is still authoritative;
 * this read avoids contacting a source after a control change where possible. */
export async function assertSourceSyncAuthority(sourceId: string, expectedRevision: number): Promise<void> {
  const exists = await JobSourceConfig.exists(syncAuthorityFilter(sourceId, expectedRevision))
  if (!exists) throw new SourceAuthorityChangedError(sourceId, expectedRevision)
}

type LeanAuthorityAudit = { revision: number; action: JobSourceControlAction }

async function latestAuthorityAudit(
  sourceId: string,
  session?: ClientSession,
): Promise<LeanAuthorityAudit | null> {
  return JobSourceControlAudit.findOne(
    { sourceId },
    { revision: 1, action: 1 },
    { ...(session ? { session } : {}), sort: { revision: -1 } },
  ).lean() as unknown as Promise<LeanAuthorityAudit | null>
}

function auditAuthorizesRevision(
  expectedRevision: number,
  latestAudit: LeanAuthorityAudit | null,
): boolean {
  return expectedRevision === 0
    ? latestAudit === null
    : latestAudit?.revision === expectedRevision && latestAudit.action === 'restore'
}

/** Board probes may inspect quarantined/disabled boards, but never a stale
 * legal-control epoch. Their final update also carries this CAS. */
export async function assertSourceProbeAuthority(sourceId: string, expectedRevision: number): Promise<void> {
  const source = await JobSourceConfig.findOne({
    sourceId,
    health: { $in: ['active', 'degraded', 'quarantined'] },
    ...controlRevisionFilter(expectedRevision),
  }).select('controlRevision').lean()
  if (!source) throw new SourceAuthorityChangedError(sourceId, expectedRevision)
  const latestAudit = await latestAuthorityAudit(sourceId)
  if (!auditAuthorizesRevision(expectedRevision, latestAudit)) {
    throw new SourceAuthorityChangedError(sourceId, expectedRevision)
  }
}

/**
 * Serialize one persistence unit with legal source control.
 *
 * The physical `ingestWriteSeq` update and every callback write share a Mongo
 * transaction. Revoke writes the same config document in its transaction.
 * Whichever commits first wins; the later transaction either sees the new
 * revision or retries after a write conflict. There is no guard→insert gap.
 */
export async function withSourceWriteFence<T>(
  sourceId: string,
  expectedRevision: number,
  work: (session: ClientSession) => Promise<T>,
  options: SourceWriteFenceOptions<T> = {},
): Promise<T> {
  return runSourceTransaction(async (session) => {
    // Global meta is always locked before the per-source config. Source
    // control uses the same order, so cross-source inserts cannot race the
    // retained-corpus bound or deadlock an urgent revoke.
    const controlMeta = await JobSourceControlMeta.findOne(
      { _id: JOB_SOURCE_CONTROL_META_ID, sourceLineageVersion: 1 },
      { ingestWriteSeq: 1, retainedPostings: 1 },
      { session },
    ).lean()
    if (
      !controlMeta ||
      !Number.isSafeInteger(controlMeta.ingestWriteSeq) ||
      !Number.isSafeInteger(controlMeta.retainedPostings) ||
      controlMeta.ingestWriteSeq < 0 ||
      controlMeta.ingestWriteSeq >= Number.MAX_SAFE_INTEGER ||
      controlMeta.retainedPostings < 0
    ) {
      throw new SourceLineageMigrationRequiredError(sourceId)
    }
    const nextIngestWriteSeq = controlMeta.ingestWriteSeq + 1
    const globalFence = await JobSourceControlMeta.updateOne(
      {
        _id: JOB_SOURCE_CONTROL_META_ID,
        sourceLineageVersion: 1,
        ingestWriteSeq: controlMeta.ingestWriteSeq,
      },
      { $inc: { ingestWriteSeq: 1 } },
      { session },
    )
    if ((globalFence.matchedCount ?? 0) !== 1) {
      throw new SourceControlConflictError('global ingest sequence changed during the source write')
    }

    const fence = await JobSourceConfig.updateOne(
      syncAuthorityFilter(sourceId, expectedRevision),
      { $inc: { ingestWriteSeq: 1 } },
      { session }
    )
    if ((fence.matchedCount ?? 0) !== 1) {
      throw new SourceAuthorityChangedError(sourceId, expectedRevision)
    }
    // Permanent audit is an independent anti-reset rail. Deleting/reseeding a
    // config at epoch zero, or editing a revoked config back to active, cannot
    // authorize ingestion while its audit history still says otherwise.
    const latestAudit = await latestAuthorityAudit(sourceId, session)
    if (!auditAuthorizesRevision(expectedRevision, latestAudit)) {
      throw new SourceAuthorityChangedError(sourceId, expectedRevision)
    }

    let retainedPostings = controlMeta.retainedPostings
    if (options.reconcileRetainedPostings) {
      retainedPostings = await JobPosting.countDocuments({}, { session })
      if (retainedPostings > JOB_SOURCE_CONTROL_MAX_POSTINGS) {
        throw new SourceControlCapacityError(retainedPostings, JOB_SOURCE_CONTROL_MAX_POSTINGS)
      }
      const reconciliation = await JobSourceControlMeta.updateOne(
        {
          _id: JOB_SOURCE_CONTROL_META_ID,
          sourceLineageVersion: 1,
          ingestWriteSeq: nextIngestWriteSeq,
        },
        { $set: { retainedPostings } },
        { session },
      )
      if ((reconciliation.matchedCount ?? 0) !== 1) {
        throw new SourceControlIntegrityError('global retained-corpus reconciliation lost its ingest fence')
      }
    }

    const result = await work(session)
    const insertedPostings = options.insertedPostings?.(result) ?? 0
    if (!Number.isInteger(insertedPostings) || insertedPostings < 0) {
      throw new SourceControlIntegrityError('source write reported an invalid retained-posting delta')
    }
    const admittedPostings = retainedPostings + insertedPostings
    if (admittedPostings > JOB_SOURCE_CONTROL_MAX_POSTINGS) {
      throw new SourceControlCapacityError(admittedPostings, JOB_SOURCE_CONTROL_MAX_POSTINGS)
    }
    if (insertedPostings > 0) {
      const admission = await JobSourceControlMeta.updateOne(
        {
          _id: JOB_SOURCE_CONTROL_META_ID,
          sourceLineageVersion: 1,
          ingestWriteSeq: nextIngestWriteSeq,
          retainedPostings,
        },
        { $inc: { retainedPostings: insertedPostings } },
        { session },
      )
      if ((admission.matchedCount ?? 0) !== 1) {
        throw new SourceControlIntegrityError('global retained-corpus admission lost its ingest fence')
      }
    }
    return result
  })
}

/** Discover transaction/topology failures before an ingest run spends quota
 * fetching provider data. The same authority write used for persistence is a
 * real transaction smoke, not a topology-name guess. */
export async function assertSourceTransactionsReady(
  sourceId: string,
  expectedRevision: number,
): Promise<void> {
  await withSourceWriteFence(
    sourceId,
    expectedRevision,
    async () => undefined,
    { reconcileRetainedPostings: true },
  )
}

export interface SourceControlCommand {
  sourceId: string
  action: JobSourceControlAction
  expectedRevision: number
  operationId: string
  actorUserId: string
  reason: string
}

export interface SourceControlResult {
  sourceId: string
  action: JobSourceControlAction
  previousRevision: number
  revision: number
  enabled: boolean
  health: JobSourceHealth
  affectedPostings: number
  unknownLineagePostings: number
  operationId: string
  at: Date
  idempotent: boolean
}

interface LeanAudit {
  sourceId: string
  operationId: string
  action: JobSourceControlAction
  actorUserId: unknown
  reason: string
  previousRevision: number
  revision: number
  to: { enabled: boolean; health: JobSourceHealth }
  affectedPostings: number
  unknownLineagePostings: number
  occurredAt: Date
  createdAt: Date
}

interface LeanControlledSource {
  enabled: boolean
  health: JobSourceHealth
  lastControl?: {
    revision: number
    operationId: string
    action: JobSourceControlAction
    actorUserId: unknown
    reason: string
    at: Date
  } | null
}

function sameInstant(left: Date, right: Date): boolean {
  return new Date(left).getTime() === new Date(right).getTime()
}

function assertControlHistoryIntegrity(
  source: LeanControlledSource,
  previousRevision: number,
  latestAudit: LeanAudit | null,
  auditCount: number,
  nextAction: JobSourceControlAction,
): void {
  if (previousRevision === 0) {
    if (auditCount !== 0 || latestAudit || source.lastControl) {
      throw new SourceControlIntegrityError(
        'source control integrity failure: epoch-zero source has control history',
      )
    }
    if (nextAction === 'restore') {
      throw new SourceControlConflictError(
        'epoch-zero restore is forbidden; adopt a legacy revocation with revoke first',
      )
    }
    return
  }

  if (
    auditCount !== previousRevision ||
    !latestAudit ||
    latestAudit.revision !== previousRevision ||
    latestAudit.previousRevision !== previousRevision - 1
  ) {
    throw new SourceControlIntegrityError(
      `source control integrity failure: revision ${previousRevision} does not have a complete audit chain`,
    )
  }

  const expectedHeadAction: JobSourceControlAction = previousRevision % 2 === 1
    ? 'revoke'
    : 'restore'
  if (latestAudit.action !== expectedHeadAction) {
    throw new SourceControlIntegrityError(
      `source control integrity failure: revision ${previousRevision} has an invalid ${latestAudit.action} audit head`,
    )
  }

  const summary = source.lastControl
  if (
    !summary ||
    summary.revision !== latestAudit.revision ||
    summary.operationId !== latestAudit.operationId ||
    summary.action !== latestAudit.action ||
    String(summary.actorUserId) !== String(latestAudit.actorUserId) ||
    summary.reason !== latestAudit.reason ||
    !sameInstant(summary.at, latestAudit.occurredAt)
  ) {
    throw new SourceControlIntegrityError(
      'source control integrity failure: config summary does not match the permanent audit head',
    )
  }

  const auditDestinationIsValid = latestAudit.action === 'revoke'
    ? latestAudit.to.enabled === false && latestAudit.to.health === 'revoked'
    : latestAudit.to.enabled === false && latestAudit.to.health === 'quarantined'
  if (!auditDestinationIsValid) {
    throw new SourceControlIntegrityError(
      'source control integrity failure: audit head has an invalid destination state',
    )
  }

  if (latestAudit.action === 'revoke' && (source.enabled || source.health !== 'revoked')) {
    throw new SourceControlIntegrityError(
      'source control integrity failure: revoked audit head disagrees with source state',
    )
  }
  if (latestAudit.action === 'restore' && source.health === 'revoked') {
    throw new SourceControlIntegrityError(
      'source control integrity failure: restored audit head disagrees with source state',
    )
  }
  if (latestAudit.action === nextAction) {
    throw new SourceControlConflictError('source control actions must alternate between revoke and restore')
  }
}

function canonicalSourceIdExpression(valueReference: string): Record<string, unknown> {
  return {
    $cond: [
      { $eq: [{ $type: valueReference }, 'string'] },
      { $regexMatch: { input: valueReference, regex: JOB_SOURCE_ID_PATTERN.source } },
      false,
    ],
  }
}

function missingSourceLineageFilter(): Record<string, unknown> {
  const safeSourceIds = { $cond: [{ $isArray: '$sourceIds' }, '$sourceIds', []] }
  return {
    $expr: {
      $not: [{
        $and: [
          { $isArray: '$sourceIds' },
          { $gt: [{ $size: safeSourceIds }, 0] },
          {
            $allElementsTrue: [{
              $map: {
                input: safeSourceIds,
                as: 'sourceId',
                in: canonicalSourceIdExpression('$$sourceId'),
              },
            }],
          },
        ],
      }],
    },
  }
}

function malformedLineageFallbackFilter(sourceId: string): Record<string, unknown> {
  return {
    $and: [
      missingSourceLineageFilter(),
      // A malformed scalar/array can still contain the target or UNKNOWN and
      // therefore be matched by the multikey/equality rail. Exclude those here
      // so audit counts describe disjoint physical posting sets.
      { sourceIds: { $nin: [sourceId, JOB_SOURCE_LINEAGE_UNKNOWN] } },
    ],
  }
}

function indexedRevokedSourceLineageFilter(sourceId: string): Record<string, unknown> {
  return { sourceIds: { $in: [sourceId, JOB_SOURCE_LINEAGE_UNKNOWN] } }
}

function provenanceDriftFilter(sourceId: string): Record<string, unknown> {
  return {
    'provenance.sourceId': sourceId,
    sourceIds: { $nin: [sourceId, JOB_SOURCE_LINEAGE_UNKNOWN] },
    // Keep this disjoint from the malformed-lineage emergency update below so
    // affected counts are exact. The provenance index still bounds candidates.
    $nor: [missingSourceLineageFilter()],
  }
}

function resultFromAudit(audit: LeanAudit, idempotent: boolean): SourceControlResult {
  return {
    sourceId: audit.sourceId,
    action: audit.action,
    previousRevision: audit.previousRevision,
    revision: audit.revision,
    enabled: audit.to.enabled,
    health: audit.to.health,
    affectedPostings: audit.affectedPostings,
    unknownLineagePostings: audit.unknownLineagePostings,
    operationId: audit.operationId,
    at: new Date(audit.occurredAt),
    idempotent,
  }
}

function replayResult(command: SourceControlCommand, audit: LeanAudit): SourceControlResult {
  const same =
    audit.sourceId === command.sourceId &&
    audit.action === command.action &&
    audit.previousRevision === command.expectedRevision &&
    String(audit.actorUserId) === String(command.actorUserId) &&
    audit.reason === command.reason
  if (!same) throw new SourceControlConflictError('idempotency key was already used for a different source-control command')
  return resultFromAudit(audit, true)
}

async function findAudit(operationId: string): Promise<LeanAudit | null> {
  return JobSourceControlAudit.findOne({ operationId }).lean() as unknown as Promise<LeanAudit | null>
}

/**
 * Audited legal control transition. Revoke restricts every canonical row that
 * carries the source, including already-archived and multi-source rows: the
 * current schema cannot prove field-level content ownership, so fail-closed is
 * the only defensible policy. Restore deliberately leaves postings restricted
 * and the source disabled/quarantined pending fresh revalidation.
 */
export async function controlJobSource(command: SourceControlCommand): Promise<SourceControlResult> {
  await connectDB()

  const existing = await findAudit(command.operationId)
  if (existing) return replayResult(command, existing)

  try {
    return await runSourceTransaction(async (session) => {
      const duplicate = await JobSourceControlAudit.findOne(
        { operationId: command.operationId },
        null,
        { session }
      ).lean() as unknown as LeanAudit | null
      if (duplicate) return replayResult(command, duplicate)

      // The MongoDB driver does not support parallel operations inside one
      // transaction. Keep these reads sequential and bind both to its snapshot.
      const auditTotal = await JobSourceControlAudit.countDocuments({}, { session })
      const controlMeta = await JobSourceControlMeta.findOne(
        { _id: JOB_SOURCE_CONTROL_META_ID, sourceLineageVersion: 1 },
        { controlWriteSeq: 1 },
        { session },
      ).lean()
      if (!controlMeta) {
        throw new SourceLineageMigrationRequiredError(command.sourceId)
      }
      if (controlMeta.controlWriteSeq !== auditTotal) {
        throw new SourceControlIntegrityError(
          `global source-control integrity failure: sequence ${controlMeta.controlWriteSeq} does not match ${auditTotal} audit rows`,
        )
      }
      const lineageFence = await JobSourceControlMeta.updateOne(
        {
          _id: JOB_SOURCE_CONTROL_META_ID,
          sourceLineageVersion: 1,
          controlWriteSeq: auditTotal,
        },
        { $inc: { controlWriteSeq: 1 } },
        { session },
      )
      if ((lineageFence.matchedCount ?? 0) !== 1) {
        throw new SourceControlConflictError('global source-control sequence changed during the transition')
      }

      const source = await JobSourceConfig.findOne(
        { sourceId: command.sourceId },
        null,
        { session }
      ).lean()
      if (!source) throw new SourceControlNotFoundError(command.sourceId)

      const previousRevision = controlRevisionOf(source)
      if (previousRevision !== command.expectedRevision) {
        throw new SourceControlConflictError(`stale source revision: expected ${command.expectedRevision}, current ${previousRevision}`)
      }

      const latestAudit = await JobSourceControlAudit.findOne(
        { sourceId: command.sourceId },
        null,
        { session, sort: { revision: -1 } },
      ).lean() as unknown as LeanAudit | null
      const sourceAuditCount = await JobSourceControlAudit.countDocuments(
        { sourceId: command.sourceId },
        { session },
      )
      assertControlHistoryIntegrity(
        source as unknown as LeanControlledSource,
        previousRevision,
        latestAudit,
        sourceAuditCount,
        command.action,
      )

      // Pre-A02 operators could set health=revoked without an authority epoch,
      // corpus closure, or permanent audit. Repeating revoke at epoch zero is
      // the explicit, idempotent adoption path for that historical state.
      const adoptingLegacyRevocation =
        command.action === 'revoke' &&
        source.health === 'revoked' &&
        previousRevision === 0 &&
        !source.lastControl
      if (command.action === 'revoke' && source.health === 'revoked' && !adoptingLegacyRevocation) {
        throw new SourceControlConflictError('source is already revoked; retry with the original idempotency key')
      }
      if (command.action === 'restore' && source.health !== 'revoked') {
        throw new SourceControlConflictError('only a revoked source can be restored')
      }

      const revision = previousRevision + 1
      const at = new Date()
      const from = { enabled: source.enabled, health: source.health as JobSourceHealth }
      const to: { enabled: boolean; health: JobSourceHealth } = command.action === 'revoke'
        ? { enabled: false, health: 'revoked' }
        : { enabled: false, health: 'quarantined' }
      const lastControl = {
        revision,
        operationId: command.operationId,
        action: command.action,
        actorUserId: command.actorUserId,
        reason: command.reason,
        at,
      }

      const transition = await JobSourceConfig.updateOne(
        {
          sourceId: command.sourceId,
          enabled: source.enabled,
          health: source.health,
          ...controlRevisionFilter(previousRevision),
        },
        { $set: { ...to, controlRevision: revision, lastControl } },
        { session }
      )
      if ((transition.matchedCount ?? 0) !== 1) {
        throw new SourceControlConflictError('source changed during the control transition')
      }

      // Acquire the source row before scanning the corpus. In page-first
      // contention the transaction now waits/retries before paying for the
      // bounded count/closure scans, exactly as the staging smoke measures.
      if (command.action === 'revoke') {
        const retainedPostings = await JobPosting.countDocuments({}, { session })
        if (retainedPostings > JOB_SOURCE_CONTROL_MAX_POSTINGS) {
          throw new SourceControlCapacityError(retainedPostings, JOB_SOURCE_CONTROL_MAX_POSTINGS)
        }
        const retainedSnapshot = await JobSourceControlMeta.updateOne(
          {
            _id: JOB_SOURCE_CONTROL_META_ID,
            sourceLineageVersion: 1,
            controlWriteSeq: auditTotal + 1,
          },
          { $set: { retainedPostings } },
          { session },
        )
        if ((retainedSnapshot.matchedCount ?? 0) !== 1) {
          throw new SourceControlIntegrityError('global retained-corpus snapshot lost its control fence')
        }
      }

      let affectedPostings = 0
      let unknownLineagePostings = 0
      if (command.action === 'revoke') {
        const indexedUnknownLineagePostings = await JobPosting.countDocuments(
          { sourceIds: JOB_SOURCE_LINEAGE_UNKNOWN },
          { session, hint: JOB_SOURCE_CONTROL_INDEX_NAMES.postingSourceIds },
        )
        const provenanceDriftPostings = await JobPosting.countDocuments(
          provenanceDriftFilter(command.sourceId),
          { session, hint: JOB_SOURCE_CONTROL_INDEX_NAMES.postingProvenanceSourceId },
        )
        const malformedLineagePostings = await JobPosting.countDocuments(
          malformedLineageFallbackFilter(command.sourceId),
          { session },
        )
        unknownLineagePostings = indexedUnknownLineagePostings + malformedLineagePostings

        const restriction = {
          $set: { status: 'closed' as const, closedReason: 'source-revoked' as const, closedAt: at },
          $unset: { purgeAt: 1 },
        }
        const indexedClosure = await JobPosting.updateMany(
          indexedRevokedSourceLineageFilter(command.sourceId),
          restriction,
          { session, hint: JOB_SOURCE_CONTROL_INDEX_NAMES.postingSourceIds },
        )
        affectedPostings = indexedClosure.matchedCount ?? indexedClosure.modifiedCount ?? 0

        // Indexed defense for a valid-looking `sourceIds` array that drifted
        // away from detailed provenance after the promotion repair. This is
        // disjoint from both the normal source/sentinel update and malformed
        // emergency fallback, so counts do not double-add.
        if (provenanceDriftPostings > 0) {
          const provenanceClosure = await JobPosting.updateMany(
            provenanceDriftFilter(command.sourceId),
            restriction,
            { session, hint: JOB_SOURCE_CONTROL_INDEX_NAMES.postingProvenanceSourceId },
          )
          affectedPostings += provenanceClosure.matchedCount ?? provenanceClosure.modifiedCount ?? 0
        }

        // Migration + schema validation keep this zero in the healthy path.
        // If an out-of-band writer creates a malformed row, close it in the
        // same transaction instead of letting the index assumption weaken the
        // legal fail-closed guarantee.
        if (malformedLineagePostings > 0) {
          const fallbackClosure = await JobPosting.updateMany(
            malformedLineageFallbackFilter(command.sourceId),
            restriction,
            { session },
          )
          affectedPostings += fallbackClosure.matchedCount ?? fallbackClosure.modifiedCount ?? 0
        }
      } else {
        // Restoration authorizes a future revalidation, not stale content.
        // A cold cursor is required before a later, separate enable action.
        await JobIngestCursor.deleteMany({ sourceId: command.sourceId }, { session })
      }

      await JobSourceControlAudit.create([{
        sourceId: command.sourceId,
        operationId: command.operationId,
        action: command.action,
        actorUserId: command.actorUserId,
        reason: command.reason,
        previousRevision,
        revision,
        from,
        to,
        affectedPostings,
        unknownLineagePostings,
        occurredAt: at,
      }], { session })

      return {
        sourceId: command.sourceId,
        action: command.action,
        previousRevision,
        revision,
        enabled: to.enabled,
        health: to.health,
        affectedPostings,
        unknownLineagePostings,
        operationId: command.operationId,
        at,
        idempotent: false,
      }
    })
  } catch (error) {
    // Ambiguous network/commit outcomes and concurrent duplicate requests are
    // resolved from the permanent audit row. A different payload never gets
    // to borrow an existing idempotency key.
    const committed = await findAudit(command.operationId).catch(() => null)
    if (committed) return replayResult(command, committed)
    throw error
  }
}
