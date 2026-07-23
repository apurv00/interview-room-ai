#!/usr/bin/env tsx

import { pathToFileURL } from 'node:url'
import { connectDB } from '../shared/db/connection'
import { JobsVerdictConfigAudit } from '../shared/db/models'
import { JobQualityDecision } from '../shared/db/models/JobQualityDecision'

export type VerdictGovernanceIndexMode = 'dry-run' | 'apply' | 'check'

interface IndexDescription {
  name?: string
  key?: Record<string, unknown>
  unique?: boolean
  partialFilterExpression?: unknown
  expireAfterSeconds?: number
  sparse?: boolean
  hidden?: boolean
  collation?: unknown
}

interface IndexCollection {
  createIndex(
    key: Record<string, 1 | -1>,
    options: { name: string; unique?: boolean; partialFilterExpression?: Record<string, unknown> },
  ): Promise<string>
  indexes(): Promise<IndexDescription[]>
}

const definitions = [
  {
    target: 'decisions' as const,
    name: 'job_quality_decision_key_uq',
    key: { decisionKey: 1 } as const,
    unique: true,
    partialFilterExpression: { recordType: 'automatic' },
  },
  {
    target: 'decisions' as const,
    name: 'job_quality_review_operation_uq',
    key: { operationId: 1 } as const,
    unique: true,
    partialFilterExpression: { recordType: 'review' },
  },
  {
    target: 'decisions' as const,
    name: 'job_quality_review_queue',
    key: { recordType: 1, reviewStatus: 1, occurredAt: -1, _id: -1 } as const,
    unique: false,
  },
  {
    target: 'decisions' as const,
    name: 'job_quality_review_history',
    key: { rootDecisionId: 1, occurredAt: 1, _id: 1 } as const,
    unique: false,
  },
  {
    target: 'config-audits' as const,
    name: 'jobs_verdict_config_revision_uq',
    key: { revision: 1 } as const,
    unique: true,
  },
] as const

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

function exactIndex(index: IndexDescription, definition: (typeof definitions)[number]): boolean {
  return index.name === definition.name &&
    sameJson(index.key, definition.key) &&
    Boolean(index.unique) === definition.unique &&
    sameJson(index.partialFilterExpression, 'partialFilterExpression' in definition ? definition.partialFilterExpression : undefined) &&
    index.expireAfterSeconds === undefined &&
    index.sparse !== true &&
    index.hidden !== true &&
    index.collation === undefined
}

export function verdictGovernanceIndexModeOf(argv: string[]): VerdictGovernanceIndexMode {
  const unknown = argv.filter((argument) => argument !== '--apply' && argument !== '--check')
  if (unknown.length) throw new Error(`unknown argument${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`)
  if (argv.includes('--apply') && argv.includes('--check')) throw new Error('--apply and --check are mutually exclusive')
  return argv.includes('--apply') ? 'apply' : argv.includes('--check') ? 'check' : 'dry-run'
}

export async function prepareJobsVerdictGovernanceIndexes(argv: string[]): Promise<void> {
  const mode = verdictGovernanceIndexModeOf(argv)
  if (mode === 'dry-run') {
    console.log('DRY RUN — five permanent verdict-governance indexes; re-run with --apply or --check.')
    return
  }

  await connectDB({ schemaInitialization: 'disabled' })
  const collections: Record<(typeof definitions)[number]['target'], IndexCollection> = {
    decisions: JobQualityDecision.collection as unknown as IndexCollection,
    'config-audits': JobsVerdictConfigAudit.collection as unknown as IndexCollection,
  }
  if (mode === 'apply') {
    for (const definition of definitions) {
      await collections[definition.target].createIndex(definition.key, {
        name: definition.name,
        ...(definition.unique ? { unique: true } : {}),
        ...('partialFilterExpression' in definition
          ? { partialFilterExpression: definition.partialFilterExpression }
          : {}),
      })
    }
  }

  const indexes = {
    decisions: await collections.decisions.indexes(),
    'config-audits': await collections['config-audits'].indexes(),
  }
  for (const definition of definitions) {
    const sameKey = indexes[definition.target].filter((index) => sameJson(index.key, definition.key))
    if (sameKey.length !== 1 || !exactIndex(sameKey[0], definition)) {
      throw new Error(`index verification failed for ${definition.target}.${definition.name}`)
    }
  }
  for (const [target, targetIndexes] of Object.entries(indexes)) {
    if (targetIndexes.some((index) => typeof index.expireAfterSeconds === 'number')) {
      throw new Error(`${target} has a TTL index; permanent verdict evidence is unsafe`)
    }
  }
  console.log(`VERDICT GOVERNANCE INDEX ${mode === 'apply' ? 'PREPARATION' : 'CHECK'} PASSED`)
}

async function main(): Promise<void> {
  await prepareJobsVerdictGovernanceIndexes(process.argv.slice(2))
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main().then(() => process.exit(0)).catch((error) => {
    console.error('Jobs verdict-governance index preparation failed:', error)
    process.exit(1)
  })
}
