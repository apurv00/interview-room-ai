#!/usr/bin/env tsx
/**
 * Explicit, non-dropping Hire Phase 4 decision-control index preparation.
 *
 *   npm run prepare:hire-phase4-indexes              # plan only; no DB connection
 *   npm run check:hire-phase4-indexes                # connected, read-only verification
 *   npm run prepare:hire-phase4-indexes -- --apply   # create only missing exact indexes
 *
 * This covers every Phase 4 decision collection: share packets, their single
 * external verdicts, private assessment exports, and durable export-cleanup
 * tombstones. The export row owns a private R2 object, so it deliberately
 * avoids TTL indexes: an asynchronous TTL deletion could strand an object
 * without its coordinate. Lifecycle and recovery cancel/delete explicitly.
 * This script never calls syncIndexes or dropIndex.
 */

import { pathToFileURL } from 'node:url'
import { connectDB } from '../shared/db/connection'
import {
  HireAssessmentExport,
  HireAssessmentExportCleanup,
  HireExternalVerdict,
  HireSharePacket,
} from '../modules/hire-decisions/models'

export type HirePhase4IndexPreparationMode = 'plan' | 'check' | 'apply' | 'help'

type IndexDirection = 1 | -1
type IndexKey = Readonly<Record<string, IndexDirection>>
type IndexTarget =
  | 'share-packets'
  | 'external-verdicts'
  | 'assessment-exports'
  | 'assessment-export-cleanups'

export interface HirePhase4IndexDescription {
  name?: string
  key?: Record<string, unknown>
  unique?: boolean
  partialFilterExpression?: unknown
  expireAfterSeconds?: number
  sparse?: boolean
  hidden?: boolean
  collation?: unknown
}

export interface HirePhase4IndexDefinition {
  target: IndexTarget
  name: string
  key: IndexKey
  unique: boolean
  purpose: string
}

interface IndexCollection {
  createIndex(key: IndexKey, options: { name: string; unique?: boolean }): Promise<string>
  indexes(): Promise<HirePhase4IndexDescription[]>
  aggregate<T>(pipeline: unknown[]): { toArray(): Promise<T[]> }
}

/** These names exactly match the Phase 4 decision-model schema declarations. */
export const HIRE_PHASE4_INDEX_DEFINITIONS: readonly HirePhase4IndexDefinition[] = [
  {
    target: 'share-packets',
    name: 'workspaceId_1_creationOperationId_1',
    key: { workspaceId: 1, creationOperationId: 1 },
    unique: true,
    purpose: 'workspace-scoped share-packet create idempotency',
  },
  {
    target: 'share-packets',
    name: 'workspaceId_1_applicationId_1_active_1_expiresAt_1',
    key: { workspaceId: 1, applicationId: 1, active: 1, expiresAt: 1 },
    unique: false,
    purpose: 'application packet lifecycle, revocation, and expiry lookup',
  },
  {
    target: 'share-packets',
    name: 'workspaceId_1_candidateId_1',
    key: { workspaceId: 1, candidateId: 1 },
    unique: false,
    purpose: 'candidate privacy and retention packet snapshot redaction',
  },
  {
    target: 'external-verdicts',
    name: 'workspaceId_1_packetId_1',
    key: { workspaceId: 1, packetId: 1 },
    unique: true,
    purpose: 'exactly one external verdict consumes one packet capability',
  },
  {
    target: 'external-verdicts',
    name: 'workspaceId_1_applicationId_1_submittedAt_-1',
    key: { workspaceId: 1, applicationId: 1, submittedAt: -1 },
    unique: false,
    purpose: 'application decision aggregate and action-inbox history',
  },
  {
    target: 'external-verdicts',
    name: 'workspaceId_1_candidateId_1',
    key: { workspaceId: 1, candidateId: 1 },
    unique: false,
    purpose: 'candidate privacy and retention external comment redaction',
  },
  {
    target: 'assessment-exports',
    name: 'workspaceId_1_creationOperationId_1',
    key: { workspaceId: 1, creationOperationId: 1 },
    unique: true,
    purpose: 'workspace-scoped assessment-export request idempotency',
  },
  {
    target: 'assessment-exports',
    name: 'workspaceId_1_applicationId_1_createdAt_-1',
    key: { workspaceId: 1, applicationId: 1, createdAt: -1 },
    unique: false,
    purpose: 'member-scoped opaque export status history',
  },
  {
    target: 'assessment-exports',
    name: 'workspaceId_1_status_1_nextRetryAt_1_leaseExpiresAt_1_expiresAt_1',
    key: { workspaceId: 1, status: 1, nextRetryAt: 1, leaseExpiresAt: 1, expiresAt: 1 },
    unique: false,
    purpose: 'tenant-fair pending/failed retry, expired lease, and expiry recovery',
  },
  {
    target: 'assessment-exports',
    name: 'workspaceId_1_candidateId_1_status_1',
    key: { workspaceId: 1, candidateId: 1, status: 1 },
    unique: false,
    purpose: 'candidate privacy cancellation and private-object cleanup lookup',
  },
  {
    target: 'assessment-exports',
    name: 'workspaceId_1_jobId_1_status_1',
    key: { workspaceId: 1, jobId: 1, status: 1 },
    unique: false,
    purpose: 'job-close cancellation of live private assessment exports',
  },
  {
    target: 'assessment-export-cleanups',
    name: 'workspaceId_1_exportId_1',
    key: { workspaceId: 1, exportId: 1 },
    unique: true,
    purpose: 'one durable deletion tombstone for one exact private export object',
  },
  {
    target: 'assessment-export-cleanups',
    name: 'firstSweepAt_1_nextRetryAt_1_cleanupNotBeforeAt_1_leaseExpiresAt_1__id_1',
    key: { firstSweepAt: 1, nextRetryAt: 1, cleanupNotBeforeAt: 1, leaseExpiresAt: 1, _id: 1 },
    unique: false,
    purpose: 'fresh-first bounded cleanup recovery after deletion-pending and hard-purged roots',
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

export function hirePhase4IndexPreparationModeOf(argv: string[]): HirePhase4IndexPreparationMode {
  const supported = new Set(['--apply', '--check', '--help', '-h'])
  const unknown = argv.filter((argument) => !supported.has(argument))
  if (unknown.length) {
    throw new Error(`unknown argument${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`)
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

export function isExactHirePhase4Index(
  index: HirePhase4IndexDescription,
  definition: HirePhase4IndexDefinition,
): boolean {
  return (
    index.name === definition.name &&
    sameKey(index.key, definition.key) &&
    Boolean(index.unique) === definition.unique &&
    index.partialFilterExpression === undefined &&
    index.expireAfterSeconds === undefined &&
    index.sparse !== true &&
    index.hidden !== true &&
    index.collation === undefined
  )
}

interface IndexInspection {
  definition: HirePhase4IndexDefinition
  exact: boolean
  sameKeyIndexes: HirePhase4IndexDescription[]
}

type IndexesByTarget = Record<IndexTarget, HirePhase4IndexDescription[]>

function inspectIndexes(indexesByTarget: IndexesByTarget): IndexInspection[] {
  return HIRE_PHASE4_INDEX_DEFINITIONS.map((definition) => {
    const sameKeyIndexes = indexesByTarget[definition.target].filter((index) => sameKey(index.key, definition.key))
    return {
      definition,
      sameKeyIndexes,
      exact: sameKeyIndexes.length === 1 && isExactHirePhase4Index(sameKeyIndexes[0], definition),
    }
  })
}

function missingIndexes(inspection: IndexInspection[]): IndexInspection[] {
  return inspection.filter(({ exact, sameKeyIndexes }) => !exact && sameKeyIndexes.length === 0)
}

function incompatibleIndexes(inspection: IndexInspection[]): IndexInspection[] {
  return inspection.filter(({ exact, sameKeyIndexes }) => !exact && sameKeyIndexes.length > 0)
}

function describeIndex(index: HirePhase4IndexDescription): string {
  return `${index.name ?? '<unnamed>'} ${JSON.stringify(index.key ?? {})}`
}

function assertNoIncompatibleIndexes(inspection: IndexInspection[]): void {
  const incompatible = incompatibleIndexes(inspection)
  if (incompatible.length) {
    throw new Error(
      `incompatible same-key Phase 4 index(es): ${incompatible.map(({ definition, sameKeyIndexes }) => (
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
      `missing exact Phase 4 Hire-control index(es): ${missing.map(({ definition }) => (
        `${definition.target}.${definition.name}`
      )).join(', ')}`,
    )
  }
}

function formatDefinitions(): void {
  console.log('\nHire Phase 4 decision-control index preparation')
  console.log('───────────────────────────────────────────────')
  for (const definition of HIRE_PHASE4_INDEX_DEFINITIONS) {
    console.log(
      `${definition.target}.${definition.name}: ${JSON.stringify(definition.key)}${definition.unique ? ' UNIQUE' : ''} — ${definition.purpose}`,
    )
  }
}

function printUsage(): void {
  console.log(`
Usage:
  npm run prepare:hire-phase4-indexes
  npm run check:hire-phase4-indexes
  npm run prepare:hire-phase4-indexes -- --apply

Modes:
  (default)  print the exact Phase 4 Hire-control index plan; no database connection
  --check    connect read-only and require every exact index
  --apply    create only missing exact indexes after all preconditions pass

Safety:
  --apply never invokes dropIndex, syncIndexes, or a TTL index. It stops before
  any write when a same-key index is incompatible or duplicate request
  coordinates would violate the unique idempotency invariant.
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
    'share-packets': HireSharePacket.collection as unknown as IndexCollection,
    'external-verdicts': HireExternalVerdict.collection as unknown as IndexCollection,
    'assessment-exports': HireAssessmentExport.collection as unknown as IndexCollection,
    'assessment-export-cleanups': HireAssessmentExportCleanup.collection as unknown as IndexCollection,
  }
}

async function readIndexes(
  collections: Record<IndexTarget, IndexCollection>,
): Promise<IndexesByTarget> {
  const targets: readonly IndexTarget[] = [
    'share-packets',
    'external-verdicts',
    'assessment-exports',
    'assessment-export-cleanups',
  ]
  const result = {} as IndexesByTarget
  await Promise.all(targets.map(async (target) => {
    try {
      result[target] = await collections[target].indexes()
    } catch (error) {
      // First rollout may not have materialized a collection. It is simply
      // missing all of its indexes until --apply creates the first one.
      if (!isNamespaceNotFoundError(error)) throw error
      result[target] = []
    }
  }))
  return result
}

function reportInspection(inspection: IndexInspection[]): void {
  console.log('\nInspection')
  for (const entry of inspection) {
    if (entry.exact) console.log(`✓ ${entry.definition.target}.${entry.definition.name}`)
    else if (entry.sameKeyIndexes.length === 0) console.log(`○ ${entry.definition.target}.${entry.definition.name} is missing`)
    else console.log(
      `! ${entry.definition.target}.${entry.definition.name} has incompatible same-key index(es): ${entry.sameKeyIndexes.map(describeIndex).join('; ')}`,
    )
  }
}

interface UniqueIndexDuplicateCheck {
  target: IndexTarget
  label: string
  pipeline: unknown[]
}

const UNIQUE_INDEX_DUPLICATE_CHECKS: readonly UniqueIndexDuplicateCheck[] = [
  {
    target: 'share-packets',
    label: 'workspace/creation operation share-packet rows',
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
    target: 'external-verdicts',
    label: 'workspace/packet external-verdict rows',
    pipeline: [
      {
        $group: {
          _id: { workspaceId: '$workspaceId', packetId: '$packetId' },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 1 },
    ],
  },
  {
    target: 'assessment-exports',
    label: 'workspace/creation operation assessment-export rows',
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
    target: 'assessment-export-cleanups',
    label: 'workspace/export assessment-export cleanup tombstones',
    pipeline: [
      {
        $group: {
          _id: { workspaceId: '$workspaceId', exportId: '$exportId' },
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
    try {
      const duplicates = await collections[check.target].aggregate<{ _id: unknown; count: number }>(check.pipeline).toArray()
      if (duplicates.length) {
        throw new Error(`duplicate ${check.label} block the Phase 4 unique index; no index was changed`)
      }
    } catch (error) {
      if (isNamespaceNotFoundError(error)) continue
      throw error
    }
  }
}

function createOptions(definition: HirePhase4IndexDefinition): { name: string; unique?: boolean } {
  return { name: definition.name, ...(definition.unique ? { unique: true } : {}) }
}

export async function prepareHirePhase4Indexes(argv: string[]): Promise<void> {
  const mode = hirePhase4IndexPreparationModeOf(argv)
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
  // is the exact createIndex call below, after a complete preflight.
  const connection = await connectDB({ schemaInitialization: 'disabled' })
  assertHireControlDatabaseBoundary(connection)
  const collections = collectionsByTarget()
  const before = inspectIndexes(await readIndexes(collections))
  reportInspection(before)

  if (mode === 'check') {
    assertEveryIndexExact(before)
    console.log(`\nCHECK PASSED — all ${HIRE_PHASE4_INDEX_DEFINITIONS.length} exact Phase 4 Hire-control indexes exist.`)
    return
  }

  assertNoIncompatibleIndexes(before)
  await assertNoUniqueIndexDuplicates(collections)
  for (const { definition } of missingIndexes(before)) {
    const indexName = await collections[definition.target].createIndex(definition.key, createOptions(definition))
    console.log(`Prepared ${definition.target}.${indexName}`)
  }
  const after = inspectIndexes(await readIndexes(collections))
  assertEveryIndexExact(after)
  console.log(`\nAPPLY PASSED — all ${HIRE_PHASE4_INDEX_DEFINITIONS.length} exact indexes exist; no index was removed.`)
}

async function main(): Promise<void> {
  await prepareHirePhase4Indexes(process.argv.slice(2))
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Hire Phase 4 index preparation failed:', error)
      process.exit(1)
    })
}
