#!/usr/bin/env tsx
/**
 * Explicit, non-dropping Hire Phase 2 index preparation.
 *
 *   npm run prepare:hire-phase2-indexes              # plan only; no DB connection
 *   npm run check:hire-phase2-indexes                # connected, read-only verification
 *   npm run prepare:hire-phase2-indexes -- --apply   # create only missing exact indexes
 *
 * This command is intentionally scoped to the Phase 2 Hire-control
 * collections introduced for intake, screening, and invitation batches. It
 * suppresses Mongoose schema initialization
 * and never calls syncIndexes or dropIndex.
 *
 * A prior rollout may have created a full unique
 * { workspaceId: 1, applicationId: 1 } index on invitation-batch items. The
 * current privacy-safe schema needs the partial form so redacted rows without
 * applicationId do not collide. If that legacy index is present, this command
 * fails before any write and gives the operator the required manual handoff.
 */

import { pathToFileURL } from 'node:url'
import { connectDB } from '../shared/db/connection'
import {
  HireIntakeTask,
  HireInvitationBatch,
  HireInvitationBatchItem,
  HireScreeningGate,
} from '../modules/hire/models'

export type HirePhase2IndexPreparationMode = 'plan' | 'check' | 'apply' | 'help'

type IndexDirection = 1 | -1
type IndexKey = Readonly<Record<string, IndexDirection>>
type IndexTarget =
  | 'intake-tasks'
  | 'screening-gates'
  | 'invitation-batches'
  | 'invitation-batch-items'

export interface HirePhase2IndexDescription {
  name?: string
  key?: Record<string, unknown>
  unique?: boolean
  partialFilterExpression?: unknown
  expireAfterSeconds?: number
  sparse?: boolean
  hidden?: boolean
  collation?: unknown
}

interface HirePhase2IndexDefinition {
  target: IndexTarget
  name: string
  key: IndexKey
  unique: boolean
  partialFilterExpression?: Record<string, unknown>
  sparse?: true
  purpose: string
}

interface IndexCollection {
  createIndex(
    key: IndexKey,
    options: {
      name: string
      unique?: boolean
      partialFilterExpression?: Record<string, unknown>
      sparse?: true
    },
  ): Promise<string>
  indexes(): Promise<HirePhase2IndexDescription[]>
}

interface InvitationBatchItemCollection extends IndexCollection {
  aggregate<T>(pipeline: unknown[]): { toArray(): Promise<T[]> }
}

function isNamespaceNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { code?: unknown }).code === 26 ||
      (error as { codeName?: unknown }).codeName === 'NamespaceNotFound')
  )
}

const HIRE_INVITATION_BATCH_ITEM_APPLICATION_INDEX_KEY = {
  workspaceId: 1,
  applicationId: 1,
} as const

const HIRE_INVITATION_BATCH_ITEM_APPLICATION_INDEX_PARTIAL = {
  applicationId: { $exists: true },
} as const

/**
 * These names intentionally match MongoDB's stable default key-pattern names
 * used by the corresponding Mongoose schemas. That lets this command verify
 * indexes created by a controlled app deployment without creating a second,
 * key-identical index under a competing name.
 */
export const HIRE_PHASE2_INDEX_DEFINITIONS: readonly HirePhase2IndexDefinition[] = [
  {
    target: 'intake-tasks',
    name: 'workspaceId_1_status_1_nextAttemptAt_1_leaseExpiresAt_1_queuedAt_1__id_1',
    key: {
      workspaceId: 1,
      status: 1,
      nextAttemptAt: 1,
      leaseExpiresAt: 1,
      queuedAt: 1,
      _id: 1,
    },
    unique: false,
    purpose: 'workspace-scoped intake lease claims and recovery',
  },
  {
    target: 'intake-tasks',
    name: 'workspaceId_1_jobId_1_status_1_queuedAt_-1',
    key: { workspaceId: 1, jobId: 1, status: 1, queuedAt: -1 },
    unique: false,
    purpose: 'job-scoped bulk-upload status history',
  },
  {
    target: 'screening-gates',
    name: 'workspaceId_1_jobId_1_confirmedAt_-1__id_-1',
    key: { workspaceId: 1, jobId: 1, confirmedAt: -1, _id: -1 },
    unique: false,
    purpose: 'workspace/job screening-gate history',
  },
  {
    target: 'screening-gates',
    name: 'workspaceId_1_status_1_jobId_1_confirmedAt_-1',
    key: { workspaceId: 1, status: 1, jobId: 1, confirmedAt: -1 },
    unique: false,
    purpose: 'workspace-scoped confirmed/cancelled gate lookup',
  },
  {
    target: 'invitation-batches',
    name: 'workspaceId_1_screeningGateId_1_wave_1',
    key: { workspaceId: 1, screeningGateId: 1, wave: 1 },
    unique: true,
    purpose: 'one durable batch per screening-gate wave',
  },
  {
    target: 'invitation-batches',
    name: 'workspaceId_1_status_1_sendAfter_1__id_1',
    key: { workspaceId: 1, status: 1, sendAfter: 1, _id: 1 },
    unique: false,
    purpose: 'due invitation-batch dispatch work',
  },
  {
    target: 'invitation-batches',
    name: 'workspaceId_1_jobId_1_createdAt_-1__id_-1',
    key: { workspaceId: 1, jobId: 1, createdAt: -1, _id: -1 },
    unique: false,
    purpose: 'job-scoped invitation-batch history',
  },
  {
    target: 'invitation-batch-items',
    name: 'workspaceId_1_applicationId_1',
    key: HIRE_INVITATION_BATCH_ITEM_APPLICATION_INDEX_KEY,
    unique: true,
    partialFilterExpression: HIRE_INVITATION_BATCH_ITEM_APPLICATION_INDEX_PARTIAL,
    purpose: 'one invitation per live workspace application after privacy redaction',
  },
  {
    target: 'invitation-batch-items',
    name: 'workspaceId_1_status_1_sendAfter_1__id_1',
    key: { workspaceId: 1, status: 1, sendAfter: 1, _id: 1 },
    unique: false,
    purpose: 'due invitation-item delivery work',
  },
  {
    target: 'invitation-batch-items',
    name: 'workspaceId_1_screeningGateId_1_rank_1__id_1',
    key: { workspaceId: 1, screeningGateId: 1, rank: 1, _id: 1 },
    unique: false,
    purpose: 'screening-gate rank and waterfall inspection',
  },
  {
    target: 'invitation-batch-items',
    name: 'workspaceId_1_roundId_1',
    key: { workspaceId: 1, roundId: 1 },
    unique: false,
    sparse: true,
    purpose: 'round-to-delivery recovery lookup without indexing redacted rows',
  },
]

export function hirePhase2IndexPreparationModeOf(
  argv: string[],
): HirePhase2IndexPreparationMode {
  const supported = new Set(['--apply', '--check', '--help', '-h'])
  const unknown = argv.filter((argument) => !supported.has(argument))
  if (unknown.length) {
    throw new Error(
      `unknown argument${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`,
    )
  }

  const help = argv.includes('--help') || argv.includes('-h')
  const apply = argv.includes('--apply')
  const check = argv.includes('--check')
  if (help && argv.length > 1) throw new Error('--help cannot be combined with another argument')
  if (apply && check) throw new Error('--apply and --check are mutually exclusive')
  if (help) return 'help'
  return apply ? 'apply' : check ? 'check' : 'plan'
}

function sameKey(actual: Record<string, unknown> | undefined, expected: IndexKey): boolean {
  const actualEntries = Object.entries(actual ?? {})
  const expectedEntries = Object.entries(expected)
  return actualEntries.length === expectedEntries.length && actualEntries.every(
    ([field, direction], position) => (
      field === expectedEntries[position]?.[0] && direction === expectedEntries[position]?.[1]
    ),
  )
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

export function isExactHirePhase2Index(
  index: HirePhase2IndexDescription,
  definition: HirePhase2IndexDefinition,
): boolean {
  return (
    index.name === definition.name &&
    sameKey(index.key, definition.key) &&
    Boolean(index.unique) === definition.unique &&
    sameJson(index.partialFilterExpression, definition.partialFilterExpression) &&
    index.expireAfterSeconds === undefined &&
    (definition.sparse === true ? index.sparse === true : index.sparse !== true) &&
    index.hidden !== true &&
    index.collation === undefined
  )
}

/** The only legacy index this rollout recognizes as safe to hand off manually. */
export function isLegacyFullInvitationApplicationUniqueIndex(
  index: HirePhase2IndexDescription,
): boolean {
  return (
    sameKey(index.key, HIRE_INVITATION_BATCH_ITEM_APPLICATION_INDEX_KEY) &&
    index.unique === true &&
    index.partialFilterExpression === undefined &&
    index.expireAfterSeconds === undefined &&
    index.sparse !== true &&
    index.hidden !== true &&
    index.collation === undefined
  )
}

interface IndexInspection {
  definition: HirePhase2IndexDefinition
  exact: boolean
  sameKeyIndexes: HirePhase2IndexDescription[]
}

type IndexesByTarget = Record<IndexTarget, HirePhase2IndexDescription[]>

function inspectIndexes(indexesByTarget: IndexesByTarget): IndexInspection[] {
  return HIRE_PHASE2_INDEX_DEFINITIONS.map((definition) => {
    const sameKeyIndexes = indexesByTarget[definition.target].filter((index) =>
      sameKey(index.key, definition.key),
    )
    return {
      definition,
      sameKeyIndexes,
      exact: sameKeyIndexes.length === 1 && isExactHirePhase2Index(sameKeyIndexes[0], definition),
    }
  })
}

function legacyInvitationApplicationIndexes(
  inspection: IndexInspection[],
): HirePhase2IndexDescription[] {
  const applicationDefinition = inspection.find(
    ({ definition }) => definition.name === 'workspaceId_1_applicationId_1',
  )
  return (applicationDefinition?.sameKeyIndexes ?? []).filter(
    isLegacyFullInvitationApplicationUniqueIndex,
  )
}

function incompatibleIndexes(inspection: IndexInspection[]): IndexInspection[] {
  return inspection.filter(({ exact, sameKeyIndexes, definition }) => {
    if (exact || sameKeyIndexes.length === 0) return false
    return !(
      definition.name === 'workspaceId_1_applicationId_1' &&
      sameKeyIndexes.every(isLegacyFullInvitationApplicationUniqueIndex)
    )
  })
}

function missingIndexes(inspection: IndexInspection[]): IndexInspection[] {
  return inspection.filter(({ exact, sameKeyIndexes }) => !exact && sameKeyIndexes.length === 0)
}

function describeIndex(index: HirePhase2IndexDescription): string {
  return `${index.name ?? '<unnamed>'} ${JSON.stringify(index.key ?? {})}`
}

function formatDefinitions(): void {
  console.log('\nHire Phase 2 control-plane index preparation')
  console.log('────────────────────────────────────────────')
  for (const definition of HIRE_PHASE2_INDEX_DEFINITIONS) {
    const options = [
      definition.unique ? 'UNIQUE' : undefined,
      definition.partialFilterExpression
        ? `PARTIAL ${JSON.stringify(definition.partialFilterExpression)}`
        : undefined,
      definition.sparse ? 'SPARSE' : undefined,
    ].filter(Boolean).join(' ')
    console.log(
      `${definition.target}.${definition.name}: ${JSON.stringify(definition.key)}${options ? ` ${options}` : ''} — ${definition.purpose}`,
    )
  }
}

function printUsage(): void {
  console.log(`
Usage:
  npm run prepare:hire-phase2-indexes
  npm run check:hire-phase2-indexes
  npm run prepare:hire-phase2-indexes -- --apply

Modes:
  (default)  print the exact Phase 2 Hire-control index plan; no DB connection
  --check    connect read-only and require every exact index
  --apply    create only missing exact indexes after all preconditions pass

Safety:
  --apply never invokes dropIndex or syncIndexes. If the legacy full unique
  workspaceId + applicationId index exists, no writes are attempted. Pause
  invitation-item writers, have an operator replace that exact index manually,
  then run --apply followed by --check.
`)
}

function assertHireControlDatabaseBoundary(connection: unknown): void {
  if (process.env.IPG_SURFACE !== 'hire-control') {
    throw new Error('IPG_SURFACE must be hire-control')
  }
  const expectedDatabase = process.env.HIRE_CONTROL_DATABASE_NAME?.trim()
  const actualDatabase = (connection as { connection?: { name?: unknown } })?.connection?.name
  if (!expectedDatabase || actualDatabase !== expectedDatabase) {
    throw new Error('connected database is not the configured Hire control database')
  }
}

function collectionsByTarget(): Record<IndexTarget, IndexCollection> {
  return {
    'intake-tasks': HireIntakeTask.collection as unknown as IndexCollection,
    'screening-gates': HireScreeningGate.collection as unknown as IndexCollection,
    'invitation-batches': HireInvitationBatch.collection as unknown as IndexCollection,
    'invitation-batch-items': HireInvitationBatchItem.collection as unknown as IndexCollection,
  }
}

async function readIndexes(
  collections: Record<IndexTarget, IndexCollection>,
): Promise<IndexesByTarget> {
  const targets: readonly IndexTarget[] = [
    'intake-tasks',
    'screening-gates',
    'invitation-batches',
    'invitation-batch-items',
  ]
  const result = {} as IndexesByTarget
  await Promise.all(targets.map(async (target) => {
    try {
      result[target] = await collections[target].indexes()
    } catch (error) {
      // A first rollout has no collection yet. In plan/check that is simply
      // every expected index missing; in --apply createIndex will create the
      // collection along with the exact first index. Other database failures
      // stay visible rather than being mistaken for an empty collection.
      if (!isNamespaceNotFoundError(error)) throw error
      result[target] = []
    }
  }))
  return result
}

function reportInspection(inspection: IndexInspection[]): void {
  console.log('\nInspection')
  for (const entry of inspection) {
    if (entry.exact) {
      console.log(`✓ ${entry.definition.target}.${entry.definition.name}`)
    } else if (entry.sameKeyIndexes.length === 0) {
      console.log(`○ ${entry.definition.target}.${entry.definition.name} is missing`)
    } else {
      console.log(
        `! ${entry.definition.target}.${entry.definition.name} has incompatible same-key index(es): ${entry.sameKeyIndexes.map(describeIndex).join('; ')}`,
      )
    }
  }
}

function legacyReplacementError(indexes: HirePhase2IndexDescription[]): Error {
  return new Error(
    `legacy full unique invitation-item index detected (${indexes.map(describeIndex).join('; ')}). ` +
      'No index was changed. The privacy-safe partial unique replacement must be operator-controlled: ' +
      'pause HireInvitationBatchItem writers, verify the workspace/application uniqueness invariant in the maintenance window, ' +
      'manually remove only this exact legacy index in the Hire-control database, then run --apply and --check. ' +
      'This command intentionally never calls dropIndex.',
  )
}

function assertNoIncompatibleIndexes(inspection: IndexInspection[]): void {
  const legacy = legacyInvitationApplicationIndexes(inspection)
  if (legacy.length) throw legacyReplacementError(legacy)

  const incompatible = incompatibleIndexes(inspection)
  if (incompatible.length) {
    throw new Error(
      `incompatible same-key Phase 2 index(es): ${incompatible.map(({ definition, sameKeyIndexes }) => (
        `${definition.target}.${definition.name} <- ${sameKeyIndexes.map(describeIndex).join(', ')}`
      )).join('; ')}. No index was changed; explicit operator repair is required.`,
    )
  }
}

function assertEveryIndexExact(inspection: IndexInspection[]): void {
  assertNoIncompatibleIndexes(inspection)
  const missing = missingIndexes(inspection)
  if (missing.length) {
    throw new Error(
      `missing exact Phase 2 Hire-control index(es): ${missing.map(({ definition }) => (
        `${definition.target}.${definition.name}`
      )).join(', ')}`,
    )
  }
}

async function assertNoLiveInvitationApplicationDuplicates(
  collection: InvitationBatchItemCollection,
): Promise<void> {
  const duplicates = await collection.aggregate<{ _id: unknown; count: number }>([
    { $match: { applicationId: { $exists: true } } },
    {
      $group: {
        _id: { workspaceId: '$workspaceId', applicationId: '$applicationId' },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $limit: 1 },
  ]).toArray()
  if (duplicates.length) {
    throw new Error(
      'duplicate live HireInvitationBatchItem workspace/application rows block the partial unique index; no index was changed',
    )
  }
}

function createOptions(definition: HirePhase2IndexDefinition): {
  name: string
  unique?: boolean
  partialFilterExpression?: Record<string, unknown>
  sparse?: true
} {
  return {
    name: definition.name,
    ...(definition.unique ? { unique: true } : {}),
    ...(definition.partialFilterExpression
      ? { partialFilterExpression: definition.partialFilterExpression }
      : {}),
    ...(definition.sparse ? { sparse: true } : {}),
  }
}

export async function prepareHirePhase2Indexes(argv: string[]): Promise<void> {
  const mode = hirePhase2IndexPreparationModeOf(argv)
  if (mode === 'help') {
    printUsage()
    return
  }

  formatDefinitions()
  if (mode === 'plan') {
    console.log('\nPLAN ONLY — no database connection or index write. Re-run with --check or --apply.')
    return
  }

  // Explicitly suppress Mongoose auto-create/auto-index. All writes below are
  // enumerated createIndex calls, after the full preflight has passed.
  const connection = await connectDB({ schemaInitialization: 'disabled' })
  assertHireControlDatabaseBoundary(connection)
  const collections = collectionsByTarget()
  const before = inspectIndexes(await readIndexes(collections))
  reportInspection(before)

  if (mode === 'check') {
    assertEveryIndexExact(before)
    console.log('\nCHECK PASSED — all 12 exact Phase 2 Hire-control indexes exist.')
    return
  }

  // Preflight all targets before the first create. A legacy or unsafe index
  // therefore cannot leave unrelated index creation half-applied.
  assertNoIncompatibleIndexes(before)
  await assertNoLiveInvitationApplicationDuplicates(
    HireInvitationBatchItem.collection as unknown as InvitationBatchItemCollection,
  )
  for (const { definition } of missingIndexes(before)) {
    const indexName = await collections[definition.target].createIndex(
      definition.key,
      createOptions(definition),
    )
    console.log(`Prepared ${definition.target}.${indexName}`)
  }

  const after = inspectIndexes(await readIndexes(collections))
  assertEveryIndexExact(after)
  console.log('\nAPPLY PASSED — all 12 exact indexes exist; no index was removed.')
}

async function main(): Promise<void> {
  await prepareHirePhase2Indexes(process.argv.slice(2))
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Hire Phase 2 index preparation failed:', error)
      process.exit(1)
    })
}
