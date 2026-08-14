#!/usr/bin/env tsx
/**
 * Explicit, non-dropping Hire Phase 3 index preparation.
 *
 *   npm run prepare:hire-phase3-indexes              # plan only; no DB connection
 *   npm run check:hire-phase3-indexes                # connected, read-only verification
 *   npm run prepare:hire-phase3-indexes -- --apply   # create only missing exact indexes
 *
 * This command is deliberately limited to the distinct human-round
 * control-plane collections. It never calls `syncIndexes`, `dropIndex`, or a
 * model-wide index initializer. Existing same-key indexes must be repaired by
 * an operator before this command can write anything.
 */

import { pathToFileURL } from 'node:url'
import { connectDB } from '../shared/db/connection'
import {
  HireHumanKitDelivery,
  HireHumanRound,
  HireHumanScorecard,
  HireInterviewKit,
} from '../modules/hire/models'

export type HirePhase3IndexPreparationMode = 'plan' | 'check' | 'apply' | 'help'

type IndexDirection = 1 | -1
type IndexKey = Readonly<Record<string, IndexDirection>>
type IndexTarget =
  | 'human-rounds'
  | 'interview-kits'
  | 'human-scorecards'
  | 'human-kit-deliveries'

export interface HirePhase3IndexDescription {
  name?: string
  key?: Record<string, unknown>
  unique?: boolean
  partialFilterExpression?: unknown
  expireAfterSeconds?: number
  sparse?: boolean
  hidden?: boolean
  collation?: unknown
}

export interface HirePhase3IndexDefinition {
  target: IndexTarget
  name: string
  key: IndexKey
  unique: boolean
  partialFilterExpression?: Record<string, unknown>
  expireAfterSeconds?: number
  purpose: string
}

interface IndexCollection {
  createIndex(
    key: IndexKey,
    options: {
      name: string
      unique?: boolean
      partialFilterExpression?: Record<string, unknown>
      expireAfterSeconds?: number
    },
  ): Promise<string>
  indexes(): Promise<HirePhase3IndexDescription[]>
  aggregate<T>(pipeline: unknown[]): { toArray(): Promise<T[]> }
}

const HIRE_INTERVIEW_KIT_ACTIVE_PARTIAL = { active: true } as const

/**
 * These names match MongoDB's stable key-pattern names emitted by the Phase 3
 * Mongoose schemas. Verification therefore accepts a controlled deployment's
 * matching index and never creates a competing same-key index.
 */
export const HIRE_PHASE3_INDEX_DEFINITIONS: readonly HirePhase3IndexDefinition[] = [
  {
    target: 'human-rounds',
    name: 'workspaceId_1_applicationId_1_createdAt_-1',
    key: { workspaceId: 1, applicationId: 1, createdAt: -1 },
    unique: false,
    purpose: 'application-scoped human-round history',
  },
  {
    target: 'human-rounds',
    name: 'workspaceId_1_jobId_1_status_1_createdAt_-1',
    key: { workspaceId: 1, jobId: 1, status: 1, createdAt: -1 },
    unique: false,
    purpose: 'job-scoped pending-scorecard and completed round projection',
  },
  {
    target: 'human-rounds',
    name: 'workspaceId_1_creationOperationId_1',
    key: { workspaceId: 1, creationOperationId: 1 },
    unique: true,
    purpose: 'workspace-scoped human-round create idempotency',
  },
  {
    target: 'interview-kits',
    name: 'workspaceId_1__id_1_secretHash_1',
    key: { workspaceId: 1, _id: 1, secretHash: 1 },
    unique: false,
    purpose: 'tenant-scoped public capability verification',
  },
  {
    target: 'interview-kits',
    name: 'workspaceId_1_humanRoundId_1_active_1',
    key: { workspaceId: 1, humanRoundId: 1, active: 1 },
    unique: true,
    partialFilterExpression: HIRE_INTERVIEW_KIT_ACTIVE_PARTIAL,
    purpose: 'at most one live public kit for one human round',
  },
  {
    target: 'interview-kits',
    name: 'workspaceId_1_applicationId_1_status_1',
    key: { workspaceId: 1, applicationId: 1, status: 1 },
    unique: false,
    purpose: 'application detail and lifecycle kit lookup',
  },
  {
    target: 'human-scorecards',
    name: 'workspaceId_1_humanRoundId_1_reviewerKey_1',
    key: { workspaceId: 1, humanRoundId: 1, reviewerKey: 1 },
    unique: true,
    purpose: 'one scorecard per immutable reviewer authority',
  },
  {
    target: 'human-scorecards',
    name: 'workspaceId_1_applicationId_1_status_1_createdAt_-1',
    key: { workspaceId: 1, applicationId: 1, status: 1, createdAt: -1 },
    unique: false,
    purpose: 'application scorecard projection and pending tracking',
  },
  {
    target: 'human-kit-deliveries',
    name: 'workspaceId_1_kitId_1_purpose_1',
    key: { workspaceId: 1, kitId: 1, purpose: 1 },
    unique: true,
    purpose: 'one durable initial delivery and one reminder per kit',
  },
  {
    target: 'human-kit-deliveries',
    name: 'workspaceId_1_status_1_dueAt_1_leaseExpiresAt_1',
    key: { workspaceId: 1, status: 1, dueAt: 1, leaseExpiresAt: 1 },
    unique: false,
    purpose: 'tenant-fair due-delivery claims and lease recovery',
  },
  {
    target: 'human-kit-deliveries',
    name: 'workspaceId_1_candidateId_1_humanRoundId_1',
    key: { workspaceId: 1, candidateId: 1, humanRoundId: 1 },
    unique: false,
    purpose: 'candidate privacy cleanup and human-round lifecycle shutdown',
  },
  {
    target: 'human-kit-deliveries',
    name: 'expiresAt_1',
    key: { expiresAt: 1 },
    unique: false,
    expireAfterSeconds: 0,
    purpose: 'eventual expiry of encrypted recovery capability and recipient PII',
  },
]

function isNamespaceNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { code?: unknown }).code === 26 ||
      (error as { codeName?: unknown }).codeName === 'NamespaceNotFound')
  )
}

export function hirePhase3IndexPreparationModeOf(
  argv: string[],
): HirePhase3IndexPreparationMode {
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

export function isExactHirePhase3Index(
  index: HirePhase3IndexDescription,
  definition: HirePhase3IndexDefinition,
): boolean {
  return (
    index.name === definition.name &&
    sameKey(index.key, definition.key) &&
    Boolean(index.unique) === definition.unique &&
    sameJson(index.partialFilterExpression, definition.partialFilterExpression) &&
    index.expireAfterSeconds === definition.expireAfterSeconds &&
    index.sparse !== true &&
    index.hidden !== true &&
    index.collation === undefined
  )
}

interface IndexInspection {
  definition: HirePhase3IndexDefinition
  exact: boolean
  sameKeyIndexes: HirePhase3IndexDescription[]
}

type IndexesByTarget = Record<IndexTarget, HirePhase3IndexDescription[]>

function inspectIndexes(indexesByTarget: IndexesByTarget): IndexInspection[] {
  return HIRE_PHASE3_INDEX_DEFINITIONS.map((definition) => {
    const sameKeyIndexes = indexesByTarget[definition.target].filter((index) =>
      sameKey(index.key, definition.key),
    )
    return {
      definition,
      sameKeyIndexes,
      exact: sameKeyIndexes.length === 1 && isExactHirePhase3Index(sameKeyIndexes[0], definition),
    }
  })
}

function missingIndexes(inspection: IndexInspection[]): IndexInspection[] {
  return inspection.filter(({ exact, sameKeyIndexes }) => !exact && sameKeyIndexes.length === 0)
}

function incompatibleIndexes(inspection: IndexInspection[]): IndexInspection[] {
  return inspection.filter(({ exact, sameKeyIndexes }) => !exact && sameKeyIndexes.length > 0)
}

function describeIndex(index: HirePhase3IndexDescription): string {
  return `${index.name ?? '<unnamed>'} ${JSON.stringify(index.key ?? {})}`
}

function assertNoIncompatibleIndexes(inspection: IndexInspection[]): void {
  const incompatible = incompatibleIndexes(inspection)
  if (incompatible.length) {
    throw new Error(
      `incompatible same-key Phase 3 index(es): ${incompatible.map(({ definition, sameKeyIndexes }) => (
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
      `missing exact Phase 3 Hire-control index(es): ${missing.map(({ definition }) => (
        `${definition.target}.${definition.name}`
      )).join(', ')}`,
    )
  }
}

function formatDefinitions(): void {
  console.log('\nHire Phase 3 control-plane index preparation')
  console.log('────────────────────────────────────────────')
  for (const definition of HIRE_PHASE3_INDEX_DEFINITIONS) {
    const options = [
      definition.unique ? 'UNIQUE' : undefined,
      definition.partialFilterExpression
        ? `PARTIAL ${JSON.stringify(definition.partialFilterExpression)}`
        : undefined,
      definition.expireAfterSeconds !== undefined
        ? `TTL ${definition.expireAfterSeconds}s`
        : undefined,
    ].filter(Boolean).join(' ')
    console.log(
      `${definition.target}.${definition.name}: ${JSON.stringify(definition.key)}${options ? ` ${options}` : ''} — ${definition.purpose}`,
    )
  }
}

function printUsage(): void {
  console.log(`
Usage:
  npm run prepare:hire-phase3-indexes
  npm run check:hire-phase3-indexes
  npm run prepare:hire-phase3-indexes -- --apply

Modes:
  (default)  print the exact Phase 3 Hire-control index plan; no database connection
  --check    connect read-only and require every exact index
  --apply    create only missing exact indexes after all preconditions pass

Safety:
  --apply never invokes dropIndex or syncIndexes. It stops before any write
  when a same-key index has incompatible options or live duplicate data would
  violate one of Phase 3's unique index invariants. Repair only the named
  incompatibility in a controlled maintenance window, then run --apply and
  --check.
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
    'human-rounds': HireHumanRound.collection as unknown as IndexCollection,
    'interview-kits': HireInterviewKit.collection as unknown as IndexCollection,
    'human-scorecards': HireHumanScorecard.collection as unknown as IndexCollection,
    'human-kit-deliveries': HireHumanKitDelivery.collection as unknown as IndexCollection,
  }
}

async function readIndexes(
  collections: Record<IndexTarget, IndexCollection>,
): Promise<IndexesByTarget> {
  const targets: readonly IndexTarget[] = [
    'human-rounds',
    'interview-kits',
    'human-scorecards',
    'human-kit-deliveries',
  ]
  const result = {} as IndexesByTarget
  await Promise.all(targets.map(async (target) => {
    try {
      result[target] = await collections[target].indexes()
    } catch (error) {
      // A first rollout need not have materialized a collection. It is simply
      // missing all indexes until --apply creates the first exact one.
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

interface UniqueIndexDuplicateCheck {
  target: IndexTarget
  label: string
  pipeline: unknown[]
}

const UNIQUE_INDEX_DUPLICATE_CHECKS: readonly UniqueIndexDuplicateCheck[] = [
  {
    target: 'human-rounds',
    label: 'workspace/creation operation human-round rows',
    pipeline: [
      {
        $group: {
          _id: { workspaceId: '$workspaceId', creationOperationId: '$creationOperationId' },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 1 },
    ],
  },
  {
    target: 'interview-kits',
    label: 'live workspace/human-round interview kits',
    pipeline: [
      { $match: HIRE_INTERVIEW_KIT_ACTIVE_PARTIAL },
      {
        $group: {
          _id: { workspaceId: '$workspaceId', humanRoundId: '$humanRoundId', active: '$active' },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 1 },
    ],
  },
  {
    target: 'human-scorecards',
    label: 'workspace/human-round/reviewer scorecards',
    pipeline: [
      {
        $group: {
          _id: {
            workspaceId: '$workspaceId',
            humanRoundId: '$humanRoundId',
            reviewerKey: '$reviewerKey',
          },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 1 },
    ],
  },
  {
    target: 'human-kit-deliveries',
    label: 'workspace/kit/purpose delivery rows',
    pipeline: [
      {
        $group: {
          _id: { workspaceId: '$workspaceId', kitId: '$kitId', purpose: '$purpose' },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 1 },
    ],
  },
]

async function assertNoUniqueIndexDuplicates(
  collections: Record<IndexTarget, IndexCollection>,
): Promise<void> {
  for (const check of UNIQUE_INDEX_DUPLICATE_CHECKS) {
    let duplicates: Array<{ _id: unknown; count: number }>
    try {
      duplicates = await collections[check.target].aggregate<{ _id: unknown; count: number }>(
        check.pipeline,
      ).toArray()
    } catch (error) {
      if (isNamespaceNotFoundError(error)) continue
      throw error
    }
    if (duplicates.length) {
      throw new Error(
        `duplicate ${check.label} block the Phase 3 unique index; no index was changed`,
      )
    }
  }
}

function createOptions(definition: HirePhase3IndexDefinition): {
  name: string
  unique?: boolean
  partialFilterExpression?: Record<string, unknown>
  expireAfterSeconds?: number
} {
  return {
    name: definition.name,
    ...(definition.unique ? { unique: true } : {}),
    ...(definition.partialFilterExpression
      ? { partialFilterExpression: definition.partialFilterExpression }
      : {}),
    ...(definition.expireAfterSeconds !== undefined
      ? { expireAfterSeconds: definition.expireAfterSeconds }
      : {}),
  }
}

export async function prepareHirePhase3Indexes(argv: string[]): Promise<void> {
  const mode = hirePhase3IndexPreparationModeOf(argv)
  if (mode === 'help') {
    printUsage()
    return
  }

  formatDefinitions()
  if (mode === 'plan') {
    console.log('\nPLAN ONLY — no database connection or index write. Re-run with --check or --apply.')
    return
  }

  // Suppress Mongoose auto-create/auto-index. Every possible write is a
  // listed `createIndex`, made only after all targets and unique data checks
  // pass in the same control-plane connection.
  const connection = await connectDB({ schemaInitialization: 'disabled' })
  assertHireControlDatabaseBoundary(connection)
  const collections = collectionsByTarget()
  const before = inspectIndexes(await readIndexes(collections))
  reportInspection(before)

  if (mode === 'check') {
    assertEveryIndexExact(before)
    console.log(`\nCHECK PASSED — all ${HIRE_PHASE3_INDEX_DEFINITIONS.length} exact Phase 3 Hire-control indexes exist.`)
    return
  }

  // Full preflight precedes the first write. This prevents an incompatible
  // older deployment or a duplicate unique coordinate from leaving other
  // Phase 3 indexes partially applied.
  assertNoIncompatibleIndexes(before)
  await assertNoUniqueIndexDuplicates(collections)
  for (const { definition } of missingIndexes(before)) {
    const indexName = await collections[definition.target].createIndex(
      definition.key,
      createOptions(definition),
    )
    console.log(`Prepared ${definition.target}.${indexName}`)
  }

  const after = inspectIndexes(await readIndexes(collections))
  assertEveryIndexExact(after)
  console.log(`\nAPPLY PASSED — all ${HIRE_PHASE3_INDEX_DEFINITIONS.length} exact indexes exist; no index was removed.`)
}

async function main(): Promise<void> {
  await prepareHirePhase3Indexes(process.argv.slice(2))
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Hire Phase 3 index preparation failed:', error)
      process.exit(1)
    })
}
