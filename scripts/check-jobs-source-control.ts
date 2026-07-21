/**
 * Read-only A02 deploy gate.
 *
 * Verifies the target Mongo topology can support the transaction protocol,
 * the legal lookup index exists, every control summary has permanent audit
 * evidence, and no posting remains normally accessible for a revoked source.
 */
import 'dotenv/config'
import { pathToFileURL } from 'node:url'
import mongoose from 'mongoose'
import { connectDB } from '../shared/db/connection'
import {
  JOB_SOURCE_ID_PATTERN,
  JOB_SOURCE_LINEAGE_UNKNOWN,
  JobPosting,
  JobSourceConfig,
  JobSourceControlAudit,
  JobSourceControlMeta,
  JobSourceOperationAudit,
  JOB_SOURCE_CONTROL_META_ID,
} from '../shared/db/models'
import {
  JOB_SOURCE_CONTROL_INDEX_NAMES,
  JOB_SOURCE_CONTROL_MAX_POSTINGS,
  JOB_SOURCE_CONTROL_WARN_POSTINGS,
} from '../modules/jobs/config/sourceControlLimits'
import { hasSingleSafeNamedIndex } from './jobs-source-control-index-policy'

export function controlSequenceIsConsistent(
  meta: { controlWriteSeq?: number } | null,
  auditTotalCount: number,
): boolean {
  return meta?.controlWriteSeq === auditTotalCount
}

export function admissionStateIsConsistent(
  meta: { ingestWriteSeq?: number; retainedPostings?: number } | null,
  physicalRetainedPostings: number,
): boolean {
  return !!meta &&
    Number.isSafeInteger(meta.ingestWriteSeq) &&
    (meta.ingestWriteSeq as number) >= 0 &&
    (meta.ingestWriteSeq as number) < Number.MAX_SAFE_INTEGER &&
    Number.isSafeInteger(meta.retainedPostings) &&
    (meta.retainedPostings as number) >= 0 &&
    meta.retainedPostings === physicalRetainedPostings
}

interface AuditStateSnapshot {
  enabled: boolean
  health: 'active' | 'degraded' | 'quarantined' | 'dead' | 'revoked'
}

export interface AuditHistoryTransition {
  action: unknown
  previousRevision: unknown
  revision: unknown
  from: unknown
  to: unknown
}

export interface AuditHistoryValidation {
  valid: boolean
  invalidTransitions: number
}

const AUDIT_SOURCE_HEALTHS = new Set<AuditStateSnapshot['health']>([
  'active',
  'degraded',
  'quarantined',
  'dead',
  'revoked',
])

function isAuditStateSnapshot(value: unknown): value is AuditStateSnapshot {
  if (!value || typeof value !== 'object') return false
  const state = value as { enabled?: unknown; health?: unknown }
  return typeof state.enabled === 'boolean' &&
    typeof state.health === 'string' &&
    AUDIT_SOURCE_HEALTHS.has(state.health as AuditStateSnapshot['health'])
}

function sameAuditState(left: AuditStateSnapshot, right: AuditStateSnapshot): boolean {
  return left.enabled === right.enabled && left.health === right.health
}

function auditTransitionIsValid(
  transition: AuditHistoryTransition,
  expectedRevision: number,
  previous?: AuditHistoryTransition,
): boolean {
  const expectedAction = expectedRevision % 2 === 1 ? 'revoke' : 'restore'
  const from = transition.from
  const to = transition.to
  const fromIsValid = isAuditStateSnapshot(from)
  const toIsValid = isAuditStateSnapshot(to)
  let transitionIsValid =
    transition.revision === expectedRevision &&
    transition.previousRevision === expectedRevision - 1 &&
    transition.action === expectedAction &&
    fromIsValid &&
    toIsValid

  if (previous && previous.action === transition.action) transitionIsValid = false

  if (toIsValid) {
    const destinationIsValid = transition.action === 'revoke'
      ? to.enabled === false && to.health === 'revoked'
      : transition.action === 'restore' &&
        to.enabled === false &&
        to.health === 'quarantined'
    if (!destinationIsValid) transitionIsValid = false
  }

  if (transition.action === 'restore') {
    const restoreOriginIsValid = fromIsValid &&
      from.enabled === false &&
      from.health === 'revoked'
    const previousDestinationIsContinuous = !!previous &&
      isAuditStateSnapshot(previous.to) &&
      fromIsValid &&
      sameAuditState(previous.to, from)
    if (!restoreOriginIsValid || !previousDestinationIsContinuous) transitionIsValid = false
  } else if (transition.action === 'revoke' && previous?.action === 'restore') {
    // Restore authorizes later revalidation. Health/enabled may evolve before
    // the next revoke, but a second revoke cannot originate from `revoked`.
    if (!fromIsValid || from.health === 'revoked') transitionIsValid = false
  }

  return transitionIsValid
}

/**
 * Validates one source's permanent audit rows in ascending revision order.
 * A restored source may legitimately change health or be enabled before the
 * next revoke, so that boundary accepts any well-formed non-revoked state.
 */
export function validateAuditHistory(
  history: readonly AuditHistoryTransition[],
): AuditHistoryValidation {
  let invalidTransitions = 0

  for (let index = 0; index < history.length; index++) {
    if (!auditTransitionIsValid(history[index], index + 1, history[index - 1])) {
      invalidTransitions++
    }
  }

  return { valid: invalidTransitions === 0, invalidTransitions }
}

function canonicalSourceIdExpression(valueReference: string): Record<string, unknown> {
  return {
    $cond: [
      { $eq: [{ $type: valueReference }, 'string'] },
      { $regexMatch: { input: valueReference, regex: JOB_SOURCE_ID_PATTERN.source } },
      false,
    ],
  }
}

function safeArrayExpression(fieldReference: string): Record<string, unknown> {
  return { $cond: [{ $isArray: fieldReference }, fieldReference, []] }
}

function validCurrentSourceIdsExpression(): Record<string, unknown> {
  return {
    $filter: {
      input: safeArrayExpression('$sourceIds'),
      as: 'sourceId',
      cond: canonicalSourceIdExpression('$$sourceId'),
    },
  }
}

function validProvenanceSourceIdsExpression(): Record<string, unknown> {
  return {
    $map: {
      input: {
        $filter: {
          input: safeArrayExpression('$provenance'),
          as: 'entry',
          cond: canonicalSourceIdExpression('$$entry.sourceId'),
        },
      },
      as: 'entry',
      in: '$$entry.sourceId',
    },
  }
}

function hasInvalidProvenanceSourceIdExpression(): Record<string, unknown> {
  return {
    $or: [
      {
        $and: [
          { $ne: [{ $type: '$provenance' }, 'missing'] },
          { $eq: [{ $isArray: '$provenance' }, false] },
        ],
      },
      {
        $anyElementTrue: [{
          $map: {
            input: safeArrayExpression('$provenance'),
            as: 'entry',
            in: { $not: [canonicalSourceIdExpression('$$entry.sourceId')] },
          },
        }],
      },
    ],
  }
}

export function invalidSourceLineageFilter(): Record<string, unknown> {
  const safeSourceIds = safeArrayExpression('$sourceIds')
  return {
    $expr: {
      $not: [{
        $and: [
          { $isArray: '$sourceIds' },
          { $gt: [{ $size: safeSourceIds }, 0] },
          {
            $allElementsTrue: [{
              $map: {
                input: safeSourceIds,
                as: 'sourceId',
                in: canonicalSourceIdExpression('$$sourceId'),
              },
            }],
          },
        ],
      }],
    },
  }
}

async function main(): Promise<void> {
  await connectDB({ schemaInitialization: 'disabled' })
  const db = mongoose.connection.db
  if (!db) throw new Error('Mongo connection has no database handle')

  const hello = await db.admin().command({ hello: 1 }) as { setName?: string; msg?: string }
  const transactionCapable = Boolean(hello.setName) || hello.msg === 'isdbgrid'
  console.log(`Transaction-capable topology: ${transactionCapable ? 'yes' : 'NO'}`)

  let sourceIdsIndex = false
  let provenanceSourceIndex = false
  try {
    const indexes = await JobPosting.collection.indexes()
    sourceIdsIndex = hasSingleSafeNamedIndex(
      indexes,
      [['sourceIds', 1]],
      false,
      JOB_SOURCE_CONTROL_INDEX_NAMES.postingSourceIds,
    )
    provenanceSourceIndex = hasSingleSafeNamedIndex(
      indexes,
      [['provenance.sourceId', 1]],
      false,
      JOB_SOURCE_CONTROL_INDEX_NAMES.postingProvenanceSourceId,
    )
  } catch (error) {
    if ((error as { codeName?: string }).codeName !== 'NamespaceNotFound') throw error
  }
  console.log(`sourceIds legal-lineage index: ${sourceIdsIndex ? 'present' : 'MISSING'}`)
  console.log(`provenance.sourceId lifecycle index: ${provenanceSourceIndex ? 'present' : 'MISSING'}`)

  let auditOperationIndex = false
  let auditRevisionIndex = false
  let auditHasTtlIndex = false
  try {
    const auditIndexes = await JobSourceControlAudit.collection.indexes()
    auditOperationIndex = hasSingleSafeNamedIndex(
      auditIndexes,
      [['operationId', 1]],
      true,
      JOB_SOURCE_CONTROL_INDEX_NAMES.auditOperationId,
    )
    auditRevisionIndex = hasSingleSafeNamedIndex(
      auditIndexes,
      [['sourceId', 1], ['revision', 1]],
      true,
      JOB_SOURCE_CONTROL_INDEX_NAMES.auditSourceRevision,
    )
    auditHasTtlIndex = auditIndexes.some((index) => (
      typeof (index as { expireAfterSeconds?: unknown }).expireAfterSeconds === 'number'
    ))
  } catch (error) {
    if ((error as { codeName?: string }).codeName !== 'NamespaceNotFound') throw error
  }
  console.log(`Unique audit operation index: ${auditOperationIndex ? 'present' : 'MISSING'}`)
  console.log(`Unique audit source/revision index: ${auditRevisionIndex ? 'present' : 'MISSING'}`)
  console.log(`Audit TTL indexes: ${auditHasTtlIndex ? 'PRESENT (INVALID)' : 'none'}`)

  let operationAuditIdIndex = false
  let operationAuditTimelineIndex = false
  let operationAuditHasTtlIndex = false
  try {
    const operationIndexes = await JobSourceOperationAudit.collection.indexes()
    operationAuditIdIndex = hasSingleSafeNamedIndex(
      operationIndexes,
      [['operationId', 1]],
      true,
      JOB_SOURCE_CONTROL_INDEX_NAMES.operationAuditOperationId,
    )
    operationAuditTimelineIndex = hasSingleSafeNamedIndex(
      operationIndexes,
      [['sourceId', 1], ['occurredAt', -1]],
      false,
      JOB_SOURCE_CONTROL_INDEX_NAMES.operationAuditSourceOccurredAt,
    )
    operationAuditHasTtlIndex = operationIndexes.some((index) => (
      typeof (index as { expireAfterSeconds?: unknown }).expireAfterSeconds === 'number'
    ))
  } catch (error) {
    if ((error as { codeName?: string }).codeName !== 'NamespaceNotFound') throw error
  }
  console.log(`Unique operation-audit command index: ${operationAuditIdIndex ? 'present' : 'MISSING'}`)
  console.log(`Operation-audit source timeline index: ${operationAuditTimelineIndex ? 'present' : 'MISSING'}`)
  console.log(`Operation-audit TTL indexes: ${operationAuditHasTtlIndex ? 'PRESENT (INVALID)' : 'none'}`)

  let sourceConfigIdentityIndex = false
  try {
    const configIndexes = await JobSourceConfig.collection.indexes()
    sourceConfigIdentityIndex = hasSingleSafeNamedIndex(
      configIndexes,
      [['sourceId', 1]],
      true,
      JOB_SOURCE_CONTROL_INDEX_NAMES.sourceConfigSourceId,
    )
  } catch (error) {
    if ((error as { codeName?: string }).codeName !== 'NamespaceNotFound') throw error
  }
  console.log(`Unique source-config identity index: ${sourceConfigIdentityIndex ? 'present' : 'MISSING'}`)

  const [
    retainedPostings,
    missingLineage,
    invalidProvenance,
    provenanceCoverage,
    globalLineageMeta,
    auditTotalCount,
  ] = await Promise.all([
    JobPosting.countDocuments({}),
    JobPosting.countDocuments(invalidSourceLineageFilter()),
    JobPosting.countDocuments({ $expr: hasInvalidProvenanceSourceIdExpression() }),
    JobPosting.aggregate<{ count: number }>([
      {
        $match: {
          $expr: {
            $gt: [
              {
                $size: {
                  $setDifference: [
                    validProvenanceSourceIdsExpression(),
                    validCurrentSourceIdsExpression(),
                  ],
                },
              },
              0,
            ],
          },
        },
      },
      { $count: 'count' },
    ]),
    JobSourceControlMeta.findOne({
      _id: JOB_SOURCE_CONTROL_META_ID,
      sourceLineageVersion: 1,
    }).lean(),
    JobSourceControlAudit.countDocuments({}),
  ])
  const provenanceCoverageGaps = provenanceCoverage[0]?.count ?? 0
  const controlSequenceDrift = !controlSequenceIsConsistent(globalLineageMeta, auditTotalCount)
  const admissionStateDrift = !admissionStateIsConsistent(globalLineageMeta, retainedPostings)
  console.log(
    `Retained posting corpus: ${retainedPostings}/${JOB_SOURCE_CONTROL_MAX_POSTINGS} ` +
    `${retainedPostings <= JOB_SOURCE_CONTROL_MAX_POSTINGS ? '(within smoke-proven bound)' : '(OVER LIMIT)'}`,
  )
  if (retainedPostings >= JOB_SOURCE_CONTROL_WARN_POSTINGS) {
    const warning = `retained Jobs corpus is ${retainedPostings}/${JOB_SOURCE_CONTROL_MAX_POSTINGS}; preserve legal-control headroom`
    console.warn(`WARNING: ${warning}`)
    if (process.env.GITHUB_ACTIONS === 'true') {
      console.warn(`::warning title=Jobs source-control capacity::${warning}`)
    }
  }
  console.log(`Rows with missing or invalid durable source lineage: ${missingLineage}`)
  console.log(`Rows with invalid detailed provenance IDs: ${invalidProvenance}`)
  console.log(`Rows with provenance absent from sourceIds: ${provenanceCoverageGaps}`)
  console.log(`Global lineage migration marker: ${globalLineageMeta ? 'ready' : 'MISSING'}`)
  console.log(
    `Global control sequence: ${controlSequenceDrift ? 'DRIFT' : 'consistent'} ` +
    `(marker=${globalLineageMeta?.controlWriteSeq ?? 'missing'}, audits=${auditTotalCount})`,
  )
  console.log(
    `Global ingest admission state: ${admissionStateDrift ? 'DRIFT' : 'consistent'} ` +
    `(sequence=${globalLineageMeta?.ingestWriteSeq ?? 'missing'}, ` +
    `counter=${globalLineageMeta?.retainedPostings ?? 'missing'}, physical=${retainedPostings})`,
  )

  type AuditHead = {
    _id: string
    latest: {
      operationId: string
      action: 'revoke' | 'restore'
      actorUserId: unknown
      reason: string
      previousRevision: number
      revision: number
      from: AuditStateSnapshot
      to: { enabled: boolean; health: string }
      occurredAt: Date
    }
    count: number
    maxRevision: number
  }
  type LeanAuditTransition = AuditHistoryTransition & AuditHead['latest'] & { sourceId: unknown }

  const auditHeads: AuditHead[] = []
  let invalidHistoricalAuditTransitions = 0
  let hasCurrentAuditSource = false
  let currentAuditSourceId: unknown
  let currentAuditCount = 0
  let currentAuditMaxRevision = Number.NEGATIVE_INFINITY
  let currentAuditInvalidTransitions = 0
  let currentAuditLatest: LeanAuditTransition | null = null

  const finishAuditHistory = (): void => {
    if (!hasCurrentAuditSource || !currentAuditLatest || currentAuditCount === 0) return
    if (
      typeof currentAuditSourceId !== 'string' ||
      currentAuditSourceId === JOB_SOURCE_LINEAGE_UNKNOWN ||
      !JOB_SOURCE_ID_PATTERN.test(currentAuditSourceId)
    ) {
      invalidHistoricalAuditTransitions += Math.max(
        currentAuditCount,
        currentAuditInvalidTransitions,
      )
      return
    }
    invalidHistoricalAuditTransitions += currentAuditInvalidTransitions
    auditHeads.push({
      _id: currentAuditSourceId,
      latest: currentAuditLatest,
      count: currentAuditCount,
      maxRevision: currentAuditMaxRevision,
    })
  }

  const auditCursor = JobSourceControlAudit.find({})
    .select('sourceId operationId action actorUserId reason previousRevision revision from to occurredAt')
    .sort({ sourceId: 1, revision: 1 })
    .lean()
    .cursor()
  for await (const row of auditCursor) {
    const audit = row as unknown as LeanAuditTransition
    if (hasCurrentAuditSource && audit.sourceId !== currentAuditSourceId) {
      finishAuditHistory()
      currentAuditCount = 0
      currentAuditMaxRevision = Number.NEGATIVE_INFINITY
      currentAuditInvalidTransitions = 0
      currentAuditLatest = null
    }
    hasCurrentAuditSource = true
    currentAuditSourceId = audit.sourceId
    if (!auditTransitionIsValid(audit, currentAuditCount + 1, currentAuditLatest ?? undefined)) {
      currentAuditInvalidTransitions++
    }
    currentAuditCount++
    if (typeof audit.revision === 'number') {
      currentAuditMaxRevision = Math.max(currentAuditMaxRevision, audit.revision)
    }
    currentAuditLatest = audit
  }
  finishAuditHistory()

  const auditHeadBySource = new Map(auditHeads.map((head) => [head._id, head]))
  const auditedSourceIds = auditHeads.map((head) => head._id)
  const controlled = await JobSourceConfig.find({
    $or: [
      { lastControl: { $exists: true } },
      { controlRevision: { $gt: 0 } },
      { health: 'revoked' },
      ...(auditedSourceIds.length ? [{ sourceId: { $in: auditedSourceIds } }] : []),
    ],
  })
    .select('sourceId enabled health controlRevision lastControl')
    .lean()
  const configBySource = new Map(controlled.map((source) => [source.sourceId, source]))
  const orphanAudits = auditHeads.filter((head) => !configBySource.has(head._id)).length
  const revokedSourceIds = new Set<string>()
  let missingAudit = 0
  let missingAuditTransitions = 0
  let controlStateDrift = 0
  let accessibleRevokedPostings = 0

  for (const source of controlled) {
    const head = auditHeadBySource.get(source.sourceId)
    const operationId = source.lastControl?.operationId
    const revision = source.controlRevision ?? 0
    const latestAudit = head?.latest
    if (
      !operationId ||
      !latestAudit ||
      latestAudit.operationId !== operationId ||
      latestAudit.revision !== revision
    ) {
      missingAudit++
    } else {
      const expectedTo = source.lastControl?.action === 'revoke'
        ? { enabled: false, health: 'revoked' }
        : { enabled: false, health: 'quarantined' }
      if (
        latestAudit.action !== source.lastControl?.action ||
        String(latestAudit.actorUserId) !== String(source.lastControl?.actorUserId) ||
        latestAudit.reason !== source.lastControl?.reason ||
        new Date(latestAudit.occurredAt).getTime() !== new Date(source.lastControl?.at ?? 0).getTime() ||
        latestAudit.to?.enabled !== expectedTo.enabled ||
        latestAudit.to?.health !== expectedTo.health
      ) {
        // The transition's recorded destination must agree with lastControl;
        // current health may evolve only after restore, never after revoke.
        controlStateDrift++
      }
    }
    const auditTransitions = head?.count ?? 0
    if (
      auditTransitions !== revision ||
      (head?.maxRevision ?? 0) !== revision ||
      (revision > 0 && latestAudit?.previousRevision !== revision - 1)
    ) {
      missingAuditTransitions += Math.max(1, Math.abs(revision - auditTransitions))
    }
    if (
      latestAudit &&
      latestAudit.action !== (revision % 2 === 1 ? 'revoke' : 'restore')
    ) {
      controlStateDrift++
    }
    if (source.lastControl && source.lastControl.revision !== revision) controlStateDrift++
    if (source.lastControl?.action === 'revoke' && (source.enabled || source.health !== 'revoked')) {
      controlStateDrift++
    }
    if (source.health === 'revoked' && source.lastControl?.action !== 'revoke') controlStateDrift++
    if (source.health === 'revoked' || source.lastControl?.action === 'revoke') {
      revokedSourceIds.add(source.sourceId)
    }
  }
  for (const head of auditHeads) {
    if (head.latest.action === 'revoke') revokedSourceIds.add(head._id)
  }

  for (const sourceId of Array.from(revokedSourceIds)) {
    accessibleRevokedPostings += await JobPosting.countDocuments({
      $and: [
        {
          $or: [
            { sourceIds: { $in: [sourceId, JOB_SOURCE_LINEAGE_UNKNOWN] } },
            { 'provenance.sourceId': sourceId },
            invalidSourceLineageFilter(),
          ],
        },
        { $or: [
          { status: { $ne: 'closed' } },
          { closedReason: { $ne: 'source-revoked' } },
          { purgeAt: { $exists: true } },
        ] },
      ],
    })
  }

  console.log(`Controlled sources missing audit evidence: ${missingAudit}`)
  console.log(`Missing historical audit transitions: ${missingAuditTransitions}`)
  console.log(`Invalid permanent audit transitions: ${invalidHistoricalAuditTransitions}`)
  console.log(`Orphaned source-control audit histories: ${orphanAudits}`)
  console.log(`Controlled-source state drift: ${controlStateDrift}`)
  console.log(`Revoked sources: ${revokedSourceIds.size}`)
  console.log(`Revoked-source postings violating restriction invariant: ${accessibleRevokedPostings}`)

  if (
    !transactionCapable ||
    !sourceIdsIndex ||
    !provenanceSourceIndex ||
    !auditOperationIndex ||
    !auditRevisionIndex ||
    auditHasTtlIndex ||
    !operationAuditIdIndex ||
    !operationAuditTimelineIndex ||
    operationAuditHasTtlIndex ||
    !sourceConfigIdentityIndex ||
    retainedPostings > JOB_SOURCE_CONTROL_MAX_POSTINGS ||
    missingLineage > 0 ||
    invalidProvenance > 0 ||
    provenanceCoverageGaps > 0 ||
    !globalLineageMeta ||
    controlSequenceDrift ||
    admissionStateDrift ||
    missingAudit > 0 ||
    missingAuditTransitions > 0 ||
    invalidHistoricalAuditTransitions > 0 ||
    orphanAudits > 0 ||
    controlStateDrift > 0 ||
    accessibleRevokedPostings > 0
  ) {
    throw new Error('jobs source-control deploy gate failed')
  }
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main()
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
    .finally(async () => {
      await mongoose.disconnect().catch(() => undefined)
    })
}
