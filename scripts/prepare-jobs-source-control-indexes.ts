#!/usr/bin/env tsx
/**
 * Explicit, non-dropping A02 index preparation.
 *
 * Mongoose schema initialization is disabled so this command can only create
 * the five indexes listed below. It never calls syncIndexes/dropIndex and is
 * safe to re-run after a partial build.
 *
 * Dry-run by default:
 *   npm run prepare:jobs-source-control-indexes
 *   npm run prepare:jobs-source-control-indexes -- --apply
 */

import { pathToFileURL } from 'node:url'
import { connectDB } from '../shared/db/connection'
import { JOB_SOURCE_CONTROL_INDEX_NAMES } from '../modules/jobs/config/sourceControlLimits'
import {
  JobPosting,
  JobSourceConfig,
  JobSourceControlAudit,
} from '../shared/db/models'
import {
  hasSingleSafeNamedIndex,
  type SourceControlIndexDescription,
} from './jobs-source-control-index-policy'

export type SourceControlIndexPreparationMode = 'dry-run' | 'apply'

type IndexTarget = 'postings' | 'source-configs' | 'source-control-audits'

interface SourceControlIndexDefinition {
  target: IndexTarget
  name: string
  key: Record<string, 1>
  unique: boolean
  purpose: string
}

interface IndexCollection {
  createIndex(key: Record<string, 1>, options: { name: string; unique?: boolean }): Promise<string>
  indexes(): Promise<SourceControlIndexDescription[]>
}

export const JOBS_SOURCE_CONTROL_INDEX_DEFINITIONS: readonly SourceControlIndexDefinition[] = [
  {
    target: 'source-configs',
    name: JOB_SOURCE_CONTROL_INDEX_NAMES.sourceConfigSourceId,
    key: { sourceId: 1 },
    unique: true,
    purpose: 'one authority epoch per source',
  },
  {
    target: 'source-control-audits',
    name: JOB_SOURCE_CONTROL_INDEX_NAMES.auditOperationId,
    key: { operationId: 1 },
    unique: true,
    purpose: 'idempotent control commands',
  },
  {
    target: 'source-control-audits',
    name: JOB_SOURCE_CONTROL_INDEX_NAMES.auditSourceRevision,
    key: { sourceId: 1, revision: 1 },
    unique: true,
    purpose: 'one permanent audit row per authority revision',
  },
  {
    target: 'postings',
    name: JOB_SOURCE_CONTROL_INDEX_NAMES.postingSourceIds,
    key: { sourceIds: 1 },
    unique: false,
    purpose: 'durable legal-lineage lookup',
  },
  {
    target: 'postings',
    name: JOB_SOURCE_CONTROL_INDEX_NAMES.postingProvenanceSourceId,
    key: { 'provenance.sourceId': 1 },
    unique: false,
    purpose: 'legacy lineage repair and board lifecycle lookup',
  },
]

export function sourceControlIndexPreparationModeOf(
  argv: string[],
): SourceControlIndexPreparationMode {
  const unknownArguments = argv.filter((argument) => argument !== '--apply')
  if (unknownArguments.length) {
    throw new Error(
      `unknown argument${unknownArguments.length === 1 ? '' : 's'}: ${unknownArguments.join(', ')}`,
    )
  }
  return argv.includes('--apply') ? 'apply' : 'dry-run'
}

function collectionsByTarget(): Record<IndexTarget, IndexCollection> {
  return {
    postings: JobPosting.collection as unknown as IndexCollection,
    'source-configs': JobSourceConfig.collection as unknown as IndexCollection,
    'source-control-audits': JobSourceControlAudit.collection as unknown as IndexCollection,
  }
}

export async function prepareJobsSourceControlIndexes(argv: string[]): Promise<void> {
  const mode = sourceControlIndexPreparationModeOf(argv)

  console.log('\nJobs source-control index preparation')
  console.log('─────────────────────────────────────')
  for (const definition of JOBS_SOURCE_CONTROL_INDEX_DEFINITIONS) {
    console.log(
      `${definition.target}.${definition.name}: ${JSON.stringify(definition.key)}${definition.unique ? ' UNIQUE' : ''} — ${definition.purpose}`,
    )
  }

  if (mode === 'dry-run') {
    console.log('\nDRY RUN — no database connection or index write. Re-run with --apply.')
    return
  }

  // Explicitly suppress Mongoose auto-create/auto-index. The only schema
  // mutations below are the enumerated createIndex calls.
  await connectDB({ schemaInitialization: 'disabled' })
  const collections = collectionsByTarget()

  // Build serially to avoid competing index builds on the small Atlas staging
  // tier. createIndex is idempotent for an already-equivalent index and never
  // removes an unrelated index.
  for (const definition of JOBS_SOURCE_CONTROL_INDEX_DEFINITIONS) {
    const options = {
      name: definition.name,
      ...(definition.unique ? { unique: true } : {}),
    }
    const indexName = await collections[definition.target].createIndex(definition.key, options)
    console.log(`Prepared ${definition.target}.${indexName}`)
  }

  const indexesByTarget = new Map<IndexTarget, SourceControlIndexDescription[]>()
  for (const target of ['postings', 'source-configs', 'source-control-audits'] as const) {
    indexesByTarget.set(target, await collections[target].indexes())
  }

  for (const definition of JOBS_SOURCE_CONTROL_INDEX_DEFINITIONS) {
    const indexes = indexesByTarget.get(definition.target) ?? []
    if (!hasSingleSafeNamedIndex(
      indexes,
      Object.entries(definition.key),
      definition.unique,
      definition.name,
    )) {
      throw new Error(
        `index verification failed for ${definition.target}.${definition.name} ${JSON.stringify(definition.key)}; expected exactly one safe same-key index`,
      )
    }
  }
  const auditIndexes = indexesByTarget.get('source-control-audits') ?? []
  if (auditIndexes.some((index) => typeof index.expireAfterSeconds === 'number')) {
    throw new Error('source-control audit collection has a TTL index; permanent evidence is unsafe')
  }

  console.log('\nINDEX PREPARATION PASSED — all five exact indexes exist; audit history has no TTL.')
}

async function main(): Promise<void> {
  await prepareJobsSourceControlIndexes(process.argv.slice(2))
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Jobs source-control index preparation failed:', error)
      process.exit(1)
    })
}
