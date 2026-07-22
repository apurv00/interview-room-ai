#!/usr/bin/env tsx
/**
 * Fail-safe migration for Jobs evidence provenance.
 *
 * Historical evidence cannot be assigned an evaluator after the fact: the old
 * writer stored only a model name resolved at attribution time. Apply therefore
 * removes legacy readiness snapshots first, then explicitly quarantines those
 * rows without inventing scorer/attribution facts.
 *
 *   npm run repair:jobs-evidence-provenance
 *   npm run repair:jobs-evidence-provenance -- --apply
 *   npm run check:jobs-evidence-provenance
 */

import { pathToFileURL } from 'node:url'
import { connectDB } from '../shared/db/connection'
import { JobApplication, JobPracticeEvidence } from '../shared/db/models'
import {
  isModelExecutionProvenance,
  type ModelExecutionProvenance,
} from '../shared/services/scoringProvenance'
import { currentEvidenceProvenance } from '../modules/jobs/services/evidenceProvenance'
import type { CurrentReadinessProvenance } from '../modules/jobs/config/readiness'

const BATCH_SIZE = 500
const HEX_64 = /^[a-f0-9]{64}$/

export type EvidenceProvenanceRepairMode = 'dry-run' | 'apply' | 'check'

export interface EvidenceProvenanceCounts {
  legacyEvidence: number
  malformedEvidence: number
  quarantinedEvidence: number
  attestedEvidence: number
  currentReadiness: number
  legacyReadiness: number
  staleReadiness: number
  malformedReadiness: number
  invalidReadinessRevision: number
}

export function evidenceProvenanceRepairModeOf(argv: string[]): EvidenceProvenanceRepairMode {
  const supported = new Set(['--apply', '--check'])
  const unknown = argv.filter((argument) => !supported.has(argument))
  if (unknown.length) {
    throw new Error(`unknown argument${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`)
  }
  const apply = argv.includes('--apply')
  const check = argv.includes('--check')
  if (apply && check) throw new Error('choose either --apply or --check, not both')
  return apply ? 'apply' : check ? 'check' : 'dry-run'
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function validDate(value: unknown): boolean {
  if (value == null) return false
  const date = value instanceof Date ? value : new Date(String(value))
  return !Number.isNaN(date.getTime())
}

function knownScoringExecution(execution: ModelExecutionProvenance): boolean {
  return (
    execution.taskSlot === 'interview.evaluate-answer' &&
    execution.contractVersion === 'answer-evaluation.v1'
  ) || (
    execution.taskSlot === 'interview.evaluate-code' &&
    execution.contractVersion === 'code-evaluation.v1'
  ) || (
    execution.taskSlot === 'interview.evaluate-design' &&
    execution.contractVersion === 'design-evaluation.v1'
  )
}

function knownAttributionExecution(execution: ModelExecutionProvenance): boolean {
  return execution.taskSlot === 'jobs.evidence-attribution' &&
    execution.contractVersion === 'evidence-attribution.v1'
}

export type EvidenceProvenanceState = 'attested' | 'quarantined' | 'legacy' | 'malformed'

export function evidenceProvenanceStateOf(row: Record<string, unknown>): EvidenceProvenanceState {
  if (!Object.prototype.hasOwnProperty.call(row, 'provenance')) return 'legacy'
  const provenance = recordOf(row.provenance)
  if (!provenance || provenance.schemaVersion !== 1) return 'malformed'

  if (provenance.status === 'attested') {
    if (
      !isModelExecutionProvenance(provenance.scoring) ||
      !isModelExecutionProvenance(provenance.attribution) ||
      !knownScoringExecution(provenance.scoring) ||
      !knownAttributionExecution(provenance.attribution) ||
      row.scoringEpoch !== provenance.scoring.fingerprint ||
      provenance.quarantineReason != null ||
      provenance.quarantinedAt != null
    ) return 'malformed'
    return 'attested'
  }

  if (provenance.status === 'legacy-unverifiable') {
    if (
      provenance.quarantineReason !== 'pre-provenance-contract' ||
      !validDate(provenance.quarantinedAt) ||
      provenance.scoring != null ||
      provenance.attribution != null
    ) return 'malformed'
    return 'quarantined'
  }
  return 'malformed'
}

function uniqueExecutions(
  value: unknown,
  kind: 'scoring' | 'attribution',
): ModelExecutionProvenance[] | null {
  if (!Array.isArray(value)) return null
  const fingerprints = new Set<string>()
  const executions: ModelExecutionProvenance[] = []
  for (const item of value) {
    if (!isModelExecutionProvenance(item) || item.usedFallback) return null
    if (kind === 'scoring' ? !knownScoringExecution(item) : !knownAttributionExecution(item)) return null
    if (fingerprints.has(item.fingerprint)) return null
    fingerprints.add(item.fingerprint)
    executions.push(item)
  }
  return executions
}

function sameExecution(left: ModelExecutionProvenance, right: ModelExecutionProvenance): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.taskSlot === right.taskSlot &&
    left.contractVersion === right.contractVersion &&
    left.model === right.model &&
    left.provider === right.provider &&
    left.usedFallback === right.usedFallback &&
    left.attemptKind === right.attemptKind &&
    left.configDigest === right.configDigest &&
    left.fingerprint === right.fingerprint
}

export type ReadinessProvenanceState = 'current' | 'legacy' | 'stale' | 'malformed'

export function readinessProvenanceStateOf(
  readiness: unknown,
  current: CurrentReadinessProvenance,
): ReadinessProvenanceState {
  const snapshot = recordOf(readiness)
  if (!snapshot) return 'malformed'
  if (!Object.prototype.hasOwnProperty.call(snapshot, 'provenance')) return 'legacy'
  const provenance = recordOf(snapshot.provenance)
  if (!provenance || provenance.schemaVersion !== 1) return 'malformed'
  const scoring = uniqueExecutions(provenance.scoring, 'scoring')
  const attribution = uniqueExecutions(provenance.attribution, 'attribution')
  if (!scoring || !attribution) return 'malformed'
  const hasClaims = snapshot.band !== 'none' || Number(snapshot.practicedCount) > 0 || Number(snapshot.sessions) > 0
  if (hasClaims && (!scoring.length || !attribution.length)) return 'malformed'
  if (
    snapshot.handoffVersion !== 1 ||
    typeof snapshot.scoringEpoch !== 'string' || !HEX_64.test(snapshot.scoringEpoch) ||
    !['none', 'building', 'practiced', 'strong-evidence'].includes(String(snapshot.band))
  ) return 'malformed'

  const currentScoring = new Map(current.scoring.map((execution) => [execution.fingerprint, execution]))
  const currentAttribution = new Map(current.attribution.map((execution) => [execution.fingerprint, execution]))
  if (
    snapshot.scoringEpoch !== current.epoch ||
    scoring.some((execution) => {
      const allowed = currentScoring.get(execution.fingerprint)
      return !allowed || !sameExecution(execution, allowed)
    }) ||
    attribution.some((execution) => {
      const allowed = currentAttribution.get(execution.fingerprint)
      return !allowed || !sameExecution(execution, allowed)
    })
  ) {
    return 'stale'
  }
  return 'current'
}

export function readinessHasValidProvenance(
  readiness: unknown,
  current: CurrentReadinessProvenance,
): boolean {
  return readinessProvenanceStateOf(readiness, current) === 'current'
}

function hasSafeReadinessRevision(row: Record<string, unknown>): boolean {
  if (!Object.prototype.hasOwnProperty.call(row, 'readinessRevision')) return true
  const revision = row.readinessRevision
  return typeof revision === 'number' &&
    Number.isSafeInteger(revision) &&
    revision >= 0 &&
    revision < Number.MAX_SAFE_INTEGER
}

export function assertEvidenceProvenanceInvariant(counts: EvidenceProvenanceCounts): void {
  if (
    counts.legacyEvidence ||
    counts.malformedEvidence ||
    counts.legacyReadiness ||
    counts.staleReadiness ||
    counts.malformedReadiness ||
    counts.invalidReadinessRevision
  ) {
    throw new Error(
      'evidence provenance invariant failed: ' +
      `legacy evidence=${counts.legacyEvidence}, malformed evidence=${counts.malformedEvidence}, ` +
      `legacy readiness=${counts.legacyReadiness}, stale readiness=${counts.staleReadiness}, ` +
      `malformed readiness=${counts.malformedReadiness}, unsafe revisions=${counts.invalidReadinessRevision}`,
    )
  }
}

type LeanRow = { _id: unknown } & Record<string, unknown>
interface LeanScanQuery {
  select(projection: string): LeanScanQuery
  sort(sort: Record<string, 1 | -1>): LeanScanQuery
  limit(limit: number): LeanScanQuery
  lean(): Promise<LeanRow[]>
}
interface ScanModel {
  find(filter: Record<string, unknown>): LeanScanQuery
}

async function scanRowBatches(
  model: typeof JobPracticeEvidence | typeof JobApplication,
  filter: Record<string, unknown>,
  projection: string,
  visit: (rows: LeanRow[]) => void | Promise<void>,
): Promise<void> {
  let afterId: unknown
  for (;;) {
    const rows = await (model as unknown as ScanModel).find({
      ...filter,
      ...(afterId ? { _id: { $gt: afterId } } : {}),
    })
      .select(projection)
      .sort({ _id: 1 })
      .limit(BATCH_SIZE)
      .lean()
    await visit(rows)
    if (rows.length < BATCH_SIZE) return
    afterId = rows[rows.length - 1]._id
  }
}

async function inspectPhysicalState(current: CurrentReadinessProvenance): Promise<EvidenceProvenanceCounts> {
  const counts: EvidenceProvenanceCounts = {
    legacyEvidence: 0,
    malformedEvidence: 0,
    quarantinedEvidence: 0,
    attestedEvidence: 0,
    currentReadiness: 0,
    legacyReadiness: 0,
    staleReadiness: 0,
    malformedReadiness: 0,
    invalidReadinessRevision: 0,
  }
  await scanRowBatches(
    JobPracticeEvidence,
    {},
    'scoringEpoch provenance',
    (rows) => {
      for (const row of rows) {
        const state = evidenceProvenanceStateOf(row)
        if (state === 'legacy') counts.legacyEvidence += 1
        else if (state === 'malformed') counts.malformedEvidence += 1
        else if (state === 'quarantined') counts.quarantinedEvidence += 1
        else counts.attestedEvidence += 1
      }
    },
  )
  await scanRowBatches(
    JobApplication,
    { readiness: { $exists: true } },
    'readiness readinessRevision',
    (rows) => {
      for (const row of rows) {
        const state = readinessProvenanceStateOf(row.readiness, current)
        if (state === 'current') counts.currentReadiness += 1
        else if (state === 'legacy') counts.legacyReadiness += 1
        else if (state === 'stale') counts.staleReadiness += 1
        else counts.malformedReadiness += 1
        if (!hasSafeReadinessRevision(row)) counts.invalidReadinessRevision += 1
      }
    },
  )
  return counts
}

export function readinessRemovalUpdate(): Record<string, unknown> {
  return {
    $unset: { readiness: 1 },
    $inc: { readinessRevision: 1 },
  }
}

async function removeInvalidReadiness(current: CurrentReadinessProvenance): Promise<number> {
  let modified = 0
  await scanRowBatches(
    JobApplication,
    { readiness: { $exists: true } },
    'readiness readinessRevision',
    async (rows) => {
      const operations = rows.flatMap((row) => {
        const state = readinessProvenanceStateOf(row.readiness, current)
        if (state !== 'legacy' && state !== 'stale') return []
        const hasRevision = Object.prototype.hasOwnProperty.call(row, 'readinessRevision')
        return [{
          updateOne: {
            filter: {
              _id: row._id,
              readiness: { $exists: true },
              ...(hasRevision
                ? { readinessRevision: row.readinessRevision }
                : { readinessRevision: { $exists: false } }),
            },
            update: readinessRemovalUpdate(),
          },
        }]
      })
      if (!operations.length) return
      const result = await JobApplication.bulkWrite(operations as never, { ordered: false })
      modified += result.modifiedCount ?? 0
    },
  )
  return modified
}

async function quarantineLegacyEvidence(quarantineAt: Date): Promise<number> {
  let modified = 0
  await scanRowBatches(
    JobPracticeEvidence,
    { provenance: { $exists: false } },
    'scoringEpoch provenance',
    async (rows) => {
      const ids = rows
        .filter((row) => evidenceProvenanceStateOf(row) === 'legacy')
        .map((row) => row._id)
      if (!ids.length) return
      const result = await JobPracticeEvidence.updateMany(
        ({ _id: { $in: ids }, provenance: { $exists: false } }) as never,
        {
          $set: {
            provenance: {
              schemaVersion: 1,
              status: 'legacy-unverifiable',
              quarantineReason: 'pre-provenance-contract',
              quarantinedAt: quarantineAt,
            },
          },
        },
      )
      modified += result.modifiedCount ?? 0
    },
  )
  return modified
}

export async function runEvidenceProvenanceRepair(argv: string[]): Promise<void> {
  const mode = evidenceProvenanceRepairModeOf(argv)
  await connectDB({ schemaInitialization: 'disabled' })
  const current = await currentEvidenceProvenance()
  const before = await inspectPhysicalState(current)

  console.log('\nJobs evidence provenance repair')
  console.log('───────────────────────────────')
  console.log(`Attested evidence rows: ${before.attestedEvidence}`)
  console.log(`Already quarantined rows: ${before.quarantinedEvidence}`)
  console.log(`Legacy rows without provenance: ${before.legacyEvidence}`)
  console.log(`Malformed/unknown declared provenance: ${before.malformedEvidence}`)
  console.log(`Current provenance-bound readiness snapshots: ${before.currentReadiness}`)
  console.log(`Legacy readiness snapshots: ${before.legacyReadiness}`)
  console.log(`Stale readiness snapshots: ${before.staleReadiness}`)
  console.log(`Malformed/future readiness snapshots: ${before.malformedReadiness}`)
  console.log(`Unsafe readiness revisions: ${before.invalidReadinessRevision}`)

  if (mode === 'check') {
    assertEvidenceProvenanceInvariant(before)
    console.log('\nCHECK PASSED — every row is attested or explicitly quarantined; snapshots are provenance-bound.')
    return
  }
  if (mode === 'dry-run') {
    console.log('\nDRY RUN — no writes performed. Re-run with --apply after old workers are drained.')
    return
  }
  if (before.malformedEvidence || before.malformedReadiness || before.invalidReadinessRevision) {
    throw new Error('apply refused: malformed/future provenance or unsafe readiness revision requires investigation')
  }

  // Safe direction first: no legacy aggregate may survive while rows are
  // being classified. Incrementing the revision invalidates concurrent
  // publishers that read the pre-repair evidence set.
  const removedSnapshots = await removeInvalidReadiness(current)

  const quarantineAt = new Date()
  const quarantinedRows = await quarantineLegacyEvidence(quarantineAt)
  console.log(`\nReadiness snapshots removed: ${removedSnapshots}`)
  console.log(`Legacy evidence rows quarantined: ${quarantinedRows}`)

  const after = await inspectPhysicalState(current)
  assertEvidenceProvenanceInvariant(after)
  console.log('Verified: all evidence is attested or explicitly quarantined; no legacy snapshot survives.')
}

async function main() {
  await runEvidenceProvenanceRepair(process.argv.slice(2))
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Jobs evidence provenance repair failed:', error)
      process.exit(1)
    })
}
