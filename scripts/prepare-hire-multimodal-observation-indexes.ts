#!/usr/bin/env tsx
/**
 * Explicit, non-dropping Hire-native multimodal index preparation.
 *
 *   npm run prepare:hire-multimodal-observation-indexes
 *   npm run check:hire-multimodal-observation-indexes
 *   npm run prepare:hire-multimodal-observation-indexes -- --apply
 *
 * Run --check/--apply once on each isolated Hire surface. The control-plane
 * deployment owns the recruiter-only derived reports and their idempotency
 * ledgers; the runtime deployment owns its separate publish outboxes. This
 * script never connects in plan mode and never calls syncIndexes/dropIndex.
 */

import { pathToFileURL } from 'node:url'
import mongoose from 'mongoose'
import { connectDB } from '../shared/db/connection'
import {
  HireMultimodalAnalysis,
  HireMultimodalAnalysisIngestionEvent,
  HireMultimodalObservation,
  HireMultimodalObservationIngestionEvent,
  HireMultimodalObservationPurgeObligation,
} from '../modules/hire-multimodal/models'
import { HireRuntimeBinding } from '../modules/hire-runtime/models/HireRuntimeBinding'
import { HireRuntimeMultimodalAnalysisOutbox } from '../modules/hire-runtime/models/HireRuntimeMultimodalAnalysisOutbox'
import { HireRuntimeMultimodalObservationOutbox } from '../modules/hire-runtime/models/HireRuntimeMultimodalObservationOutbox'
import { HireRuntimeMultimodalObservationRetentionTombstone } from '../modules/hire-runtime/models/HireRuntimeMultimodalObservationRetentionTombstone'

export type HireMultimodalObservationIndexPreparationMode =
  | 'plan'
  | 'check'
  | 'apply'
  | 'help'

type IndexDirection = 1 | -1
type IndexKey = Readonly<Record<string, IndexDirection>>
type IndexTarget =
  | 'control-analyses'
  | 'control-analysis-ingestion-events'
  | 'control-observations'
  | 'control-ingestion-events'
  | 'control-runtime-purge-obligations'
  | 'runtime-analysis-outbox'
  | 'runtime-bindings'
  | 'runtime-outbox'
  | 'runtime-retention-tombstones'

export interface HireMultimodalObservationIndexDescription {
  name?: string
  key?: Record<string, unknown>
  unique?: boolean
  partialFilterExpression?: unknown
  expireAfterSeconds?: number
  sparse?: boolean
  hidden?: boolean
  collation?: unknown
}

export interface HireMultimodalObservationIndexDefinition {
  target: IndexTarget
  name: string
  key: IndexKey
  unique: boolean
  purpose: string
}

interface IndexCollection {
  createIndex(key: IndexKey, options: { name: string; unique?: boolean }): Promise<string>
  indexes(): Promise<HireMultimodalObservationIndexDescription[]>
  aggregate<T>(pipeline: unknown[]): { toArray(): Promise<T[]> }
}

/** These names exactly match the declared control and runtime schemas. */
export const HIRE_MULTIMODAL_OBSERVATION_INDEX_DEFINITIONS: readonly HireMultimodalObservationIndexDefinition[] = [
  {
    target: 'control-analyses',
    name: 'workspaceId_1_applicationId_1_roundId_1_runtimeSessionId_1_revision_1',
    key: { workspaceId: 1, applicationId: 1, roundId: 1, runtimeSessionId: 1, revision: 1 },
    unique: true,
    purpose: 'one immutable full-analysis revision per isolated runtime session',
  },
  {
    target: 'control-analyses',
    name: 'eventId_1',
    key: { eventId: 1 },
    unique: true,
    purpose: 'bridge-event idempotency on the recruiter-only full-analysis row',
  },
  {
    target: 'control-analyses',
    name: 'workspaceId_1_candidateId_1_capturedAt_-1',
    key: { workspaceId: 1, candidateId: 1, capturedAt: -1 },
    unique: false,
    purpose: 'candidate privacy/retention lookup and authorized recruiter read',
  },
  {
    target: 'control-analyses',
    name: 'workspaceId_1_jobId_1_purgeEligibleAt_1',
    key: { workspaceId: 1, jobId: 1, purgeEligibleAt: 1 },
    unique: false,
    purpose: 'closed-job six-calendar-month full-analysis retention schedule',
  },
  {
    target: 'control-analyses',
    name: 'workspaceId_1_status_1_retryAt_1_createdAt_1',
    key: { workspaceId: 1, status: 1, retryAt: 1, createdAt: 1 },
    unique: false,
    purpose: 'tenant-scoped full-analysis claim, retry, and recovery sweep',
  },
  {
    target: 'control-analysis-ingestion-events',
    name: 'eventId_1',
    key: { eventId: 1 },
    unique: true,
    purpose: 'full-analysis signed bridge retry idempotency ledger',
  },
  {
    target: 'control-analysis-ingestion-events',
    name: 'workspaceId_1_roundId_1_runtimeSessionId_1_revision_1',
    key: { workspaceId: 1, roundId: 1, runtimeSessionId: 1, revision: 1 },
    unique: true,
    purpose: 'one accepted full-analysis revision for each runtime coordinate',
  },
  {
    target: 'control-analysis-ingestion-events',
    name: 'workspaceId_1_candidateId_1',
    key: { workspaceId: 1, candidateId: 1 },
    unique: false,
    purpose: 'candidate privacy deletion lookup for the full-analysis ledger',
  },
  {
    target: 'control-observations',
    name: 'workspaceId_1_applicationId_1_roundId_1_runtimeSessionId_1_revision_1',
    key: { workspaceId: 1, applicationId: 1, roundId: 1, runtimeSessionId: 1, revision: 1 },
    unique: true,
    purpose: 'one immutable supplemental observation revision per isolated runtime session',
  },
  {
    target: 'control-observations',
    name: 'eventId_1',
    key: { eventId: 1 },
    unique: true,
    purpose: 'bridge-event idempotency on the recruiter-only report row',
  },
  {
    target: 'control-observations',
    name: 'workspaceId_1_candidateId_1_observedAt_-1',
    key: { workspaceId: 1, candidateId: 1, observedAt: -1 },
    unique: false,
    purpose: 'candidate privacy/retention lookup and future authorized recruiter read',
  },
  {
    target: 'control-observations',
    name: 'workspaceId_1_jobId_1_purgeEligibleAt_1',
    key: { workspaceId: 1, jobId: 1, purgeEligibleAt: 1 },
    unique: false,
    purpose: 'closed-job six-calendar-month observation retention schedule and purge sweep',
  },
  {
    target: 'control-ingestion-events',
    name: 'eventId_1',
    key: { eventId: 1 },
    unique: true,
    purpose: 'signed bridge retry idempotency ledger',
  },
  {
    target: 'control-ingestion-events',
    name: 'workspaceId_1_roundId_1_runtimeSessionId_1_revision_1',
    key: { workspaceId: 1, roundId: 1, runtimeSessionId: 1, revision: 1 },
    unique: true,
    purpose: 'one accepted observation revision for each runtime coordinate',
  },
  {
    target: 'control-ingestion-events',
    name: 'workspaceId_1_candidateId_1',
    key: { workspaceId: 1, candidateId: 1 },
    unique: false,
    purpose: 'candidate privacy deletion lookup for the idempotency ledger',
  },
  {
    target: 'control-runtime-purge-obligations',
    name: 'workspaceId_1_roundId_1',
    key: { workspaceId: 1, roundId: 1 },
    unique: true,
    purpose: 'one durable runtime-outbox retention barrier per round',
  },
  {
    target: 'control-runtime-purge-obligations',
    name: 'workspaceId_1_purgeEligibleAt_1_runtimePurgedAt_1',
    key: { workspaceId: 1, purgeEligibleAt: 1, runtimePurgedAt: 1 },
    unique: false,
    purpose: 'due runtime-first purge and acknowledged-control-cleanup sweep',
  },
  {
    target: 'control-runtime-purge-obligations',
    name: 'workspaceId_1_jobId_1_purgeEligibleAt_1',
    key: { workspaceId: 1, jobId: 1, purgeEligibleAt: 1 },
    unique: false,
    purpose: 'closed-job scheduling and reopen deadline rescission',
  },
  {
    target: 'control-runtime-purge-obligations',
    name: 'workspaceId_1_candidateId_1',
    key: { workspaceId: 1, candidateId: 1 },
    unique: false,
    purpose: 'candidate privacy and retention deletion lookup',
  },
  {
    target: 'runtime-analysis-outbox',
    name: 'workspaceId_1_roundId_1_runtimeSessionId_1_revision_1',
    key: { workspaceId: 1, roundId: 1, runtimeSessionId: 1, revision: 1 },
    unique: true,
    purpose: 'one durable runtime publish outbox row per full-analysis revision',
  },
  {
    target: 'runtime-analysis-outbox',
    name: 'workspaceId_1_status_1_publishRetryAt_1_updatedAt_1',
    key: { workspaceId: 1, status: 1, publishRetryAt: 1, updatedAt: 1 },
    unique: false,
    purpose: 'tenant-scoped full-analysis outbox claim, retry, and recovery sweep',
  },
  {
    target: 'runtime-bindings',
    name: 'workspaceId_1_status_1_purgePersonalData_1_publishedRevision_1_cameraMediaStatus_1_screenMediaStatus_1_publishRetryAt_1_publishCheckedAt_1_updatedAt_1',
    key: {
      workspaceId: 1,
      status: 1,
      purgePersonalData: 1,
      publishedRevision: 1,
      cameraMediaStatus: 1,
      screenMediaStatus: 1,
      publishRetryAt: 1,
      publishCheckedAt: 1,
      updatedAt: 1,
    },
    unique: false,
    purpose: 'runtime late camera/display publish recovery sweep',
  },
  {
    target: 'runtime-outbox',
    name: 'workspaceId_1_roundId_1_runtimeSessionId_1_revision_1',
    key: { workspaceId: 1, roundId: 1, runtimeSessionId: 1, revision: 1 },
    unique: true,
    purpose: 'one durable runtime publish outbox row per observation revision',
  },
  {
    target: 'runtime-outbox',
    name: 'workspaceId_1_status_1_publishRetryAt_1_updatedAt_1',
    key: { workspaceId: 1, status: 1, publishRetryAt: 1, updatedAt: 1 },
    unique: false,
    purpose: 'tenant-scoped outbox claim, retry, and recovery sweep',
  },
  {
    target: 'runtime-retention-tombstones',
    name: 'workspaceId_1_applicationId_1_roundId_1',
    key: { workspaceId: 1, applicationId: 1, roundId: 1 },
    unique: true,
    purpose: 'durable per-round deadline fence before runtime outbox deletion',
  },
]

const CONTROL_TARGETS: readonly IndexTarget[] = [
  'control-analyses',
  'control-analysis-ingestion-events',
  'control-observations',
  'control-ingestion-events',
  'control-runtime-purge-obligations',
]
const RUNTIME_TARGETS: readonly IndexTarget[] = [
  'runtime-analysis-outbox',
  'runtime-bindings',
  'runtime-outbox',
  'runtime-retention-tombstones',
]

function isNamespaceNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { code?: unknown }).code === 26 ||
      (error as { codeName?: unknown }).codeName === 'NamespaceNotFound')
  )
}

export function hireMultimodalObservationIndexPreparationModeOf(
  argv: string[],
): HireMultimodalObservationIndexPreparationMode {
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

export function isExactHireMultimodalObservationIndex(
  index: HireMultimodalObservationIndexDescription,
  definition: HireMultimodalObservationIndexDefinition,
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
  definition: HireMultimodalObservationIndexDefinition
  exact: boolean
  sameKeyIndexes: HireMultimodalObservationIndexDescription[]
}

type IndexesByTarget = Record<IndexTarget, HireMultimodalObservationIndexDescription[]>

function activeTargets(): readonly IndexTarget[] {
  if (process.env.IPG_SURFACE === 'hire-control') return CONTROL_TARGETS
  if (process.env.IPG_SURFACE === 'hire-engine') return RUNTIME_TARGETS
  throw new Error('IPG_SURFACE must be hire-control or hire-engine')
}

function definitionsFor(targets: readonly IndexTarget[]) {
  return HIRE_MULTIMODAL_OBSERVATION_INDEX_DEFINITIONS.filter((definition) =>
    targets.includes(definition.target),
  )
}

function collectionsByTarget(): Record<IndexTarget, IndexCollection> {
  return {
    'control-analyses': HireMultimodalAnalysis.collection as unknown as IndexCollection,
    'control-analysis-ingestion-events':
      HireMultimodalAnalysisIngestionEvent.collection as unknown as IndexCollection,
    'control-observations': HireMultimodalObservation.collection as unknown as IndexCollection,
    'control-ingestion-events':
      HireMultimodalObservationIngestionEvent.collection as unknown as IndexCollection,
    'control-runtime-purge-obligations':
      HireMultimodalObservationPurgeObligation.collection as unknown as IndexCollection,
    'runtime-analysis-outbox':
      HireRuntimeMultimodalAnalysisOutbox.collection as unknown as IndexCollection,
    'runtime-bindings': HireRuntimeBinding.collection as unknown as IndexCollection,
    'runtime-outbox':
      HireRuntimeMultimodalObservationOutbox.collection as unknown as IndexCollection,
    'runtime-retention-tombstones':
      HireRuntimeMultimodalObservationRetentionTombstone.collection as unknown as IndexCollection,
  }
}

function assertExpectedSurfaceDatabase(): void {
  const expected = process.env.IPG_SURFACE === 'hire-control'
    ? process.env.HIRE_CONTROL_DATABASE_NAME?.trim()
    : process.env.HIRE_RUNTIME_DATABASE_NAME?.trim()
  if (!expected || mongoose.connection.name !== expected) {
    throw new Error('connected database is not the configured isolated Hire surface database')
  }
}

async function readIndexes(
  collections: Record<IndexTarget, IndexCollection>,
  targets: readonly IndexTarget[],
): Promise<IndexesByTarget> {
  const result = {} as IndexesByTarget
  await Promise.all(
    targets.map(async (target) => {
      try {
        result[target] = await collections[target].indexes()
      } catch (error) {
        if (!isNamespaceNotFoundError(error)) throw error
        result[target] = []
      }
    }),
  )
  return result
}

function inspectIndexes(
  indexesByTarget: IndexesByTarget,
  definitions: readonly HireMultimodalObservationIndexDefinition[],
): IndexInspection[] {
  return definitions.map((definition) => {
    const sameKeyIndexes = (indexesByTarget[definition.target] ?? []).filter((index) =>
      sameKey(index.key, definition.key),
    )
    return {
      definition,
      sameKeyIndexes,
      exact:
        sameKeyIndexes.length === 1 &&
        isExactHireMultimodalObservationIndex(sameKeyIndexes[0], definition),
    }
  })
}

function describeIndex(index: HireMultimodalObservationIndexDescription): string {
  return `${index.name ?? '<unnamed>'} ${JSON.stringify(index.key ?? {})}`
}

function assertNoIncompatibleIndexes(inspection: IndexInspection[]): void {
  const incompatible = inspection.filter(
    ({ exact, sameKeyIndexes }) => !exact && sameKeyIndexes.length > 0,
  )
  if (!incompatible.length) return
  throw new Error(
    `incompatible same-key Hire multimodal-observation index(es): ${incompatible
      .map(
        ({ definition, sameKeyIndexes }) =>
          `${definition.target}.${definition.name} <- ${sameKeyIndexes
            .map(describeIndex)
            .join(', ')}`,
      )
      .join('; ')}. No index was changed; explicit operator repair is required.`,
  )
}

function missingIndexes(inspection: IndexInspection[]): IndexInspection[] {
  return inspection.filter(
    ({ exact, sameKeyIndexes }) => !exact && sameKeyIndexes.length === 0,
  )
}

function assertEveryIndexExact(inspection: IndexInspection[]): void {
  assertNoIncompatibleIndexes(inspection)
  const missing = missingIndexes(inspection)
  if (!missing.length) return
  throw new Error(
    `missing exact Hire multimodal-observation index(es): ${missing
      .map(({ definition }) => `${definition.target}.${definition.name}`)
      .join(', ')}`,
  )
}

function duplicatePipeline(
  definition: HireMultimodalObservationIndexDefinition,
): unknown[] {
  const groupId = Object.fromEntries(
    Object.keys(definition.key).map((field) => [field, `$${field}`]),
  )
  return [
    { $group: { _id: groupId, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 1 },
  ]
}

async function assertNoDuplicateUniqueRows(
  collections: Record<IndexTarget, IndexCollection>,
  definitions: readonly HireMultimodalObservationIndexDefinition[],
): Promise<void> {
  for (const definition of definitions.filter((entry) => entry.unique)) {
    const duplicates = await collections[definition.target]
      .aggregate<{ _id: unknown }>(duplicatePipeline(definition))
      .toArray()
    if (duplicates.length) {
      throw new Error(
        `duplicate rows block unique Hire multimodal-observation index ${definition.target}.${definition.name}`,
      )
    }
  }
}

function formatDefinitions(): void {
  console.log('\nHire-native multimodal index preparation')
  console.log('─────────────────────────────────────────────')
  for (const definition of HIRE_MULTIMODAL_OBSERVATION_INDEX_DEFINITIONS) {
    console.log(
      `${definition.target}.${definition.name}: ${JSON.stringify(definition.key)}${definition.unique ? ' UNIQUE' : ''} — ${definition.purpose}`,
    )
  }
}

function printUsage(): void {
  console.log(`
Usage:
  npm run prepare:hire-multimodal-observation-indexes
  npm run check:hire-multimodal-observation-indexes
  npm run prepare:hire-multimodal-observation-indexes -- --apply

Modes:
  (default)  print every control/runtime index definition; no database connection
  --check    connect only to the current Hire surface and require its exact indexes
  --apply    create only missing exact indexes on the current Hire surface

Run --check/--apply on both the Hire-control and Hire-runtime deployments.
Safety: --apply never invokes dropIndex, syncIndexes, or a bulk index mutation.
`)
}

function reportInspection(inspection: IndexInspection[]): void {
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

export async function prepareHireMultimodalObservationIndexes(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const mode = hireMultimodalObservationIndexPreparationModeOf(argv)
  if (mode === 'help') {
    printUsage()
    return
  }
  if (mode === 'plan') {
    formatDefinitions()
    return
  }

  const targets = activeTargets()
  const definitions = definitionsFor(targets)
  await connectDB({ schemaInitialization: 'disabled' })
  assertExpectedSurfaceDatabase()
  const collections = collectionsByTarget()
  const initial = inspectIndexes(await readIndexes(collections, targets), definitions)
  if (mode === 'check') {
    reportInspection(initial)
    assertEveryIndexExact(initial)
    return
  }

  assertNoIncompatibleIndexes(initial)
  await assertNoDuplicateUniqueRows(collections, missingIndexes(initial).map(({ definition }) => definition))
  for (const { definition } of missingIndexes(initial)) {
    await collections[definition.target].createIndex(definition.key, {
      name: definition.name,
      ...(definition.unique ? { unique: true } : {}),
    })
  }
  const verified = inspectIndexes(await readIndexes(collections, targets), definitions)
  reportInspection(verified)
  assertEveryIndexExact(verified)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareHireMultimodalObservationIndexes().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
