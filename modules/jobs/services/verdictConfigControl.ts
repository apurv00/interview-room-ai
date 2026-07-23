import { createHash } from 'crypto'
import mongoose, { type ClientSession } from 'mongoose'
import { connectDB } from '@shared/db/connection'
import {
  JOBS_VERDICT_CONFIG_ID,
  JobsVerdictConfig,
  JobsVerdictConfigAudit,
  jobsVerdictConfigSnapshotOf,
  jobsVerdictConfigValuesOf,
  type JobsVerdictConfigAction,
  type JobsVerdictConfigSnapshot,
  type JobsVerdictConfigState,
} from '@shared/db/models'
import { jobsVerdictConfigIssueOf } from '@shared/validators/jobsVerdictConfigLimits'

const TRANSACTION_OPTIONS = {
  readConcern: { level: 'snapshot' as const },
  writeConcern: { w: 'majority' as const },
  readPreference: 'primary' as const,
}

const CONFIG_KEYS = [
  'collectionEnabled',
  'enforceEnabled',
  'rankingEnabled',
  'dailyVerdictCap',
  'dailyBudgetUsd',
  'monthlyBudgetUsd',
  'perCompanyDailyCap',
  'perSourceDailyCap',
  'inputUsdPerMTok',
  'outputUsdPerMTok',
] as const

const BOOLEAN_KEYS = ['collectionEnabled', 'enforceEnabled', 'rankingEnabled'] as const
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i

export class JobsVerdictConfigValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JobsVerdictConfigValidationError'
  }
}

export class JobsVerdictConfigConflictError extends Error {
  constructor(message: string, public readonly currentRevision?: number) {
    super(message)
    this.name = 'JobsVerdictConfigConflictError'
  }
}

export class JobsVerdictConfigRevisionNotFoundError extends Error {
  constructor(public readonly revision: number) {
    super(`verdict config revision ${revision} was not found`)
    this.name = 'JobsVerdictConfigRevisionNotFoundError'
  }
}

export class JobsVerdictConfigMigrationRequiredError extends Error {
  constructor() {
    super('legacy verdict config rows require consolidation before governed changes')
    this.name = 'JobsVerdictConfigMigrationRequiredError'
  }
}

export class JobsVerdictConfigRepairRequiredError extends Error {
  constructor(public readonly issue: string) {
    super(`stored verdict config requires repair: ${issue}`)
    this.name = 'JobsVerdictConfigRepairRequiredError'
  }
}

export class JobsVerdictConfigTransactionsRequiredError extends Error {
  constructor() {
    super('verdict config control requires MongoDB replica-set transactions')
    this.name = 'JobsVerdictConfigTransactionsRequiredError'
  }
}

export interface JobsVerdictConfigUpdateCommand {
  operationId: string
  actorUserId: string
  reason: string
  expectedRevision: number
  config: JobsVerdictConfigState
}

export interface JobsVerdictConfigRollbackCommand {
  operationId: string
  actorUserId: string
  reason: string
  expectedRevision: number
  targetRevision: number
}

export interface JobsVerdictConfigChangeResult {
  operationId: string
  action: JobsVerdictConfigAction
  previousRevision: number
  revision: number
  targetRevision?: number
  config: JobsVerdictConfigSnapshot
  at: Date
  idempotent: boolean
}

interface LeanAudit {
  _id: string
  action: JobsVerdictConfigAction
  commandHash: string
  previousRevision: number
  revision: number
  targetRevision?: number
  from: JobsVerdictConfigState
  to: JobsVerdictConfigState
  occurredAt: Date
}

interface NormalizedIdentity {
  operationId: string
  actorUserId: string
  reason: string
  expectedRevision: number
}

interface NormalizedUpdateCommand extends NormalizedIdentity {
  config: JobsVerdictConfigState
}

interface NormalizedRollbackCommand extends NormalizedIdentity {
  targetRevision: number
}

function validation(condition: boolean, message: string): asserts condition {
  if (!condition) throw new JobsVerdictConfigValidationError(message)
}

function normalizeIdentity(command: {
  operationId: unknown
  actorUserId: unknown
  reason: unknown
  expectedRevision: unknown
}): NormalizedIdentity {
  validation(typeof command.operationId === 'string' && UUID_PATTERN.test(command.operationId), 'operationId must be a UUID')
  validation(typeof command.actorUserId === 'string' && OBJECT_ID_PATTERN.test(command.actorUserId), 'actorUserId must be an ObjectId')
  validation(typeof command.reason === 'string', 'reason must be a string')
  const reason = command.reason.trim()
  validation(reason.length >= 8 && reason.length <= 1000, 'reason must be 8-1000 characters')
  validation(
    Number.isSafeInteger(command.expectedRevision) &&
      (command.expectedRevision as number) >= 0 &&
      (command.expectedRevision as number) < Number.MAX_SAFE_INTEGER,
    'expectedRevision must be a non-negative safe integer',
  )
  return {
    operationId: command.operationId,
    actorUserId: command.actorUserId,
    reason,
    expectedRevision: command.expectedRevision as number,
  }
}

function normalizeConfig(input: unknown): JobsVerdictConfigState {
  validation(typeof input === 'object' && input !== null && !Array.isArray(input), 'config must be an object')
  const config = input as Record<string, unknown>
  const allowed = new Set<string>([...CONFIG_KEYS, 'notes'])
  validation(Object.keys(config).every((key) => allowed.has(key)), 'config contains an unknown field')
  validation(CONFIG_KEYS.every((key) => Object.prototype.hasOwnProperty.call(config, key)), 'config must include every field')

  for (const key of BOOLEAN_KEYS) validation(typeof config[key] === 'boolean', `${key} must be boolean`)
  const configIssue = jobsVerdictConfigIssueOf(config)
  if (configIssue) throw new JobsVerdictConfigValidationError(configIssue)

  let notes: string | undefined
  if (config.notes !== undefined) {
    validation(typeof config.notes === 'string', 'notes must be a string')
    notes = config.notes.trim()
    validation(notes.length <= 2000, 'notes must be at most 2000 characters')
  }

  return {
    collectionEnabled: config.collectionEnabled as boolean,
    enforceEnabled: config.enforceEnabled as boolean,
    rankingEnabled: config.rankingEnabled as boolean,
    dailyVerdictCap: config.dailyVerdictCap as number,
    dailyBudgetUsd: config.dailyBudgetUsd as number,
    monthlyBudgetUsd: config.monthlyBudgetUsd as number,
    perCompanyDailyCap: config.perCompanyDailyCap as number,
    perSourceDailyCap: config.perSourceDailyCap as number,
    inputUsdPerMTok: config.inputUsdPerMTok as number,
    outputUsdPerMTok: config.outputUsdPerMTok as number,
    ...(notes ? { notes } : {}),
  }
}

function normalizeUpdate(command: JobsVerdictConfigUpdateCommand): NormalizedUpdateCommand {
  return { ...normalizeIdentity(command), config: normalizeConfig(command.config) }
}

function normalizeRollback(command: JobsVerdictConfigRollbackCommand): NormalizedRollbackCommand {
  const normalized = normalizeIdentity(command)
  validation(
    Number.isSafeInteger(command.targetRevision) && command.targetRevision >= 0,
    'targetRevision must be a non-negative safe integer',
  )
  validation(command.targetRevision < normalized.expectedRevision, 'targetRevision must be older than expectedRevision')
  return { ...normalized, targetRevision: command.targetRevision }
}

function stateOf(snapshot: JobsVerdictConfigSnapshot): JobsVerdictConfigState {
  const { revision: _revision, ...state } = snapshot
  return state
}

function hashCommand(action: JobsVerdictConfigAction, command: NormalizedUpdateCommand | NormalizedRollbackCommand): string {
  return createHash('sha256').update(JSON.stringify({ action, ...command })).digest('hex')
}

function revisionFilter(expectedRevision: number): Record<string, unknown> {
  return expectedRevision === 0
    ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] }
    : { revision: expectedRevision }
}

function isTransactionUnsupported(error: unknown): boolean {
  const details = error as { code?: number; codeName?: string; message?: string }
  return details?.code === 20 || details?.codeName === 'IllegalOperation' ||
    /transaction numbers are only allowed/i.test(details?.message ?? '')
}

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: number })?.code === 11000
}

async function runTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession()
  let result: T | undefined
  let completed = false
  try {
    await session.withTransaction(async () => {
      result = await work(session)
      completed = true
    }, TRANSACTION_OPTIONS)
  } catch (error) {
    if (isTransactionUnsupported(error)) throw new JobsVerdictConfigTransactionsRequiredError()
    throw error
  } finally {
    await session.endSession()
  }
  if (!completed) throw new Error('verdict config transaction completed without a result')
  return result as T
}

function storedControlIssue(
  doc: { revision?: unknown; decisionWriteSeq?: unknown },
  requireComplete = false,
): string | null {
  if (
    (requireComplete || doc.revision !== undefined) &&
    (!Number.isSafeInteger(doc.revision) || (doc.revision as number) < 0)
  ) return 'revision must be a non-negative safe integer'
  if (
    (requireComplete || doc.decisionWriteSeq !== undefined) &&
    (!Number.isSafeInteger(doc.decisionWriteSeq) ||
      (doc.decisionWriteSeq as number) < 0 ||
      (doc.decisionWriteSeq as number) >= Number.MAX_SAFE_INTEGER)
  ) return 'decisionWriteSeq must be a non-negative safe integer below its maximum'
  return null
}

async function readSnapshot(session?: ClientSession): Promise<JobsVerdictConfigSnapshot> {
  const options = session ? { session } : undefined
  const canonical = await JobsVerdictConfig.findById(JOBS_VERDICT_CONFIG_ID, null, options).lean()
  if (canonical) {
    const legacy = await JobsVerdictConfig.find(
      { _id: { $ne: JOBS_VERDICT_CONFIG_ID } },
      { _id: 1 },
      options,
    ).sort({ _id: 1 }).limit(1).lean()
    if (legacy.length > 0) throw new JobsVerdictConfigMigrationRequiredError()
    const issue = storedControlIssue(canonical, true) ??
      jobsVerdictConfigIssueOf(canonical as never)
    if (issue) throw new JobsVerdictConfigRepairRequiredError(issue)
    return jobsVerdictConfigSnapshotOf(canonical)
  }
  const legacy = await JobsVerdictConfig.find(
    { _id: { $ne: JOBS_VERDICT_CONFIG_ID } },
    null,
    options,
  ).sort({ _id: 1 }).limit(2).lean()
  if (legacy.length > 1) throw new JobsVerdictConfigMigrationRequiredError()
  const issue = legacy[0]
    ? storedControlIssue(legacy[0]) ?? jobsVerdictConfigIssueOf(jobsVerdictConfigValuesOf(legacy[0]))
    : null
  if (issue) throw new JobsVerdictConfigRepairRequiredError(issue)
  return jobsVerdictConfigSnapshotOf(legacy[0])
}

async function legacyConfigIdForAdoption(session: ClientSession): Promise<mongoose.Types.ObjectId | undefined> {
  const canonical = await JobsVerdictConfig.findById(JOBS_VERDICT_CONFIG_ID, { _id: 1 }, { session }).lean()
  if (canonical) return undefined
  const legacy = await JobsVerdictConfig.find(
    { _id: { $ne: JOBS_VERDICT_CONFIG_ID } },
    { _id: 1 },
    { session },
  ).sort({ _id: 1 }).limit(2).lean()
  if (legacy.length > 1) throw new JobsVerdictConfigMigrationRequiredError()
  return legacy[0]?._id
}

async function removeAdoptedLegacyConfig(legacyId: mongoose.Types.ObjectId, session: ClientSession): Promise<void> {
  const removal = await JobsVerdictConfig.deleteOne({ _id: legacyId }, { session })
  if ((removal.deletedCount ?? 0) !== 1) {
    throw new JobsVerdictConfigConflictError('legacy verdict config changed during canonical adoption')
  }
}

async function findAudit(operationId: string, session?: ClientSession): Promise<LeanAudit | null> {
  return JobsVerdictConfigAudit.findById(
    operationId,
    null,
    session ? { session } : undefined,
  ).lean() as unknown as Promise<LeanAudit | null>
}

function resultFromAudit(audit: LeanAudit, idempotent: boolean): JobsVerdictConfigChangeResult {
  return {
    operationId: audit._id,
    action: audit.action,
    previousRevision: audit.previousRevision,
    revision: audit.revision,
    ...(audit.targetRevision === undefined ? {} : { targetRevision: audit.targetRevision }),
    config: { ...audit.to, revision: audit.revision },
    at: new Date(audit.occurredAt),
    idempotent,
  }
}

function replay(audit: LeanAudit, expectedHash: string): JobsVerdictConfigChangeResult {
  if (audit.commandHash !== expectedHash) {
    throw new JobsVerdictConfigConflictError('operationId was already used for a different verdict-config command')
  }
  return resultFromAudit(audit, true)
}

async function writeRevision(
  session: ClientSession,
  previousRevision: number,
  revision: number,
  config: JobsVerdictConfigState,
  actorUserId: string,
): Promise<void> {
  const { notes, ...values } = config
  const transition = await JobsVerdictConfig.updateOne(
    { _id: JOBS_VERDICT_CONFIG_ID, ...revisionFilter(previousRevision) },
    {
      $set: { ...values, ...(notes ? { notes } : {}), revision, updatedBy: actorUserId },
      ...(notes ? {} : { $unset: { notes: 1 } }),
    },
    { session, upsert: true, runValidators: true, setDefaultsOnInsert: true },
  )
  if ((transition.matchedCount ?? 0) + (transition.upsertedCount ?? 0) !== 1) {
    throw new JobsVerdictConfigConflictError('verdict config changed during the transition')
  }
}

export async function getJobsVerdictConfigSnapshot(session?: ClientSession): Promise<JobsVerdictConfigSnapshot> {
  await connectDB()
  return readSnapshot(session)
}

/** Physically touch the canonical config row before a serving mutation. A
 * concurrent CMS update writes the same document, so Mongo aborts/retries one
 * transaction instead of allowing a stale enforcement decision to commit. */
export async function fenceJobsVerdictConfigRevision(
  expectedRevision: number,
  session: ClientSession,
): Promise<boolean> {
  validation(
    Number.isSafeInteger(expectedRevision) && expectedRevision >= 0,
    'expectedRevision must be a non-negative safe integer',
  )
  const write = await JobsVerdictConfig.updateOne(
    {
      _id: JOBS_VERDICT_CONFIG_ID,
      collectionEnabled: true,
      enforceEnabled: true,
      ...revisionFilter(expectedRevision),
      $and: [{
        $or: [
          { decisionWriteSeq: { $lt: Number.MAX_SAFE_INTEGER } },
          { decisionWriteSeq: { $exists: false } },
        ],
      }],
    },
    { $inc: { decisionWriteSeq: 1 } },
    { session, timestamps: false },
  )
  return (write.matchedCount ?? 0) === 1
}

export async function updateJobsVerdictConfig(
  command: JobsVerdictConfigUpdateCommand,
): Promise<JobsVerdictConfigChangeResult> {
  const normalized = normalizeUpdate(command)
  const commandHash = hashCommand('update', normalized)
  await connectDB()

  const existing = await findAudit(normalized.operationId)
  if (existing) return replay(existing, commandHash)

  try {
    return await runTransaction(async (session) => {
      const duplicate = await findAudit(normalized.operationId, session)
      if (duplicate) return replay(duplicate, commandHash)

      const adoptedLegacyId = await legacyConfigIdForAdoption(session)
      const current = await readSnapshot(session)
      if (current.revision !== normalized.expectedRevision) {
        throw new JobsVerdictConfigConflictError(
          `stale verdict config revision: expected ${normalized.expectedRevision}, current ${current.revision}`,
          current.revision,
        )
      }

      const revision = current.revision + 1
      const at = new Date()
      await writeRevision(session, current.revision, revision, normalized.config, normalized.actorUserId)
      if (adoptedLegacyId !== undefined) {
        await removeAdoptedLegacyConfig(adoptedLegacyId, session)
      }
      await JobsVerdictConfigAudit.create([{
        _id: normalized.operationId,
        action: 'update',
        commandHash,
        actorUserId: normalized.actorUserId,
        reason: normalized.reason,
        previousRevision: current.revision,
        revision,
        from: stateOf(current),
        to: normalized.config,
        occurredAt: at,
      }], { session })

      return {
        operationId: normalized.operationId,
        action: 'update',
        previousRevision: current.revision,
        revision,
        config: { ...normalized.config, revision },
        at,
        idempotent: false,
      }
    })
  } catch (error) {
    const committed = await findAudit(normalized.operationId).catch(() => null)
    if (committed) return replay(committed, commandHash)
    if (isDuplicateKey(error)) throw new JobsVerdictConfigConflictError('verdict config changed during the transition')
    throw error
  }
}

export async function rollbackJobsVerdictConfig(
  command: JobsVerdictConfigRollbackCommand,
): Promise<JobsVerdictConfigChangeResult> {
  const normalized = normalizeRollback(command)
  const commandHash = hashCommand('rollback', normalized)
  await connectDB()

  const existing = await findAudit(normalized.operationId)
  if (existing) return replay(existing, commandHash)

  try {
    return await runTransaction(async (session) => {
      const duplicate = await findAudit(normalized.operationId, session)
      if (duplicate) return replay(duplicate, commandHash)

      const adoptedLegacyId = await legacyConfigIdForAdoption(session)
      const current = await readSnapshot(session)
      if (current.revision !== normalized.expectedRevision) {
        throw new JobsVerdictConfigConflictError(
          `stale verdict config revision: expected ${normalized.expectedRevision}, current ${current.revision}`,
          current.revision,
        )
      }

      const targetAudit = normalized.targetRevision === 0
        ? await JobsVerdictConfigAudit.findOne(
          { previousRevision: 0 },
          null,
          { session, sort: { revision: 1 } },
        ).lean() as unknown as LeanAudit | null
        : await JobsVerdictConfigAudit.findOne(
          { revision: normalized.targetRevision },
          null,
          { session },
        ).lean() as unknown as LeanAudit | null
      if (!targetAudit) throw new JobsVerdictConfigRevisionNotFoundError(normalized.targetRevision)

      const target = normalizeConfig(normalized.targetRevision === 0 ? targetAudit.from : targetAudit.to)
      const revision = current.revision + 1
      const at = new Date()
      await writeRevision(session, current.revision, revision, target, normalized.actorUserId)
      if (adoptedLegacyId !== undefined) {
        await removeAdoptedLegacyConfig(adoptedLegacyId, session)
      }
      await JobsVerdictConfigAudit.create([{
        _id: normalized.operationId,
        action: 'rollback',
        commandHash,
        actorUserId: normalized.actorUserId,
        reason: normalized.reason,
        previousRevision: current.revision,
        revision,
        targetRevision: normalized.targetRevision,
        from: stateOf(current),
        to: target,
        occurredAt: at,
      }], { session })

      return {
        operationId: normalized.operationId,
        action: 'rollback',
        previousRevision: current.revision,
        revision,
        targetRevision: normalized.targetRevision,
        config: { ...target, revision },
        at,
        idempotent: false,
      }
    })
  } catch (error) {
    const committed = await findAudit(normalized.operationId).catch(() => null)
    if (committed) return replay(committed, commandHash)
    if (isDuplicateKey(error)) throw new JobsVerdictConfigConflictError('verdict config changed during the transition')
    throw error
  }
}
