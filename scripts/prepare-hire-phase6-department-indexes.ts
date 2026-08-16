#!/usr/bin/env tsx
/**
 * Explicit, non-dropping Hire Phase 6 department index preparation.
 *
 *   npm run prepare:hire-phase6-department-indexes              # plan only
 *   npm run check:hire-phase6-department-indexes                # read-only
 *   npm run prepare:hire-phase6-department-indexes -- --apply   # exact creates
 *
 * Department assignment is a required job coordinate. This release gate owns
 * the three Department catalogue indexes and the job read/filter index which
 * backs department-scoped operations. It never calls syncIndexes, dropIndex,
 * or any bulk index mutation.
 */

import { pathToFileURL } from 'node:url'
import { connectDB } from '../shared/db/connection'
import { HireDepartment } from '../modules/hire-departments/models'
import { HireJob } from '../modules/hire/models'

export type HirePhase6DepartmentIndexPreparationMode =
  | 'plan'
  | 'check'
  | 'apply'
  | 'help'

type IndexDirection = 1 | -1
type IndexKey = Readonly<Record<string, IndexDirection>>
type PartialFilterExpression = Readonly<Record<string, unknown>>
type IndexTarget = 'departments' | 'jobs'

export interface HirePhase6DepartmentIndexDescription {
  name?: string
  key?: Record<string, unknown>
  unique?: boolean
  partialFilterExpression?: unknown
  expireAfterSeconds?: number
  sparse?: boolean
  hidden?: boolean
  collation?: unknown
}

export interface HirePhase6DepartmentIndexDefinition {
  target: IndexTarget
  name: string
  key: IndexKey
  unique: boolean
  sparse: boolean
  partialFilterExpression?: PartialFilterExpression
  purpose: string
}

interface IndexCollection {
  createIndex(
    key: IndexKey,
    options: {
      name: string
      unique?: boolean
      sparse?: boolean
      partialFilterExpression?: PartialFilterExpression
    },
  ): Promise<string>
  indexes(): Promise<HirePhase6DepartmentIndexDescription[]>
  aggregate<T>(pipeline: unknown[]): { toArray(): Promise<T[]> }
}

/** These names exactly match the Phase 6 Department and HireJob schemas. */
export const HIRE_PHASE6_DEPARTMENT_INDEX_DEFINITIONS: readonly HirePhase6DepartmentIndexDefinition[] = [
  {
    target: 'departments',
    name: 'workspaceId_1_normalizedName_1',
    key: { workspaceId: 1, normalizedName: 1 },
    unique: true,
    sparse: false,
    purpose: 'one normalized department catalogue name per workspace',
  },
  {
    target: 'departments',
    name: 'workspaceId_1_status_1_kind_1_name_1',
    key: { workspaceId: 1, status: 1, kind: 1, name: 1 },
    unique: false,
    sparse: false,
    purpose: 'workspace department picker and archived/system catalogue listing',
  },
  {
    target: 'departments',
    name: 'workspaceId_1_systemKey_1',
    key: { workspaceId: 1, systemKey: 1 },
    unique: true,
    sparse: false,
    partialFilterExpression: { systemKey: { $exists: true } },
    purpose: 'one durable system-owned legacy/onboarding coordinate per workspace',
  },
  {
    target: 'jobs',
    name: 'workspaceId_1_departmentId_1_status_1_createdAt_-1',
    key: { workspaceId: 1, departmentId: 1, status: 1, createdAt: -1 },
    unique: false,
    sparse: false,
    purpose: 'department-scoped job tracking, status filters, and recency ordering',
  },
]

const INDEX_TARGETS: readonly IndexTarget[] = ['departments', 'jobs']

function isNamespaceNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { code?: unknown }).code === 26 ||
      (error as { codeName?: unknown }).codeName === 'NamespaceNotFound')
  )
}

export function hirePhase6DepartmentIndexPreparationModeOf(
  argv: string[],
): HirePhase6DepartmentIndexPreparationMode {
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

function sameKey(
  actual: Record<string, unknown> | undefined,
  expected: IndexKey,
): boolean {
  const actualEntries = Object.entries(actual ?? {})
  const expectedEntries = Object.entries(expected)
  return (
    actualEntries.length === expectedEntries.length &&
    actualEntries.every(
      ([field, direction], position) =>
        field === expectedEntries[position]?.[0] &&
        direction === expectedEntries[position]?.[1],
    )
  )
}

function samePartialFilter(
  actual: unknown,
  expected: PartialFilterExpression | undefined,
): boolean {
  if (actual === undefined || expected === undefined) return actual === expected
  return JSON.stringify(actual) === JSON.stringify(expected)
}

export function isExactHirePhase6DepartmentIndex(
  index: HirePhase6DepartmentIndexDescription,
  definition: HirePhase6DepartmentIndexDefinition,
): boolean {
  return (
    index.name === definition.name &&
    sameKey(index.key, definition.key) &&
    Boolean(index.unique) === definition.unique &&
    samePartialFilter(
      index.partialFilterExpression,
      definition.partialFilterExpression,
    ) &&
    index.expireAfterSeconds === undefined &&
    Boolean(index.sparse) === definition.sparse &&
    index.hidden !== true &&
    index.collation === undefined
  )
}

interface IndexInspection {
  definition: HirePhase6DepartmentIndexDefinition
  exact: boolean
  sameKeyIndexes: HirePhase6DepartmentIndexDescription[]
}

type IndexesByTarget = Record<IndexTarget, HirePhase6DepartmentIndexDescription[]>

function inspectIndexes(indexesByTarget: IndexesByTarget): IndexInspection[] {
  return HIRE_PHASE6_DEPARTMENT_INDEX_DEFINITIONS.map((definition) => {
    const sameKeyIndexes = indexesByTarget[definition.target].filter((index) =>
      sameKey(index.key, definition.key),
    )
    return {
      definition,
      sameKeyIndexes,
      exact:
        sameKeyIndexes.length === 1 &&
        isExactHirePhase6DepartmentIndex(sameKeyIndexes[0], definition),
    }
  })
}

function missingIndexes(inspection: IndexInspection[]): IndexInspection[] {
  return inspection.filter(
    ({ exact, sameKeyIndexes }) => !exact && sameKeyIndexes.length === 0,
  )
}

function incompatibleIndexes(inspection: IndexInspection[]): IndexInspection[] {
  return inspection.filter(
    ({ exact, sameKeyIndexes }) => !exact && sameKeyIndexes.length > 0,
  )
}

function describeIndex(index: HirePhase6DepartmentIndexDescription): string {
  return `${index.name ?? '<unnamed>'} ${JSON.stringify(index.key ?? {})}`
}

function assertNoIncompatibleIndexes(inspection: IndexInspection[]): void {
  const incompatible = incompatibleIndexes(inspection)
  if (!incompatible.length) return
  throw new Error(
    `incompatible same-key Phase 6 department index(es): ${incompatible
      .map(
        ({ definition, sameKeyIndexes }) =>
          `${definition.target}.${definition.name} <- ${sameKeyIndexes
            .map(describeIndex)
            .join(', ')}`,
      )
      .join('; ')}. No index was changed; explicit operator repair is required.`,
  )
}

function assertEveryIndexExact(inspection: IndexInspection[]): void {
  assertNoIncompatibleIndexes(inspection)
  const missing = missingIndexes(inspection)
  if (!missing.length) return
  throw new Error(
    `missing exact Phase 6 Hire-control department index(es): ${missing
      .map(({ definition }) => `${definition.target}.${definition.name}`)
      .join(', ')}`,
  )
}

function formatDefinitions(): void {
  console.log('\nHire Phase 6 department index preparation')
  console.log('───────────────────────────────────────')
  for (const definition of HIRE_PHASE6_DEPARTMENT_INDEX_DEFINITIONS) {
    const options = [
      definition.unique ? 'UNIQUE' : '',
      definition.sparse ? 'SPARSE' : '',
      definition.partialFilterExpression
        ? `PARTIAL ${JSON.stringify(definition.partialFilterExpression)}`
        : '',
    ]
      .filter(Boolean)
      .join(' ')
    console.log(
      `${definition.target}.${definition.name}: ${JSON.stringify(definition.key)}${
        options ? ` ${options}` : ''
      } — ${definition.purpose}`,
    )
  }
}

function printUsage(): void {
  console.log(`
Usage:
  npm run prepare:hire-phase6-department-indexes
  npm run check:hire-phase6-department-indexes
  npm run prepare:hire-phase6-department-indexes -- --apply

Modes:
  (default)  print the exact Phase 6 Hire-control index plan; no database connection
  --check    connect read-only and require every exact index
  --apply    create only missing exact indexes after all preconditions pass

Safety:
  --apply never invokes dropIndex, syncIndexes, or a bulk index mutation. It
  stops before any write when a same-key index is incompatible or duplicate
  Department catalogue rows would violate the unique invariant.
`)
}

function assertHireControlDatabaseBoundary(connection: unknown): void {
  if (process.env.IPG_SURFACE !== 'hire-control') {
    throw new Error('IPG_SURFACE must be hire-control')
  }
  const expectedDatabase = process.env.HIRE_CONTROL_DATABASE_NAME?.trim()
  const actualDatabase = (connection as { connection?: { name?: unknown } })
    ?.connection?.name
  if (!expectedDatabase || actualDatabase !== expectedDatabase) {
    throw new Error('connected database is not the configured Hire control database')
  }
}

function collectionsByTarget(): Record<IndexTarget, IndexCollection> {
  return {
    departments: HireDepartment.collection as unknown as IndexCollection,
    jobs: HireJob.collection as unknown as IndexCollection,
  }
}

async function readIndexes(
  collections: Record<IndexTarget, IndexCollection>,
): Promise<IndexesByTarget> {
  const result = {} as IndexesByTarget
  await Promise.all(
    INDEX_TARGETS.map(async (target) => {
      try {
        result[target] = await collections[target].indexes()
      } catch (error) {
        // A first rollout may not have materialized a collection. It is simply
        // missing all indexes until --apply creates the first exact one.
        if (!isNamespaceNotFoundError(error)) throw error
        result[target] = []
      }
    }),
  )
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
        `! ${entry.definition.target}.${entry.definition.name} has incompatible same-key index(es): ${entry.sameKeyIndexes
          .map(describeIndex)
          .join('; ')}`,
      )
    }
  }
}

function duplicatePipelineForDepartmentUniqueIndex(
  definition: HirePhase6DepartmentIndexDefinition,
): unknown[] {
  if (definition.name === 'workspaceId_1_normalizedName_1') {
    return [
      {
        $group: {
          _id: {
            workspaceId: '$workspaceId',
            normalizedName: '$normalizedName',
          },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 1 },
    ]
  }
  if (definition.name === 'workspaceId_1_systemKey_1') {
    return [
      // Must exactly match the partial unique-index population.
      {
        $match: {
          systemKey: { $exists: true },
        },
      },
      {
        $group: {
          _id: {
            workspaceId: '$workspaceId',
            systemKey: '$systemKey',
          },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 1 },
    ]
  }
  throw new Error('missing duplicate preflight for a unique Department index')
}

async function assertNoDepartmentUniqueIndexDuplicates(
  collection: IndexCollection,
  definition: HirePhase6DepartmentIndexDefinition,
): Promise<void> {
  try {
    const duplicates = await collection
      .aggregate<{ _id: unknown; count: number }>(
        duplicatePipelineForDepartmentUniqueIndex(definition),
      )
      .toArray()
    if (duplicates.length) {
      throw new Error(
        'duplicate Department rows block a Phase 6 unique index; no index was changed',
      )
    }
  } catch (error) {
    if (isNamespaceNotFoundError(error)) return
    throw error
  }
}

function createOptions(
  definition: HirePhase6DepartmentIndexDefinition,
): {
  name: string
  unique?: boolean
  sparse?: boolean
  partialFilterExpression?: PartialFilterExpression
} {
  return {
    name: definition.name,
    ...(definition.unique ? { unique: true } : {}),
    ...(definition.sparse ? { sparse: true } : {}),
    ...(definition.partialFilterExpression
      ? { partialFilterExpression: definition.partialFilterExpression }
      : {}),
  }
}

export async function prepareHirePhase6DepartmentIndexes(
  argv: string[],
): Promise<void> {
  const mode = hirePhase6DepartmentIndexPreparationModeOf(argv)
  if (mode === 'help') {
    printUsage()
    return
  }
  formatDefinitions()
  if (mode === 'plan') {
    console.log('\nPLAN ONLY — no database connection or index write. Re-run with --check or --apply.')
    return
  }

  // Suppress Mongoose automatic index initialization. The only possible write
  // is an exact createIndex call after the complete preflight passes.
  const connection = await connectDB({ schemaInitialization: 'disabled' })
  assertHireControlDatabaseBoundary(connection)
  const collections = collectionsByTarget()
  const before = inspectIndexes(await readIndexes(collections))
  reportInspection(before)

  if (mode === 'check') {
    assertEveryIndexExact(before)
    console.log(
      `\nCHECK PASSED — all ${HIRE_PHASE6_DEPARTMENT_INDEX_DEFINITIONS.length} exact Phase 6 Hire-control department indexes exist.`,
    )
    return
  }

  assertNoIncompatibleIndexes(before)
  const missingDepartmentUniqueIndexes = missingIndexes(before).filter(
    ({ definition }) => definition.target === 'departments' && definition.unique,
  )
  for (const { definition } of missingDepartmentUniqueIndexes) {
    await assertNoDepartmentUniqueIndexDuplicates(collections.departments, definition)
  }
  for (const { definition } of missingIndexes(before)) {
    const indexName = await collections[definition.target].createIndex(
      definition.key,
      createOptions(definition),
    )
    console.log(`Prepared ${definition.target}.${indexName}`)
  }
  const after = inspectIndexes(await readIndexes(collections))
  assertEveryIndexExact(after)
  console.log(
    `\nAPPLY PASSED — all ${HIRE_PHASE6_DEPARTMENT_INDEX_DEFINITIONS.length} exact indexes exist; no index was removed.`,
  )
}

async function main(): Promise<void> {
  await prepareHirePhase6DepartmentIndexes(process.argv.slice(2))
}

const isMain =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Hire Phase 6 department index preparation failed:', error)
      process.exit(1)
    })
}
