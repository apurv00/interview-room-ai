import { createHash } from 'node:crypto'
import mongoose, { type ClientSession } from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { redis } from '@shared/redis'
import {
  JOB_SOURCE_CONTROL_META_ID,
  JobIngestCycle,
  JobPosting,
  JobSourceConfig,
  JobSourceControlAudit,
  JobSourceControlMeta,
  JobSourceOperationAudit,
  type IJobSourceConfig,
  type JobSourceHealth,
  type JobSourceOperationAction,
} from '@shared/db/models'
import { inngest } from '@shared/services/inngest'
import {
  JOB_SOURCE_CATALOG,
  effectiveSourceRequestBudget,
  jobSourceDefinition,
  sourceCatalogIdentityMatches as catalogIdentityMatches,
  sourceCatalogRoutingMatches,
  sourceCredentialStatus,
  sourcePolicyHash,
  sourceSeed,
  type JobSourceRequestBudget,
  type SourcePolicySnapshot,
} from '../config/sourceCatalog'
import {
  JOB_SOURCE_CONTROL_INDEX_NAMES,
  JOB_SOURCE_CONTROL_MAX_POSTINGS,
} from '../config/sourceControlLimits'
import {
  controlRevisionFilter,
  controlRevisionOf,
  operationalRevisionFilter,
  operationalRevisionOf,
} from './sourceControl'
import { readSourceQuotaUsage } from './sourceQuota'

export interface SourceSettingsPatch {
  cadenceMinutes?: number
  minIndiaPostings?: number | null
  perRunRequestCap?: number
  dailyRequestCap?: number
  monthlyRequestCap?: number
  llmVerdictOptOut?: boolean
  displayName?: string
  notes?: string
}

export interface SourceOperationCommand {
  operationId: string
  actorUserId: string
  action: JobSourceOperationAction
  sourceId?: string
  expectedControlRevision?: number
  expectedOperationalRevision?: number
  reason?: string
  settings?: SourceSettingsPatch
}

export interface SourceOperationResult {
  operationId: string
  action: JobSourceOperationAction
  sourceId?: string
  controlRevision?: number
  operationalRevision?: number
  enabled?: boolean
  health?: JobSourceHealth
  dispatched?: boolean
  idempotent: boolean
}

export interface SourceWindowMetrics {
  fetched: number
  normalized: number
  newCount: number
  merged: number
  refreshed: number
  quotaSpent: number
  driftNulls: number
  storeErrors: number
  drops: number
  cycles: number
}

export interface SourceControlPlane {
  bootstrap: {
    required: boolean
    allowed: boolean
    blockers: string[]
    repairs: string[]
    catalogSources: number
    configuredSources: number
  }
  readiness: {
    transactionCapable: boolean
    sourceControlReady: boolean
    /** Credential presence only. Deployment registration is verified by the
     * release smoke, not inferred from environment variables. */
    inngestCredentialsConfigured: boolean
    redisReachable: boolean
  }
  sources: Array<{
    sourceId: string
    definition: ReturnType<typeof jobSourceDefinition>
    config: Record<string, unknown>
    credential: {
      status: 'not-required' | 'missing' | 'configured' | 'rejected' | 'verified'
      configurationStatus: 'not-required' | 'missing' | 'configured'
      lastValidationStatus: 'not-run' | 'healthy' | 'rejected' | 'failed' | 'stale'
      requiredEnv?: string
    }
    supply: { open: number; retained: number }
    metrics24h: SourceWindowMetrics
    metrics7d: SourceWindowMetrics
    quota: {
      available: boolean
      usedToday: number | null
      usedThisMonth: number | null
    }
    lastOperation: unknown | null
  }>
  audit: unknown[]
}

export class SourceOperationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: 400 | 404 | 409 | 422 | 503,
    public readonly currentControlRevision?: number,
    public readonly currentOperationalRevision?: number,
  ) {
    super(message)
    this.name = 'SourceOperationError'
  }
}

export class SourceOperationNotFoundError extends SourceOperationError {
  constructor(sourceId: string) {
    super(`unknown job source: ${sourceId}`, 'SOURCE_NOT_FOUND', 404)
    this.name = 'SourceOperationNotFoundError'
  }
}

export class SourceOperationConflictError extends SourceOperationError {
  constructor(
    message: string,
    currentControlRevision?: number,
    currentOperationalRevision?: number,
  ) {
    super(
      message,
      'SOURCE_OPERATION_CONFLICT',
      409,
      currentControlRevision,
      currentOperationalRevision,
    )
    this.name = 'SourceOperationConflictError'
  }
}

export class SourceOperationValidationError extends SourceOperationError {
  constructor(message: string) {
    super(message, 'SOURCE_OPERATION_INVALID', 422)
    this.name = 'SourceOperationValidationError'
  }
}

export class SourceOperationReadinessError extends SourceOperationError {
  constructor(message: string) {
    super(message, 'SOURCE_OPERATION_UNAVAILABLE', 503)
    this.name = 'SourceOperationReadinessError'
  }
}

const TRANSACTION_OPTIONS = {
  readConcern: { level: 'snapshot' as const },
  writeConcern: { w: 'majority' as const },
  readPreference: 'primary' as const,
}

type SourceControlIndexTarget = 'postings' | 'configs' | 'legal-audits' | 'operation-audits'

interface SourceControlIndexSpec {
  target: SourceControlIndexTarget
  name: string
  key: Record<string, 1 | -1>
  unique: boolean
}

interface SourceControlIndexDescription {
  name?: string
  key?: Record<string, unknown>
  unique?: boolean
  sparse?: boolean
  partialFilterExpression?: unknown
  collation?: unknown
  hidden?: boolean
  expireAfterSeconds?: number
}

interface SourceControlIndexCollection {
  createIndex(key: Record<string, 1 | -1>, options: { name: string; unique?: boolean }): Promise<string>
  indexes(): Promise<SourceControlIndexDescription[]>
}

const SOURCE_CONTROL_INDEX_SPECS: readonly SourceControlIndexSpec[] = [
  { target: 'configs', name: JOB_SOURCE_CONTROL_INDEX_NAMES.sourceConfigSourceId, key: { sourceId: 1 }, unique: true },
  { target: 'legal-audits', name: JOB_SOURCE_CONTROL_INDEX_NAMES.auditOperationId, key: { operationId: 1 }, unique: true },
  { target: 'legal-audits', name: JOB_SOURCE_CONTROL_INDEX_NAMES.auditSourceRevision, key: { sourceId: 1, revision: 1 }, unique: true },
  { target: 'operation-audits', name: JOB_SOURCE_CONTROL_INDEX_NAMES.operationAuditOperationId, key: { operationId: 1 }, unique: true },
  { target: 'operation-audits', name: JOB_SOURCE_CONTROL_INDEX_NAMES.operationAuditSourceOccurredAt, key: { sourceId: 1, occurredAt: -1 }, unique: false },
  { target: 'postings', name: JOB_SOURCE_CONTROL_INDEX_NAMES.postingSourceIds, key: { sourceIds: 1 }, unique: false },
  { target: 'postings', name: JOB_SOURCE_CONTROL_INDEX_NAMES.postingProvenanceSourceId, key: { 'provenance.sourceId': 1 }, unique: false },
]

function sourceControlIndexCollections(): Record<SourceControlIndexTarget, SourceControlIndexCollection> {
  return {
    postings: JobPosting.collection as unknown as SourceControlIndexCollection,
    configs: JobSourceConfig.collection as unknown as SourceControlIndexCollection,
    'legal-audits': JobSourceControlAudit.collection as unknown as SourceControlIndexCollection,
    'operation-audits': JobSourceOperationAudit.collection as unknown as SourceControlIndexCollection,
  }
}

function sameIndexKey(actual: Record<string, unknown> | undefined, expected: Record<string, 1 | -1>): boolean {
  if (!actual) return false
  const actualEntries = Object.entries(actual)
  const expectedEntries = Object.entries(expected)
  return actualEntries.length === expectedEntries.length && actualEntries.every(
    ([key, value], index) => key === expectedEntries[index][0] && value === expectedEntries[index][1],
  )
}

function safeExactIndex(
  indexes: SourceControlIndexDescription[],
  spec: SourceControlIndexSpec,
): boolean {
  const sameKey = indexes.filter((index) => sameIndexKey(index.key, spec.key))
  return sameKey.length === 1 && sameKey[0].name === spec.name &&
    !!sameKey[0].unique === spec.unique && !sameKey[0].sparse &&
    sameKey[0].partialFilterExpression == null && sameKey[0].collation == null &&
    !sameKey[0].hidden && sameKey[0].expireAfterSeconds == null
}

async function sourceControlIndexesReady(): Promise<boolean> {
  try {
    const collections = sourceControlIndexCollections()
    const byTarget = new Map<SourceControlIndexTarget, SourceControlIndexDescription[]>()
    for (const target of ['postings', 'configs', 'legal-audits', 'operation-audits'] as const) {
      byTarget.set(target, await collections[target].indexes())
    }
    if (!SOURCE_CONTROL_INDEX_SPECS.every((spec) => safeExactIndex(byTarget.get(spec.target) ?? [], spec))) {
      return false
    }
    return !['legal-audits', 'operation-audits'].some((target) =>
      (byTarget.get(target as SourceControlIndexTarget) ?? []).some(
        (index) => typeof index.expireAfterSeconds === 'number',
      ),
    )
  } catch {
    return false
  }
}

async function ensureSourceControlIndexes(): Promise<void> {
  const collections = sourceControlIndexCollections()
  try {
    for (const spec of SOURCE_CONTROL_INDEX_SPECS) {
      await collections[spec.target].createIndex(spec.key, {
        name: spec.name,
        ...(spec.unique ? { unique: true } : {}),
      })
    }
  } catch {
    throw new SourceOperationReadinessError('exact source-control indexes could not be prepared safely')
  }
  if (!await sourceControlIndexesReady()) {
    throw new SourceOperationReadinessError('all seven exact source-control indexes and permanent audit retention are required')
  }
}

function commandHash(command: SourceOperationCommand): string {
  const canonical = {
    action: command.action,
    sourceId: command.sourceId ?? null,
    actorUserId: command.actorUserId,
    expectedControlRevision: command.expectedControlRevision ?? null,
    expectedOperationalRevision: command.expectedOperationalRevision ?? null,
    reason: command.reason?.trim() ?? null,
    settings: command.settings
      ? Object.fromEntries(Object.entries(command.settings).sort(([a], [b]) => a.localeCompare(b)))
      : null,
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

function isTransactionUnsupported(error: unknown): boolean {
  const candidate = error as { code?: number; codeName?: string; message?: string }
  return candidate?.code === 20 || candidate?.codeName === 'IllegalOperation' ||
    /transaction numbers are only allowed/i.test(candidate?.message ?? '')
}

async function inTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession()
  let result: T | undefined
  try {
    await session.withTransaction(async () => { result = await work(session) }, TRANSACTION_OPTIONS)
  } catch (error) {
    if (isTransactionUnsupported(error)) {
      throw new SourceOperationReadinessError('job source operations require MongoDB replica-set transactions')
    }
    throw error
  } finally {
    await session.endSession()
  }
  if (result === undefined) throw new SourceOperationReadinessError('source operation transaction returned no result')
  return result
}

type StatefulSourcePolicy = SourcePolicySnapshot & Pick<
  IJobSourceConfig,
  'enabled' | 'health' | 'controlRevision' | 'operationalRevision'
>

function policySnapshotOf(source: SourcePolicySnapshot): SourcePolicySnapshot {
  return {
    sourceId: source.sourceId,
    kind: source.kind,
    atsKind: source.atsKind,
    slug: source.slug,
    displayName: source.displayName,
    cadenceMinutes: source.cadenceMinutes,
    requestBudget: source.requestBudget,
    minIndiaPostings: source.minIndiaPostings,
    llmVerdictOptOut: source.llmVerdictOptOut,
    notes: source.notes,
  }
}

function stateOf(source: StatefulSourcePolicy) {
  const policyHash = sourcePolicyHash(source)
  if (!policyHash) {
    throw new SourceOperationValidationError('source policy is missing, malformed, or outside deploy-reviewed limits')
  }
  return {
    enabled: source.enabled,
    health: source.health,
    controlRevision: controlRevisionOf(source),
    operationalRevision: operationalRevisionOf(source),
    policyHash,
  }
}

function validateBudget(
  sourceId: string,
  budget: JobSourceRequestBudget,
): void {
  const ceiling = jobSourceDefinition(sourceId)?.requestBudget
  if (!ceiling) throw new SourceOperationNotFoundError(sourceId)
  const values = [budget.perRunRequestCap, budget.dailyRequestCap, budget.monthlyRequestCap]
  if (values.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new SourceOperationValidationError('request caps must be nonnegative integers')
  }
  if (budget.perRunRequestCap > budget.dailyRequestCap || budget.dailyRequestCap > budget.monthlyRequestCap) {
    throw new SourceOperationValidationError('request caps must satisfy per-run <= daily <= monthly')
  }
  if (
    budget.perRunRequestCap > ceiling.perRunRequestCap ||
    budget.dailyRequestCap > ceiling.dailyRequestCap ||
    budget.monthlyRequestCap > ceiling.monthlyRequestCap
  ) {
    throw new SourceOperationValidationError('request caps cannot exceed the deploy-reviewed source ceiling')
  }
}

function mergeSettings(source: IJobSourceConfig, patch: SourceSettingsPatch) {
  const currentBudget = source.requestBudget ?? { perRunRequestCap: 0, dailyRequestCap: 0, monthlyRequestCap: 0 }
  const requestBudget = {
    perRunRequestCap: patch.perRunRequestCap ?? currentBudget.perRunRequestCap,
    dailyRequestCap: patch.dailyRequestCap ?? currentBudget.dailyRequestCap,
    monthlyRequestCap: patch.monthlyRequestCap ?? currentBudget.monthlyRequestCap,
  }
  validateBudget(source.sourceId, requestBudget)
  if (patch.cadenceMinutes != null && (!Number.isInteger(patch.cadenceMinutes) || patch.cadenceMinutes < 15 || patch.cadenceMinutes > 10_080)) {
    throw new SourceOperationValidationError('cadenceMinutes must be an integer from 15 to 10080')
  }
  if (patch.minIndiaPostings != null && (!Number.isInteger(patch.minIndiaPostings) || patch.minIndiaPostings < 0 || patch.minIndiaPostings > 100_000)) {
    throw new SourceOperationValidationError('minIndiaPostings must be null or an integer from 0 to 100000')
  }
  if (patch.displayName !== undefined) {
    throw new SourceOperationValidationError('displayName is deploy-reviewed source identity and cannot be edited in CMS')
  }
  if (patch.notes != null && patch.notes.length > 2_000) {
    throw new SourceOperationValidationError('notes cannot exceed 2000 characters')
  }
  return {
    requestBudget,
    ...(patch.cadenceMinutes != null ? { cadenceMinutes: patch.cadenceMinutes } : {}),
    ...(patch.minIndiaPostings !== undefined ? { minIndiaPostings: patch.minIndiaPostings } : {}),
    ...(patch.llmVerdictOptOut != null ? { llmVerdictOptOut: patch.llmVerdictOptOut } : {}),
    ...(patch.notes != null ? { notes: patch.notes } : {}),
  }
}

async function replay(command: SourceOperationCommand): Promise<SourceOperationResult | null> {
  const audit = await JobSourceOperationAudit.findOne({ operationId: command.operationId }).lean()
  if (!audit) return null
  if (audit.commandHash !== commandHash(command)) {
    throw new SourceOperationConflictError('idempotency key was already used for a different source operation')
  }
  return {
    operationId: audit.operationId,
    action: audit.action,
    sourceId: audit.sourceId,
    controlRevision: audit.to?.controlRevision ?? audit.from?.controlRevision,
    operationalRevision: audit.to?.operationalRevision ?? audit.from?.operationalRevision,
    enabled: audit.to?.enabled ?? audit.from?.enabled,
    health: audit.to?.health ?? audit.from?.health,
    dispatched: !!audit.dispatchedAt,
    idempotent: true,
  }
}

async function hasTransactionTopology(): Promise<boolean> {
  const db = mongoose.connection.db
  if (!db) return false
  try {
    const hello = await db.admin().command({ hello: 1 }) as { setName?: string; msg?: string }
    return !!hello.setName || hello.msg === 'isdbgrid'
  } catch {
    return false
  }
}

async function assertBootstrapTopology(): Promise<void> {
  if (!await hasTransactionTopology()) {
    throw new SourceOperationReadinessError('job source operations require MongoDB replica-set transactions')
  }
}

export interface OperationSourceSnapshot {
  sourceId: string
  kind: IJobSourceConfig['kind']
  atsKind?: string | null
  slug?: string | null
  displayName?: string | null
  requestBudget?: JobSourceRequestBudget | null
  cadenceMinutes: number
  minIndiaPostings?: number | null
  llmVerdictOptOut: boolean
  notes?: string | null
  operationalRevision?: number | null
}

function inngestCredentialsConfigured(): boolean {
  return !!process.env.INNGEST_EVENT_KEY?.trim() && !!process.env.INNGEST_SIGNING_KEY?.trim()
}

export async function assertSourceWorkerReadiness(
  source: OperationSourceSnapshot,
): Promise<void> {
  const definition = jobSourceDefinition(source.sourceId)
  if (!definition) throw new SourceOperationNotFoundError(source.sourceId)
  if (!catalogIdentityMatches(source as Pick<IJobSourceConfig, 'sourceId' | 'kind' | 'atsKind' | 'slug' | 'displayName'>)) {
    throw new SourceOperationReadinessError('source configuration disagrees with the deploy-reviewed catalog identity')
  }
  const budget = effectiveSourceRequestBudget(source as Pick<
    IJobSourceConfig,
    'sourceId' | 'kind' | 'atsKind' | 'slug' | 'displayName' | 'requestBudget'
  >)
  if (!budget) throw new SourceOperationValidationError('source request budget is missing, malformed, or above its catalog ceiling')
  if (!budget.perRunRequestCap || !budget.dailyRequestCap || !budget.monthlyRequestCap) {
    throw new SourceOperationValidationError('nonzero request caps are required before provider egress')
  }
  if (!sourcePolicyHash(source as SourcePolicySnapshot)) {
    throw new SourceOperationValidationError('source policy is missing, malformed, or outside deploy-reviewed limits')
  }
  if (sourceCredentialStatus(definition) === 'missing') {
    throw new SourceOperationValidationError('required source credential is missing')
  }
  if (!process.env.REDIS_URL?.trim()) {
    throw new SourceOperationReadinessError('REDIS_URL is required for source request budgets')
  }

  const [transactionCapable, indexesReady, meta, retainedPostings, legalAudits, quota, catalogSources] = await Promise.all([
    hasTransactionTopology(),
    sourceControlIndexesReady(),
    JobSourceControlMeta.findOne({ _id: JOB_SOURCE_CONTROL_META_ID }).lean(),
    JobPosting.countDocuments({}),
    JobSourceControlAudit.countDocuments({}),
    readSourceQuotaUsage(redis, source.sourceId),
    JobSourceConfig.find({})
      .select('sourceId kind atsKind slug displayName cadenceMinutes requestBudget minIndiaPostings llmVerdictOptOut notes operationalRevision')
      .lean(),
  ])
  if (!transactionCapable) {
    throw new SourceOperationReadinessError('job source operations require MongoDB replica-set transactions')
  }
  if (!indexesReady) {
    throw new SourceOperationReadinessError('all seven exact source-control indexes and permanent audit retention are required')
  }
  const configuredIds = new Set(catalogSources.map((candidate) => candidate.sourceId))
  const catalogComplete = catalogSources.length === JOB_SOURCE_CATALOG.length &&
    JOB_SOURCE_CATALOG.every((candidate) => configuredIds.has(candidate.sourceId)) &&
    catalogSources.every((candidate) =>
      catalogIdentityMatches(candidate) && sourcePolicyHash(candidate) !== null &&
      Number.isSafeInteger(candidate.operationalRevision) && candidate.operationalRevision >= 0)
  if (!catalogComplete) {
    throw new SourceOperationReadinessError('the complete deploy-reviewed source catalog must be bootstrapped before provider egress')
  }
  if (
    !meta || meta.sourceLineageVersion !== 1 ||
    meta.controlWriteSeq !== legalAudits || meta.retainedPostings !== retainedPostings
  ) {
    throw new SourceOperationReadinessError('source-control metadata disagrees with the physical corpus')
  }
  if (retainedPostings > JOB_SOURCE_CONTROL_MAX_POSTINGS) {
    throw new SourceOperationReadinessError('retained Jobs corpus exceeds the source-control limit')
  }
  if (!quota) {
    throw new SourceOperationReadinessError('Redis source-quota state is unavailable')
  }
  if (quota.usedToday >= budget.dailyRequestCap || quota.usedThisMonth >= budget.monthlyRequestCap) {
    throw new SourceOperationReadinessError('source request budget is exhausted')
  }
}

async function assertOperationPreflight(
  source: OperationSourceSnapshot,
  _action: 'enable' | 'run-now' | 'validate',
): Promise<void> {
  if (!inngestCredentialsConfigured()) {
    throw new SourceOperationReadinessError('Inngest event and signing credentials are required')
  }
  await assertSourceWorkerReadiness(source)
}

async function bootstrap(command: SourceOperationCommand): Promise<SourceOperationResult> {
  await assertBootstrapTopology()
  const [postingCount, legalAuditCount, configs, meta] = await Promise.all([
    JobPosting.countDocuments({}),
    JobSourceControlAudit.countDocuments({}),
    JobSourceConfig.find({}).lean(),
    JobSourceControlMeta.findOne({ _id: JOB_SOURCE_CONTROL_META_ID }).lean(),
  ])
  const invalidOperationalRevision = configs.some((source) =>
    source.operationalRevision != null &&
    (!Number.isSafeInteger(source.operationalRevision) || source.operationalRevision < 0),
  )
  if (invalidOperationalRevision) {
    throw new SourceOperationReadinessError('invalid operationalRevision requires explicit database repair before bootstrap')
  }
  const catalogSafe = configs.every(sourceCatalogRoutingMatches)
  const legacySafe = catalogSafe && configs.every((source) =>
    source.health !== 'revoked' &&
    controlRevisionOf(source) === 0 && !source.lastControl)
  if (!catalogSafe) {
    throw new SourceOperationReadinessError('source configuration contains unknown or catalog-identity-drift rows')
  }
  if ((postingCount > 0 || legalAuditCount > 0 || !legacySafe) && !meta) {
    throw new SourceOperationReadinessError('nonempty Jobs data requires the protected source-lineage migration')
  }
  if (postingCount > JOB_SOURCE_CONTROL_MAX_POSTINGS) {
    throw new SourceOperationReadinessError('retained Jobs corpus exceeds the source-control limit')
  }
  if (meta && (
    meta.sourceLineageVersion !== 1 ||
    meta.controlWriteSeq !== legalAuditCount ||
    meta.retainedPostings !== postingCount
  )) {
    throw new SourceOperationReadinessError('source-control readiness metadata disagrees with the physical corpus')
  }
  // Mongo forbids index creation inside a transaction. Build and verify the
  // exact non-dropping contract first; all logical bootstrap writes below are
  // then one atomic meta/config/permanent-audit commit.
  await ensureSourceControlIndexes()
  await inTransaction(async (session) => {
    // The Mongo driver does not support parallel operations in one session.
    const currentPostingCount = await JobPosting.countDocuments({}, { session })
    const currentLegalAuditCount = await JobSourceControlAudit.countDocuments({}, { session })
    const currentConfigs = await JobSourceConfig.find({}, null, { session }).lean()
    const currentMeta = await JobSourceControlMeta.findOne(
      { _id: JOB_SOURCE_CONTROL_META_ID },
      null,
      { session },
    ).lean()
    const currentCatalogSafe = currentConfigs.every(sourceCatalogRoutingMatches)
    const currentInvalidOperationalRevision = currentConfigs.some((source) =>
      source.operationalRevision != null &&
      (!Number.isSafeInteger(source.operationalRevision) || source.operationalRevision < 0),
    )
    if (currentInvalidOperationalRevision) {
      throw new SourceOperationReadinessError('invalid operationalRevision requires explicit database repair before bootstrap')
    }
    const currentLegacySafe = currentCatalogSafe && currentConfigs.every((source) =>
      source.health !== 'revoked' &&
      controlRevisionOf(source) === 0 && !source.lastControl)
    if (!currentCatalogSafe) {
      throw new SourceOperationReadinessError('source configuration contains unknown or catalog-identity-drift rows')
    }
    if ((currentPostingCount > 0 || currentLegalAuditCount > 0 || !currentLegacySafe) && !currentMeta) {
      throw new SourceOperationReadinessError('nonempty Jobs data requires the protected source-lineage migration')
    }
    if (currentPostingCount > JOB_SOURCE_CONTROL_MAX_POSTINGS) {
      throw new SourceOperationReadinessError('retained Jobs corpus exceeds the source-control limit')
    }
    if (currentMeta && (
      currentMeta.sourceLineageVersion !== 1 ||
      currentMeta.controlWriteSeq !== currentLegalAuditCount ||
      currentMeta.retainedPostings !== currentPostingCount
    )) {
      throw new SourceOperationReadinessError('source-control readiness metadata disagrees with the physical corpus')
    }
    if (!currentMeta) {
      await JobSourceControlMeta.create([{
        _id: JOB_SOURCE_CONTROL_META_ID,
        sourceLineageVersion: 1,
        controlWriteSeq: 0,
        ingestWriteSeq: 0,
        retainedPostings: 0,
        repairedAt: new Date(),
        repairedPostings: 0,
        unknownLineagePostings: 0,
      }], { session })
    }
    const repairedSources: Array<{ sourceId: string; fields: string[] }> = []
    for (const definition of JOB_SOURCE_CATALOG) {
      const currentConfig = currentConfigs.find((source) => source.sourceId === definition.sourceId)
      const repairedFields: string[] = []
      await JobSourceConfig.updateOne(
        { sourceId: definition.sourceId },
        { $setOnInsert: sourceSeed(definition) },
        { upsert: true, session },
      )
      await JobSourceConfig.updateOne(
        { sourceId: definition.sourceId, operationalRevision: { $exists: false } },
        { $set: { operationalRevision: 0 } },
        { session },
      )
      if (currentConfig?.operationalRevision == null) repairedFields.push('operationalRevision')
      const validExistingBudget = currentConfig
        ? effectiveSourceRequestBudget({ ...currentConfig, displayName: definition.displayName })
        : definition.requestBudget
      if (!validExistingBudget) {
        if (currentConfig) repairedFields.push('requestBudget')
        await JobSourceConfig.updateOne(
          { sourceId: definition.sourceId },
          { $set: { requestBudget: definition.requestBudget } },
          { session },
        )
      }
      await JobSourceConfig.updateOne(
        { sourceId: definition.sourceId },
        { $set: { displayName: definition.displayName } },
        { session },
      )
      if (currentConfig && currentConfig.displayName !== definition.displayName) repairedFields.push('displayName')
      if (currentConfig) {
        const set: Record<string, unknown> = {}
        const unset: Record<string, 1> = {}
        if (
          !Number.isSafeInteger(currentConfig.cadenceMinutes) ||
          currentConfig.cadenceMinutes < 15 || currentConfig.cadenceMinutes > 10_080
        ) {
          set.cadenceMinutes = definition.cadenceMinutes
          repairedFields.push('cadenceMinutes')
        }
        if (
          currentConfig.minIndiaPostings != null &&
          (!Number.isSafeInteger(currentConfig.minIndiaPostings) ||
            currentConfig.minIndiaPostings < 0 || currentConfig.minIndiaPostings > 100_000)
        ) {
          repairedFields.push('minIndiaPostings')
          if (definition.minIndiaPostings != null) set.minIndiaPostings = definition.minIndiaPostings
          else unset.minIndiaPostings = 1
        }
        if (typeof currentConfig.llmVerdictOptOut !== 'boolean') {
          set.llmVerdictOptOut = false
          repairedFields.push('llmVerdictOptOut')
        }
        if (currentConfig.notes != null && (typeof currentConfig.notes !== 'string' || currentConfig.notes.length > 2_000)) {
          unset.notes = 1
          repairedFields.push('notes')
        }
        if (Object.keys(set).length || Object.keys(unset).length) {
          await JobSourceConfig.updateOne(
            { sourceId: definition.sourceId },
            {
              ...(Object.keys(set).length ? { $set: set } : {}),
              ...(Object.keys(unset).length ? { $unset: unset } : {}),
            },
            { session },
          )
        }
        if (repairedFields.length) {
          await JobSourceConfig.updateOne(
            { sourceId: definition.sourceId },
            { $inc: { operationalRevision: 1 }, $unset: { lastValidation: 1 } },
            { session },
          )
          repairedSources.push({ sourceId: definition.sourceId, fields: Array.from(new Set(repairedFields)).sort() })
        }
      }
    }
    let adoptedEnabledSources = 0
    const repairedConfigs = await JobSourceConfig.find({}, null, { session }).lean()
    for (const source of repairedConfigs.filter((candidate) => candidate.enabled)) {
      const policyHash = sourcePolicyHash(source)
      if (!policyHash) {
        throw new SourceOperationReadinessError(`source policy for ${source.sourceId} could not be repaired safely`)
      }
      const revision = controlRevisionOf(source)
      const operationalRevision = operationalRevisionOf(source)
      const latestOperation = await JobSourceOperationAudit.findOne(
        { sourceId: source.sourceId },
        { to: 1 },
        { session, sort: { occurredAt: -1, _id: -1 } },
      ).lean()
      if (
        latestOperation?.to?.enabled === true &&
        latestOperation.to.controlRevision === revision &&
        latestOperation.to.operationalRevision === operationalRevision &&
        latestOperation.to.policyHash === policyHash
      ) continue

      const nextOperationalRevision = operationalRevision + 1
      const pause = await JobSourceConfig.updateOne(
        {
          sourceId: source.sourceId,
          enabled: true,
          $and: [
            controlRevisionFilter(revision),
            operationalRevisionFilter(operationalRevision),
          ],
        },
        {
          $set: { enabled: false, operationalRevision: nextOperationalRevision },
          $unset: { lastValidation: 1 },
        },
        { session },
      )
      if ((pause.matchedCount ?? 0) !== 1) {
        throw new SourceOperationConflictError('enabled legacy source changed during bootstrap adoption')
      }
      const from = stateOf(source)
      await JobSourceOperationAudit.create([{
        operationId: `${command.operationId}:adopt:${source.sourceId}`,
        action: 'pause',
        sourceId: source.sourceId,
        actorUserId: command.actorUserId,
        reason: 'Bootstrap adoption paused an enabled source without current permanent operational authority.',
        commandHash: createHash('sha256')
          .update(JSON.stringify({ bootstrapOperationId: command.operationId, sourceId: source.sourceId, action: 'pause-adoption' }))
          .digest('hex'),
        changes: { enabled: false, adoption: 'unaudited-enabled-legacy' },
        from,
        to: { ...from, enabled: false, operationalRevision: nextOperationalRevision },
        outcome: 'succeeded',
        completedAt: new Date(),
        occurredAt: new Date(),
      }], { session })
      adoptedEnabledSources++
    }
    await JobSourceOperationAudit.create([{
      operationId: command.operationId,
      action: 'bootstrap',
      actorUserId: command.actorUserId,
      reason: command.reason?.trim(),
      commandHash: commandHash(command),
      changes: { seededCatalogSources: JOB_SOURCE_CATALOG.length, adoptedEnabledSources, repairedSources },
      outcome: 'succeeded',
      completedAt: new Date(),
      occurredAt: new Date(),
    }], { session })
    return true
  })
  return { operationId: command.operationId, action: 'bootstrap', idempotent: false }
}

async function dispatchOperation(
  command: SourceOperationCommand,
  sourceId: string,
  controlRevision: number,
  operationalRevision: number,
  action: 'run-now' | 'validate',
): Promise<void> {
  const data = {
    sourceId,
    controlRevision,
    operationalRevision,
    operationId: command.operationId,
  }
  try {
    await inngest.send(action === 'run-now'
      ? { id: command.operationId, name: 'jobs/source.sync', data }
      : { id: command.operationId, name: 'jobs/source.validate', data })
    await JobSourceOperationAudit.updateOne(
      { operationId: command.operationId, dispatchedAt: { $exists: false } },
      { $set: { dispatchedAt: new Date() } },
    )
  } catch {
    // The permanent command remains committed with no dispatchedAt marker;
    // a byte-identical retry safely reuses the same Inngest event id.
    throw new SourceOperationReadinessError('source command committed but background dispatch is unavailable; retry the same operation id')
  }
}

async function operateJobSourceOnce(command: SourceOperationCommand): Promise<SourceOperationResult> {
  await connectDB()
  const existing = await replay(command)
  if (existing) {
    if ((command.action === 'run-now' || command.action === 'validate') && !existing.dispatched && command.sourceId) {
      if (existing.controlRevision == null || existing.operationalRevision == null) {
        throw new SourceOperationConflictError('audited dispatch revisions are incomplete')
      }
      const source = await JobSourceConfig.findOne({
        sourceId: command.sourceId,
        enabled: existing.enabled,
        health: existing.health,
        $and: [
          controlRevisionFilter(existing.controlRevision),
          operationalRevisionFilter(existing.operationalRevision),
        ],
      }).select('sourceId kind atsKind slug displayName cadenceMinutes requestBudget minIndiaPostings llmVerdictOptOut notes operationalRevision').lean()
      if (!source) {
        const current = await JobSourceConfig.findOne({ sourceId: command.sourceId })
          .select('controlRevision operationalRevision').lean()
        throw new SourceOperationConflictError(
          'source authority changed before the audited dispatch could be replayed',
          current ? controlRevisionOf(current) : undefined,
          current ? operationalRevisionOf(current) : undefined,
        )
      }
      await assertOperationPreflight(source, command.action)
      await dispatchOperation(
        command,
        command.sourceId,
        existing.controlRevision,
        existing.operationalRevision,
        command.action,
      )
      return { ...existing, dispatched: true }
    }
    return existing
  }
  if (command.action === 'bootstrap') return bootstrap(command)
  if (!command.sourceId || command.expectedControlRevision == null || command.expectedOperationalRevision == null) {
    throw new SourceOperationValidationError('sourceId and both expected revisions are required')
  }
  if (!await sourceControlIndexesReady()) {
    throw new SourceOperationReadinessError(
      'all seven exact source-control indexes and permanent audit retention are required',
    )
  }
  const definition = jobSourceDefinition(command.sourceId)
  if (!definition) throw new SourceOperationNotFoundError(command.sourceId)
  if (command.action === 'enable' || command.action === 'run-now' || command.action === 'validate') {
    const preflightSource = await JobSourceConfig.findOne({ sourceId: command.sourceId })
      .select('sourceId kind atsKind slug displayName cadenceMinutes requestBudget minIndiaPostings llmVerdictOptOut notes controlRevision operationalRevision').lean()
    if (!preflightSource) throw new SourceOperationNotFoundError(command.sourceId)
    const currentControlRevision = controlRevisionOf(preflightSource)
    const currentOperationalRevision = operationalRevisionOf(preflightSource)
    if (
      currentControlRevision !== command.expectedControlRevision ||
      currentOperationalRevision !== command.expectedOperationalRevision
    ) {
      throw new SourceOperationConflictError(
        'source revision is stale',
        currentControlRevision,
        currentOperationalRevision,
      )
    }
    await assertOperationPreflight(preflightSource, command.action)
  }

  const result = await inTransaction(async (session) => {
    const source = await JobSourceConfig.findOne({ sourceId: command.sourceId }, null, { session })
    if (!source) throw new SourceOperationNotFoundError(command.sourceId!)
    const controlRevision = controlRevisionOf(source)
    const operationalRevision = operationalRevisionOf(source)
    if (controlRevision !== command.expectedControlRevision) {
      throw new SourceOperationConflictError('stale legal control revision', controlRevision, operationalRevision)
    }
    if (operationalRevision !== command.expectedOperationalRevision) {
      throw new SourceOperationConflictError('stale operational revision', controlRevision, operationalRevision)
    }
    if (source.health === 'revoked') {
      throw new SourceOperationConflictError(
        'revoked sources can only be changed through legal restore',
        controlRevision,
        operationalRevision,
      )
    }

    const from = stateOf(source)
    const nextRevision = operationalRevision + (command.action === 'run-now' ? 0 : 1)
    let nextPolicyHash = from.policyHash
    let update: Record<string, unknown> | null = null
    let changes: Record<string, unknown> | undefined

    if (command.action === 'update-settings') {
      if (!command.settings || Object.keys(command.settings).length === 0) {
        throw new SourceOperationValidationError('settings are required')
      }
      const settings = mergeSettings(source, command.settings)
      const nextPolicy: SourcePolicySnapshot = {
        ...policySnapshotOf(source),
        ...settings,
        minIndiaPostings: settings.minIndiaPostings === null
          ? undefined
          : settings.minIndiaPostings ?? source.minIndiaPostings,
      }
      nextPolicyHash = sourcePolicyHash(nextPolicy) ?? ''
      if (!nextPolicyHash) {
        throw new SourceOperationValidationError('updated source policy is malformed')
      }
      changes = { ...settings, ...(source.enabled ? { enabled: false } : {}) }
      const set = { ...settings, enabled: false, operationalRevision: nextRevision }
      if (settings.minIndiaPostings === null) {
        delete (set as { minIndiaPostings?: number | null }).minIndiaPostings
        update = { $set: set, $unset: { minIndiaPostings: 1, lastValidation: 1 } }
      } else {
        update = { $set: set, $unset: { lastValidation: 1 } }
      }
    } else if (command.action === 'pause') {
      if (!source.enabled) {
        throw new SourceOperationConflictError('source is already paused', controlRevision, operationalRevision)
      }
      changes = { enabled: false }
      update = { $set: { enabled: false, operationalRevision: nextRevision }, $unset: { lastValidation: 1 } }
    } else if (command.action === 'validate') {
      if (source.enabled) {
        throw new SourceOperationConflictError(
          'pause the source before validation',
          controlRevision,
          operationalRevision,
        )
      }
      const budget = source.requestBudget ?? definition.requestBudget
      validateBudget(source.sourceId, budget)
      if (sourceCredentialStatus(definition) === 'missing') {
        throw new SourceOperationValidationError('required source credential is missing')
      }
      changes = { validationRequested: true }
      update = { $set: { operationalRevision: nextRevision }, $unset: { lastValidation: 1 } }
    } else if (command.action === 'enable') {
      if (source.enabled) {
        throw new SourceOperationConflictError('source is already enabled', controlRevision, operationalRevision)
      }
      const budget = source.requestBudget ?? definition.requestBudget
      validateBudget(source.sourceId, budget)
      if (!budget.perRunRequestCap || !budget.dailyRequestCap || !budget.monthlyRequestCap) {
        throw new SourceOperationValidationError('nonzero request caps are required before enable')
      }
      const validation = source.lastValidation
      if (
        !validation || validation.status !== 'healthy' ||
        validation.controlRevision !== controlRevision ||
        validation.operationalRevision !== operationalRevision ||
        (source.lastControl && validation.checkedAt <= source.lastControl.at)
      ) {
        throw new SourceOperationValidationError('a current successful validation is required before enable')
      }
      const validationAudit = await JobSourceOperationAudit.findOne(
        {
          operationId: validation.operationId,
          sourceId: source.sourceId,
          action: 'validate',
          outcome: 'succeeded',
          completedAt: { $exists: true },
          'to.enabled': false,
          'to.controlRevision': controlRevision,
          'to.operationalRevision': operationalRevision,
          'to.policyHash': from.policyHash,
        },
        { operationId: 1 },
        { session },
      ).lean()
      if (!validationAudit) {
        throw new SourceOperationValidationError('successful validation requires matching permanent command completion evidence')
      }
      changes = { enabled: true, health: 'active' }
      update = { $set: { enabled: true, health: 'active', operationalRevision: nextRevision } }
    } else if (command.action === 'run-now') {
      if (!source.enabled || !['active', 'degraded'].includes(source.health)) {
        throw new SourceOperationConflictError(
          'source is not eligible for sync',
          controlRevision,
          operationalRevision,
        )
      }
      const latestAuthorization = await JobSourceOperationAudit.findOne(
        { sourceId: source.sourceId },
        { to: 1 },
        { session, sort: { occurredAt: -1, _id: -1 } },
      ).lean()
      if (
        latestAuthorization?.to?.enabled !== true ||
        latestAuthorization.to.controlRevision !== controlRevision ||
        latestAuthorization.to.operationalRevision !== operationalRevision ||
        latestAuthorization.to.policyHash !== from.policyHash
      ) {
        throw new SourceOperationConflictError(
          'run-now requires a current permanent Enable authorization',
          controlRevision,
          operationalRevision,
        )
      }
    } else {
      throw new SourceOperationValidationError(`unsupported source operation: ${command.action}`)
    }

    if (update) {
      const mutation = await JobSourceConfig.updateOne(
        {
          sourceId: source.sourceId,
          enabled: source.enabled,
          health: source.health,
          $and: [
            controlRevisionFilter(controlRevision),
            operationalRevisionFilter(operationalRevision),
          ],
        },
        update,
        { session },
      )
      if ((mutation.matchedCount ?? 0) !== 1) {
        throw new SourceOperationConflictError(
          'source changed during the operation',
          controlRevision,
          operationalRevision,
        )
      }
    }
    const to = update
      ? {
          enabled: command.action === 'enable'
            ? true
            : command.action === 'pause' || command.action === 'update-settings'
              ? false
              : source.enabled,
          health: command.action === 'enable' ? 'active' as const : source.health,
          controlRevision,
          operationalRevision: nextRevision,
          policyHash: nextPolicyHash,
        }
      : from
    await JobSourceOperationAudit.create([{
      operationId: command.operationId,
      action: command.action,
      sourceId: source.sourceId,
      actorUserId: command.actorUserId,
      reason: command.reason?.trim(),
      commandHash: commandHash(command),
      changes,
      from,
      to,
      ...(!['run-now', 'validate'].includes(command.action)
        ? { outcome: 'succeeded' as const, completedAt: new Date() }
        : {}),
      occurredAt: new Date(),
    }], { session })
    return { source, to, controlRevision }
  })

  if (command.action === 'run-now' || command.action === 'validate') {
    await dispatchOperation(
      command,
      result.source.sourceId,
      result.to.controlRevision,
      result.to.operationalRevision,
      command.action,
    )
  }
  return {
    operationId: command.operationId,
    action: command.action,
    sourceId: command.sourceId,
    controlRevision: result.controlRevision,
    operationalRevision: result.to.operationalRevision,
    enabled: result.to.enabled,
    health: result.to.health,
    dispatched: command.action === 'run-now' || command.action === 'validate',
    idempotent: false,
  }
}

/** A concurrent byte-identical command may lose the transaction/write race
 * after the winner durably wrote the unique operation audit. Replay that
 * permanent evidence instead of leaking a duplicate-key or stale-revision
 * failure. A reused id with a different command hash remains a 409. */
export async function operateJobSource(command: SourceOperationCommand): Promise<SourceOperationResult> {
  try {
    return await operateJobSourceOnce(command)
  } catch (error) {
    // A losing transaction can observe its conflict just before the winner's
    // majority-committed audit becomes visible. Yield once and re-read within
    // a strict bound; never spin or replay a different command hash.
    for (let attempt = 0; attempt < 2; attempt++) {
      const durableWinner = await replay(command)
      if (durableWinner) return operateJobSourceOnce(command)
      await Promise.resolve()
    }
    throw error
  }
}

const EMPTY_WINDOW_METRICS: SourceWindowMetrics = {
  fetched: 0,
  normalized: 0,
  newCount: 0,
  merged: 0,
  refreshed: 0,
  quotaSpent: 0,
  driftNulls: 0,
  storeErrors: 0,
  drops: 0,
  cycles: 0,
}

interface AggregatedCycleMetrics {
  _id: string
  metrics24h: SourceWindowMetrics
  metrics7d: SourceWindowMetrics
}

function safeOperationChanges(changes: unknown): Record<string, unknown> | undefined {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return undefined
  const input = changes as Record<string, unknown>
  const safe: Record<string, unknown> = {}
  for (const key of [
    'cadenceMinutes',
    'minIndiaPostings',
    'llmVerdictOptOut',
    'displayName',
    'notes',
    'enabled',
    'health',
    'validationRequested',
    'seededCatalogSources',
  ]) {
    if (key in input) safe[key] = input[key]
  }
  if (Number.isSafeInteger(input.adoptedEnabledSources) && (input.adoptedEnabledSources as number) >= 0) {
    safe.adoptedEnabledSources = input.adoptedEnabledSources
  }
  if (input.adoption === 'unaudited-enabled-legacy') {
    safe.adoption = input.adoption
  }
  if (Array.isArray(input.repairedSources)) {
    const allowedFields = new Set([
      'operationalRevision', 'requestBudget', 'displayName', 'cadenceMinutes',
      'minIndiaPostings', 'llmVerdictOptOut', 'notes',
    ])
    safe.repairedSources = input.repairedSources.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
      const candidate = entry as Record<string, unknown>
      if (typeof candidate.sourceId !== 'string' || !/^[a-z0-9][a-z0-9:_-]{0,99}$/.test(candidate.sourceId)) return []
      const fields = Array.isArray(candidate.fields)
        ? candidate.fields.filter((field): field is string => typeof field === 'string' && allowedFields.has(field))
        : []
      return fields.length ? [{ sourceId: candidate.sourceId, fields }] : []
    })
  }
  const requestBudget = input.requestBudget
  if (requestBudget && typeof requestBudget === 'object' && !Array.isArray(requestBudget)) {
    const candidate = requestBudget as Record<string, unknown>
    safe.requestBudget = {
      perRunRequestCap: candidate.perRunRequestCap,
      dailyRequestCap: candidate.dailyRequestCap,
      monthlyRequestCap: candidate.monthlyRequestCap,
    }
  }
  return Object.keys(safe).length ? safe : undefined
}

function safeActorLabel(actorUserId: unknown): string {
  const id = String(actorUserId ?? '')
  return id ? `Admin •••${id.slice(-4)}` : 'Platform admin'
}

function safeAuditReason(reason: unknown): string | undefined {
  if (typeof reason !== 'string') return undefined
  const sanitized = reason.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500)
  return sanitized || undefined
}

export async function getJobSourceControlPlane(): Promise<SourceControlPlane> {
  await connectDB()
  const now = new Date()
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1_000)
  const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000)
  const [sources, meta, retained, legalAudits, supply, cycleMetrics, rawAudit, transactionCapable, indexesReady] = await Promise.all([
    JobSourceConfig.find({}).lean(),
    JobSourceControlMeta.findOne({ _id: JOB_SOURCE_CONTROL_META_ID }).lean(),
    JobPosting.countDocuments({}),
    JobSourceControlAudit.countDocuments({}),
    JobPosting.aggregate([
      { $unwind: '$sourceIds' },
      { $group: { _id: { sourceId: '$sourceIds', status: '$status' }, count: { $sum: 1 } } },
    ]),
    JobIngestCycle.aggregate([
      {
        $match: {
          kind: 'sync',
          sourceId: { $type: 'string' },
          $or: [{ startedAt: { $gte: since7d } }, { startedAt: { $exists: false }, createdAt: { $gte: since7d } }],
        },
      },
      {
        $set: {
          metricAt: { $ifNull: ['$startedAt', '$createdAt'] },
          dropCount: {
            $sum: {
              $map: {
                input: { $objectToArray: { $ifNull: ['$drops', {}] } },
                as: 'drop',
                in: { $ifNull: ['$$drop.v', 0] },
              },
            },
          },
        },
      },
      {
        $group: {
          _id: '$sourceId',
          cycles7d: { $sum: 1 },
          fetched7d: { $sum: { $ifNull: ['$fetched', 0] } },
          normalized7d: { $sum: { $ifNull: ['$normalized', 0] } },
          newCount7d: { $sum: { $ifNull: ['$newCount', 0] } },
          merged7d: { $sum: { $ifNull: ['$merged', 0] } },
          refreshed7d: { $sum: { $ifNull: ['$refreshed', 0] } },
          quotaSpent7d: { $sum: { $ifNull: ['$quotaSpent', 0] } },
          driftNulls7d: { $sum: { $ifNull: ['$driftNulls', 0] } },
          storeErrors7d: { $sum: { $ifNull: ['$storeErrors', 0] } },
          drops7d: { $sum: '$dropCount' },
          cycles24h: { $sum: { $cond: [{ $gte: ['$metricAt', since24h] }, 1, 0] } },
          fetched24h: { $sum: { $cond: [{ $gte: ['$metricAt', since24h] }, { $ifNull: ['$fetched', 0] }, 0] } },
          normalized24h: { $sum: { $cond: [{ $gte: ['$metricAt', since24h] }, { $ifNull: ['$normalized', 0] }, 0] } },
          newCount24h: { $sum: { $cond: [{ $gte: ['$metricAt', since24h] }, { $ifNull: ['$newCount', 0] }, 0] } },
          merged24h: { $sum: { $cond: [{ $gte: ['$metricAt', since24h] }, { $ifNull: ['$merged', 0] }, 0] } },
          refreshed24h: { $sum: { $cond: [{ $gte: ['$metricAt', since24h] }, { $ifNull: ['$refreshed', 0] }, 0] } },
          quotaSpent24h: { $sum: { $cond: [{ $gte: ['$metricAt', since24h] }, { $ifNull: ['$quotaSpent', 0] }, 0] } },
          driftNulls24h: { $sum: { $cond: [{ $gte: ['$metricAt', since24h] }, { $ifNull: ['$driftNulls', 0] }, 0] } },
          storeErrors24h: { $sum: { $cond: [{ $gte: ['$metricAt', since24h] }, { $ifNull: ['$storeErrors', 0] }, 0] } },
          drops24h: { $sum: { $cond: [{ $gte: ['$metricAt', since24h] }, '$dropCount', 0] } },
        },
      },
      {
        $project: {
          metrics24h: {
            fetched: '$fetched24h', normalized: '$normalized24h', newCount: '$newCount24h',
            merged: '$merged24h', refreshed: '$refreshed24h', quotaSpent: '$quotaSpent24h',
            driftNulls: '$driftNulls24h', storeErrors: '$storeErrors24h', drops: '$drops24h', cycles: '$cycles24h',
          },
          metrics7d: {
            fetched: '$fetched7d', normalized: '$normalized7d', newCount: '$newCount7d',
            merged: '$merged7d', refreshed: '$refreshed7d', quotaSpent: '$quotaSpent7d',
            driftNulls: '$driftNulls7d', storeErrors: '$storeErrors7d', drops: '$drops7d', cycles: '$cycles7d',
          },
        },
      },
    ]),
    JobSourceOperationAudit.find({})
      .sort({ occurredAt: -1 })
      .limit(100)
      .select('operationId action sourceId actorUserId reason changes from to dispatchedAt outcome errorCode completedAt occurredAt -_id')
      .lean(),
    hasTransactionTopology(),
    sourceControlIndexesReady(),
  ])
  const supplyRows = supply as Array<{ _id: { sourceId: string; status: string }; count: number }>
  const metricsBySource = new Map(
    (cycleMetrics as AggregatedCycleMetrics[]).map((row) => [row._id, row]),
  )
  const enabledOperationHeads = await Promise.all(
    sources.filter((source) => source.enabled).map(async (source) => ({
      sourceId: source.sourceId,
      operation: await JobSourceOperationAudit.findOne(
        { sourceId: source.sourceId },
        { to: 1 },
        { sort: { occurredAt: -1, _id: -1 } },
      ).lean(),
    })),
  )
  const enabledOperationBySource = new Map(
    enabledOperationHeads.map((row) => [row.sourceId, row.operation]),
  )
  const routingDrift = sources.some((source) => !sourceCatalogRoutingMatches(source))
  const invalidOperationalRevision = sources.some((source) =>
    source.operationalRevision != null &&
    (!Number.isSafeInteger(source.operationalRevision) || source.operationalRevision < 0),
  )
  const operationalRevisionRepairRequired = sources.some((source) => source.operationalRevision == null)
  const catalogRepairRequired = sources.some((source) =>
    !catalogIdentityMatches(source) || !effectiveSourceRequestBudget(source) || !sourcePolicyHash(source))
  const metadataReady = !!meta && meta.sourceLineageVersion === 1 &&
    meta.controlWriteSeq === legalAudits && meta.retainedPostings === retained
  const legacyBootstrapSafe = sources.every((source) =>
    sourceCatalogRoutingMatches(source) && source.health !== 'revoked' &&
    controlRevisionOf(source) === 0 && !source.lastControl)
  const protectedMigrationRequired = !meta &&
    (retained > 0 || legalAudits > 0 || !legacyBootstrapSafe)
  const enabledRowsAudited = sources.filter((source) => source.enabled).every((source) => {
    const operation = enabledOperationBySource.get(source.sourceId)
    const policyHash = sourcePolicyHash(source)
    return !!policyHash && operation?.to?.enabled === true &&
      operation.to.controlRevision === controlRevisionOf(source) &&
      operation.to.operationalRevision === operationalRevisionOf(source) &&
      operation.to.policyHash === policyHash
  })
  const configuredIds = new Set(sources.map((source) => source.sourceId))
  const missingCatalogSources = JOB_SOURCE_CATALOG.some((definition) => !configuredIds.has(definition.sourceId))
  const sourceControlReady = indexesReady && !routingDrift && !catalogRepairRequired && !missingCatalogSources &&
    !invalidOperationalRevision && !operationalRevisionRepairRequired && enabledRowsAudited && metadataReady &&
    retained <= JOB_SOURCE_CONTROL_MAX_POSTINGS
  const blockers = [
    ...(!transactionCapable ? ['Mongo replica-set transaction capability is unavailable'] : []),
    ...(routingDrift ? ['source configuration contains unknown or catalog-routing-drift rows'] : []),
    ...(invalidOperationalRevision ? ['invalid operationalRevision requires explicit database repair'] : []),
    ...(protectedMigrationRequired ? ['protected source-lineage migration required'] : []),
    ...(!metadataReady && !!meta ? ['source-control metadata disagrees with the physical corpus'] : []),
    ...(retained > JOB_SOURCE_CONTROL_MAX_POSTINGS ? ['retained corpus exceeds source-control limit'] : []),
  ]
  const repairs = [
    ...(!indexesReady ? ['create and verify the seven exact non-dropping source-control indexes'] : []),
    ...(catalogRepairRequired ? ['normalize repairable catalog identity, budgets, and mutable policy to safe reviewed values'] : []),
    ...(operationalRevisionRepairRequired ? ['backfill missing operationalRevision values to epoch zero'] : []),
    ...(!enabledRowsAudited ? ['pause and permanently audit enabled legacy rows without current operational authority'] : []),
    ...(missingCatalogSources ? ['seed missing deploy-reviewed catalog sources in a paused state'] : []),
    ...(!meta && !protectedMigrationRequired ? ['create source-lineage readiness metadata for the empty corpus'] : []),
  ]
  const redisEnvironmentConfigured = !!process.env.REDIS_URL?.trim()
  let redisReachable = false
  if (redisEnvironmentConfigured) {
    try {
      redisReachable = await redis.ping() === 'PONG'
    } catch {
      redisReachable = false
    }
  }
  const quotaRows = await Promise.all(sources.map(async (source) => {
    let usage = null
    if (redisReachable) {
      try {
        usage = await readSourceQuotaUsage(redis, source.sourceId)
      } catch {
        usage = null
      }
    }
    return { sourceId: source.sourceId, usage }
  }))
  const quotaBySource = new Map(quotaRows.map((row) => [row.sourceId, row.usage]))
  const bootstrapAllowed = transactionCapable && !routingDrift && !invalidOperationalRevision && !protectedMigrationRequired &&
    retained <= JOB_SOURCE_CONTROL_MAX_POSTINGS && (!meta || metadataReady)
  const audit = rawAudit.map((row) => ({
    operationId: row.operationId,
    action: row.action,
    sourceId: row.sourceId,
    actorLabel: safeActorLabel(row.actorUserId),
    ...(safeAuditReason(row.reason) ? { reason: safeAuditReason(row.reason) } : {}),
    ...(safeOperationChanges(row.changes) ? { changes: safeOperationChanges(row.changes) } : {}),
    from: row.from,
    to: row.to,
    dispatchedAt: row.dispatchedAt,
    outcome: row.outcome,
    errorCode: row.errorCode,
    completedAt: row.completedAt,
    occurredAt: row.occurredAt,
  }))
  return {
    bootstrap: {
      required: !indexesReady || routingDrift || catalogRepairRequired || invalidOperationalRevision ||
        operationalRevisionRepairRequired || !enabledRowsAudited ||
        missingCatalogSources || !meta || blockers.length > 0,
      // Missing indexes are repairable by bootstrap itself (Mongo index DDL
      // precedes the atomic logical transaction), so they do not make a safe
      // empty bootstrap impossible.
      allowed: bootstrapAllowed,
      blockers,
      repairs,
      catalogSources: JOB_SOURCE_CATALOG.length,
      configuredSources: sources.length,
    },
    readiness: {
      transactionCapable,
      sourceControlReady,
      inngestCredentialsConfigured: inngestCredentialsConfigured(),
      redisReachable,
    },
    sources: sources.map((source) => {
      const definition = jobSourceDefinition(source.sourceId)
      const configuredCredential = definition ? sourceCredentialStatus(definition) : 'missing'
      const validationCredential = source.lastValidation?.credentialStatus
      const validationCurrent = !!source.lastValidation &&
        source.lastValidation.controlRevision === controlRevisionOf(source) &&
        source.lastValidation.operationalRevision === operationalRevisionOf(source)
      const lastValidationStatus = !source.lastValidation
        ? 'not-run' as const
        : !validationCurrent
          ? 'stale' as const
          : validationCredential === 'rejected'
            ? 'rejected' as const
            : source.lastValidation.status === 'healthy'
              ? 'healthy' as const
              : 'failed' as const
      const credential = configuredCredential === 'missing'
        ? 'missing'
        : validationCredential === 'rejected'
        ? 'rejected'
        : source.lastValidation?.status === 'healthy' &&
          source.lastValidation.controlRevision === controlRevisionOf(source) &&
          source.lastValidation.operationalRevision === operationalRevisionOf(source)
          ? 'verified'
          : configuredCredential
      const metrics = metricsBySource.get(source.sourceId)
      const quota = quotaBySource.get(source.sourceId) ?? null
      const lastControl = source.lastControl
        ? {
            revision: source.lastControl.revision,
            action: source.lastControl.action,
            at: source.lastControl.at,
          }
        : undefined
      const config: Record<string, unknown> = {
        kind: source.kind,
        ...(source.atsKind ? { atsKind: source.atsKind } : {}),
        displayName: definition?.displayName ?? source.displayName,
        enabled: source.enabled,
        health: source.health,
        controlRevision: controlRevisionOf(source),
        operationalRevision: operationalRevisionOf(source),
        operationalPolicyReady: !!definition && catalogIdentityMatches(source) &&
          Number.isSafeInteger(source.operationalRevision) && source.operationalRevision >= 0 &&
          sourcePolicyHash(source) !== null,
        cadenceMinutes: source.cadenceMinutes,
        requestBudget: effectiveSourceRequestBudget(source),
        minIndiaPostings: source.minIndiaPostings,
        llmVerdictOptOut: source.llmVerdictOptOut,
        lastSyncAt: source.lastSyncAt,
        lastValidation: source.lastValidation,
        notes: source.notes,
        ...(lastControl ? { lastControl } : {}),
      }
      return {
        sourceId: source.sourceId,
        definition,
        config,
        credential: {
          status: credential,
          configurationStatus: configuredCredential,
          lastValidationStatus,
          ...(definition?.credentialEnv ? { requiredEnv: definition.credentialEnv } : {}),
        },
        supply: {
          open: supplyRows.find((row) => row._id.sourceId === source.sourceId && row._id.status === 'open')?.count ?? 0,
          retained: supplyRows.filter((row) => row._id.sourceId === source.sourceId).reduce((sum, row) => sum + row.count, 0),
        },
        metrics24h: metrics?.metrics24h ?? { ...EMPTY_WINDOW_METRICS },
        metrics7d: metrics?.metrics7d ?? { ...EMPTY_WINDOW_METRICS },
        quota: {
          available: quota !== null,
          usedToday: quota?.usedToday ?? null,
          usedThisMonth: quota?.usedThisMonth ?? null,
        },
        lastOperation: audit.find((row) => row.sourceId === source.sourceId) ?? null,
      }
    }),
    audit,
  }
}
