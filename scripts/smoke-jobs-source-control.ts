#!/usr/bin/env tsx
/**
 * Destructive-only-to-temporary-collections A02 replica-set smoke.
 *
 * Runs both legal race commit orders and the production-shaped revoke query
 * set at the enforced retained-corpus bound against the staging Mongo tier.
 * It never touches application collections and always attempts to drop its
 * UUID-named data.
 */

import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import mongoose from 'mongoose'
import { connectDB } from '../shared/db/connection'
import {
  JOB_SOURCE_CONTROL_INDEX_NAMES,
  JOB_SOURCE_CONTROL_MAX_POSTINGS,
  JOB_SOURCE_CONTROL_MAX_REVOKE_MS,
} from '../modules/jobs/config/sourceControlLimits'

const ROWS = Number.parseInt(process.env.A02_SMOKE_ROWS ?? String(JOB_SOURCE_CONTROL_MAX_POSTINGS), 10)
const MAX_REVOKE_MS = Number.parseInt(process.env.A02_SMOKE_MAX_MS ?? String(JOB_SOURCE_CONTROL_MAX_REVOKE_MS), 10)
const TX_OPTIONS = {
  readConcern: { level: 'snapshot' as const },
  writeConcern: { w: 'majority' as const },
  readPreference: 'primary' as const,
}
const CONTENTION_BARRIER_TIMEOUT_MS = 15_000

interface SmokeConfig {
  _id?: mongoose.Types.ObjectId
  sourceId: string
  revision: number
  writeSeq: number
  enabled: boolean
  health: string
}

interface SmokePosting {
  _id: string
  sourceIds: unknown
  status: string
  closedReason?: string
  purgeAt?: Date
  closedAt?: Date
  provenance: Array<{ sourceId: string; sourceKey: string }>
  companyKey: string
  domain: string
  locationKeys: string[]
  postedAt: Date
  jdCompressed: Buffer
}

interface SmokeAudit {
  _id?: mongoose.Types.ObjectId
  sourceId: string
  operationId: string
  action: 'revoke'
  revision: number
  occurredAt: Date
}

interface SmokeMeta {
  _id: string
  sourceLineageVersion: number
  controlWriteSeq: number
  ingestWriteSeq: number
  retainedPostings: number
}

class SmokeCapacityError extends Error {}
class SmokeAuthorityError extends Error {}

interface ContentionProbe {
  attempts: number
  firstSnapshotReached: () => void
  releaseAfterOwnerCommit: Promise<void>
}

function createDeferredSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitForBarrier(promise: Promise<void>, label: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} did not reach its first transaction snapshot`)),
          CONTENTION_BARRIER_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function canonicalSourceIdExpression(valueReference: string): Record<string, unknown> {
  return {
    $cond: [
      { $eq: [{ $type: valueReference }, 'string'] },
      { $regexMatch: { input: valueReference, regex: '^(?:__legacy_unknown__|[a-z0-9][a-z0-9:_-]{0,99})$' } },
      false,
    ],
  }
}

function malformedLineageFilter(): Record<string, unknown> {
  const safeSourceIds = { $cond: [{ $isArray: '$sourceIds' }, '$sourceIds', []] }
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

function provenanceDriftFilter(sourceId: string): Record<string, unknown> {
  return {
    'provenance.sourceId': sourceId,
    sourceIds: { $nin: [sourceId, '__legacy_unknown__'] },
    $nor: [malformedLineageFilter()],
  }
}

function malformedLineageFallbackFilter(sourceId: string): Record<string, unknown> {
  return {
    $and: [
      malformedLineageFilter(),
      { sourceIds: { $nin: [sourceId, '__legacy_unknown__'] } },
    ],
  }
}

function assertSafeConfiguration(): void {
  if (process.env.A02_SMOKE_ALLOW !== '1') {
    throw new Error('set A02_SMOKE_ALLOW=1 to permit temporary staging collections')
  }
  if (!Number.isInteger(ROWS) || ROWS !== JOB_SOURCE_CONTROL_MAX_POSTINGS) {
    throw new Error(
      `A02_SMOKE_ROWS must equal the enforced retained-corpus bound ` +
      `${JOB_SOURCE_CONTROL_MAX_POSTINGS}: ${process.env.A02_SMOKE_ROWS ?? ''}`,
    )
  }
  if (!Number.isInteger(MAX_REVOKE_MS) || MAX_REVOKE_MS < 1_000 || MAX_REVOKE_MS >= 60_000) {
    throw new Error(`A02_SMOKE_MAX_MS must be between 1000 and 59999: ${process.env.A02_SMOKE_MAX_MS ?? ''}`)
  }
}

async function main(): Promise<void> {
  assertSafeConfiguration()
  await connectDB()
  const db = mongoose.connection.db
  if (!db) throw new Error('Mongo connection has no database handle')
  const client = mongoose.connection.getClient()
  const suffix = randomUUID().replaceAll('-', '')
  const configs = db.collection<SmokeConfig>(`__a02_smoke_configs_${suffix}`)
  const postings = db.collection<SmokePosting>(`__a02_smoke_postings_${suffix}`)
  const audits = db.collection<SmokeAudit>(`__a02_smoke_audits_${suffix}`)
  const metas = db.collection<SmokeMeta>(`__a02_smoke_meta_${suffix}`)
  const sourceId = `a02-smoke:${suffix}`
  const capacitySourceId = `${sourceId}:capacity-contender`
  const secondSourceId = `${sourceId}:revoke-first`
  let runError: unknown

  const revoke = async (
    targetSourceId: string,
    contentionProbe?: ContentionProbe,
  ): Promise<{ affected: number; durationMs: number }> => {
    const session = client.startSession()
    let affected = 0
    const started = Date.now()
    try {
      await session.withTransaction(async () => {
        if (contentionProbe) contentionProbe.attempts += 1
        const auditTotal = await audits.countDocuments({}, { session })
        const meta = await metas.findOne(
          { _id: 'jobs-source-control', sourceLineageVersion: 1 },
          { session, projection: { controlWriteSeq: 1 } },
        )
        if (!meta || meta.controlWriteSeq !== auditTotal) {
          throw new Error('global audit/meta sequence drift in smoke')
        }
        if (contentionProbe?.attempts === 1) {
          contentionProbe.firstSnapshotReached()
          await contentionProbe.releaseAfterOwnerCommit
        }
        const metaFence = await metas.updateOne(
          { _id: 'jobs-source-control', sourceLineageVersion: 1, controlWriteSeq: auditTotal },
          { $inc: { controlWriteSeq: 1 } },
          { session },
        )
        if (metaFence.matchedCount !== 1) throw new Error('global sequence fence missed')

        const transition = await configs.updateOne(
          { sourceId: targetSourceId, revision: 0, enabled: true },
          { $set: { revision: 1, enabled: false, health: 'revoked' } },
          { session },
        )
        if (transition.matchedCount !== 1) throw new Error(`authority fence missed for ${targetSourceId}`)

        const retainedPostings = await postings.countDocuments({}, { session })
        if (retainedPostings > JOB_SOURCE_CONTROL_MAX_POSTINGS) {
          throw new Error(`retained corpus ${retainedPostings} exceeds ${JOB_SOURCE_CONTROL_MAX_POSTINGS}`)
        }
        const retainedSnapshot = await metas.updateOne(
          {
            _id: 'jobs-source-control',
            sourceLineageVersion: 1,
            controlWriteSeq: auditTotal + 1,
          },
          { $set: { retainedPostings } },
          { session },
        )
        if (retainedSnapshot.matchedCount !== 1) throw new Error('retained snapshot lost control fence')
        await postings.countDocuments(
          { sourceIds: '__legacy_unknown__' },
          { session, hint: JOB_SOURCE_CONTROL_INDEX_NAMES.postingSourceIds },
        )
        const provenanceDrift = await postings.countDocuments(
          provenanceDriftFilter(targetSourceId),
          { session, hint: JOB_SOURCE_CONTROL_INDEX_NAMES.postingProvenanceSourceId },
        )
        const malformed = await postings.countDocuments(
          malformedLineageFallbackFilter(targetSourceId),
          { session },
        )
        const restriction = {
          $set: { status: 'closed', closedReason: 'source-revoked', closedAt: new Date() },
          $unset: { purgeAt: 1 as const },
        }
        const closure = await postings.updateMany(
          { sourceIds: { $in: [targetSourceId, '__legacy_unknown__'] } },
          restriction,
          { session, hint: JOB_SOURCE_CONTROL_INDEX_NAMES.postingSourceIds },
        )
        affected = closure.matchedCount
        if (provenanceDrift > 0) {
          const driftClosure = await postings.updateMany(
            provenanceDriftFilter(targetSourceId),
            restriction,
            { session, hint: JOB_SOURCE_CONTROL_INDEX_NAMES.postingProvenanceSourceId },
          )
          affected += driftClosure.matchedCount
        }
        if (malformed > 0) {
          const malformedClosure = await postings.updateMany(
            malformedLineageFallbackFilter(targetSourceId),
            restriction,
            { session },
          )
          affected += malformedClosure.matchedCount
        }
        await audits.insertOne({
          sourceId: targetSourceId,
          operationId: `smoke:${targetSourceId}:revoke`,
          action: 'revoke',
          revision: 1,
          occurredAt: new Date(),
        }, { session })
      }, TX_OPTIONS)
    } finally {
      await session.endSession()
    }
    return { affected, durationMs: Date.now() - started }
  }

  const fencedInsert = async (
    targetSourceId: string,
    posting: SmokePosting,
    contentionProbe?: ContentionProbe,
  ): Promise<void> => {
    const session = client.startSession()
    try {
      await session.withTransaction(async () => {
        if (contentionProbe) contentionProbe.attempts += 1
        const meta = await metas.findOne(
          { _id: 'jobs-source-control', sourceLineageVersion: 1 },
          { session, projection: { ingestWriteSeq: 1, retainedPostings: 1 } },
        )
        if (!meta) throw new Error('global ingest metadata missing')
        if (contentionProbe?.attempts === 1) {
          contentionProbe.firstSnapshotReached()
          await contentionProbe.releaseAfterOwnerCommit
        }
        const metaFence = await metas.updateOne(
          {
            _id: 'jobs-source-control',
            sourceLineageVersion: 1,
            ingestWriteSeq: meta.ingestWriteSeq,
          },
          { $inc: { ingestWriteSeq: 1 } },
          { session },
        )
        if (metaFence.matchedCount !== 1) throw new Error('global ingest fence missed')
        const sourceFence = await configs.updateOne(
          { sourceId: targetSourceId, revision: 0, enabled: true },
          { $inc: { writeSeq: 1 } },
          { session },
        )
        if (sourceFence.matchedCount !== 1) {
          throw new SmokeAuthorityError(`source ingest fence missed for ${targetSourceId}`)
        }
        const latestAudit = await audits.findOne(
          { sourceId: targetSourceId },
          { session, sort: { revision: -1 }, projection: { revision: 1 } },
        )
        if (latestAudit) throw new SmokeAuthorityError(`epoch-zero source ${targetSourceId} has an audit head`)

        await postings.insertOne(posting, { session })
        const admittedPostings = meta.retainedPostings + 1
        if (admittedPostings > JOB_SOURCE_CONTROL_MAX_POSTINGS) {
          throw new SmokeCapacityError(`retained corpus admission rejected ${admittedPostings}`)
        }
        const admission = await metas.updateOne(
          {
            _id: 'jobs-source-control',
            sourceLineageVersion: 1,
            ingestWriteSeq: meta.ingestWriteSeq + 1,
            retainedPostings: meta.retainedPostings,
          },
          { $inc: { retainedPostings: 1 } },
          { session },
        )
        if (admission.matchedCount !== 1) throw new Error('retained corpus admission lost ingest fence')
      }, TX_OPTIONS)
    } finally {
      await session.endSession()
    }
  }

  try {
    await Promise.all([
      configs.createIndex(
        { sourceId: 1 },
        { unique: true, name: JOB_SOURCE_CONTROL_INDEX_NAMES.sourceConfigSourceId },
      ),
      postings.createIndex(
        { sourceIds: 1 },
        { name: JOB_SOURCE_CONTROL_INDEX_NAMES.postingSourceIds },
      ),
      postings.createIndex(
        { 'provenance.sourceId': 1 },
        { name: JOB_SOURCE_CONTROL_INDEX_NAMES.postingProvenanceSourceId },
      ),
      postings.createIndex({ companyKey: 1, status: 1 }),
      postings.createIndex({ domain: 1, locationKeys: 1, status: 1, postedAt: -1 }),
      postings.createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0 }),
      audits.createIndex(
        { operationId: 1 },
        { unique: true, name: JOB_SOURCE_CONTROL_INDEX_NAMES.auditOperationId },
      ),
      audits.createIndex(
        { sourceId: 1, revision: 1 },
        { unique: true, name: JOB_SOURCE_CONTROL_INDEX_NAMES.auditSourceRevision },
      ),
    ])
    await configs.insertMany([
      { sourceId, revision: 0, writeSeq: 0, enabled: true, health: 'active' },
      { sourceId: capacitySourceId, revision: 0, writeSeq: 0, enabled: true, health: 'active' },
      { sourceId: secondSourceId, revision: 0, writeSeq: 0, enabled: true, health: 'active' },
    ])
    await metas.insertOne({
      _id: 'jobs-source-control',
      sourceLineageVersion: 1,
      controlWriteSeq: 0,
      ingestWriteSeq: 0,
      retainedPostings: 0,
    })

    const seededRows = ROWS - 1
    for (let offset = 0; offset < seededRows; offset += 1_000) {
      const size = Math.min(1_000, seededRows - offset)
      await postings.insertMany(Array.from({ length: size }, (_, index) => ({
        _id: `${sourceId}:${offset + index}`,
        sourceIds: offset + index === 0
          ? [' padded-source-id ']
          : offset + index === 1
            ? ['other-source']
            : (offset + index) % 20 === 0
              ? ['__legacy_unknown__']
              : [sourceId],
        provenance: [{ sourceId, sourceKey: `${sourceId}:${offset + index}` }],
        companyKey: `company-${(offset + index) % 500}`,
        domain: 'software-engineering',
        locationKeys: ['india:pune'],
        postedAt: new Date('2026-07-01T00:00:00.000Z'),
        jdCompressed: Buffer.alloc(1_500, (offset + index) % 255),
        status: 'open',
        purgeAt: new Date(Date.now() + 86_400_000),
      })), { ordered: false })
    }
    await metas.updateOne(
      { _id: 'jobs-source-control' },
      { $set: { retainedPostings: seededRows } },
    )

    // Commit order 1: page owns the config row first. Revoke waits/retries,
    // then must close both the seeded corpus and the just-committed page row.
    const pageSession = client.startSession()
    pageSession.startTransaction(TX_OPTIONS)
    const pageMeta = await metas.findOne(
      { _id: 'jobs-source-control', sourceLineageVersion: 1 },
      { session: pageSession, projection: { ingestWriteSeq: 1, retainedPostings: 1 } },
    )
    if (!pageMeta) throw new Error('page-first global metadata missing')
    const pageGlobalFence = await metas.updateOne(
      {
        _id: 'jobs-source-control',
        sourceLineageVersion: 1,
        ingestWriteSeq: pageMeta.ingestWriteSeq,
      },
      { $inc: { ingestWriteSeq: 1 } },
      { session: pageSession },
    )
    if (pageGlobalFence.matchedCount !== 1) throw new Error('page-first global fence did not acquire authority')
    const pageFence = await configs.updateOne(
      { sourceId, revision: 0, enabled: true },
      { $inc: { writeSeq: 1 } },
      { session: pageSession },
    )
    if (pageFence.matchedCount !== 1) throw new Error('page-first fence did not acquire authority')
    await postings.insertOne({
      _id: `${sourceId}:late-page`,
      sourceIds: [sourceId],
      provenance: [{ sourceId, sourceKey: `${sourceId}:late-page` }],
      companyKey: 'late-page',
      domain: 'software-engineering',
      locationKeys: ['india:pune'],
      postedAt: new Date(),
      jdCompressed: Buffer.alloc(1_500, 1),
      status: 'open',
    }, { session: pageSession })
    if (pageMeta.retainedPostings + 1 > JOB_SOURCE_CONTROL_MAX_POSTINGS) {
      throw new Error('page-first unexpectedly exceeded retained bound')
    }
    const pageAdmission = await metas.updateOne(
      {
        _id: 'jobs-source-control',
        sourceLineageVersion: 1,
        ingestWriteSeq: pageMeta.ingestWriteSeq + 1,
        retainedPostings: pageMeta.retainedPostings,
      },
      { $inc: { retainedPostings: 1 } },
      { session: pageSession },
    )
    if (pageAdmission.matchedCount !== 1) throw new Error('page-first retained admission missed')

    const capacityPosting: SmokePosting = {
      _id: `${capacitySourceId}:over-cap`,
      sourceIds: [capacitySourceId],
      provenance: [{ sourceId: capacitySourceId, sourceKey: `${capacitySourceId}:over-cap` }],
      companyKey: 'capacity-contender',
      domain: 'software-engineering',
      locationKeys: ['india:pune'],
      postedAt: new Date(),
      jdCompressed: Buffer.alloc(1_500, 4),
      status: 'open',
    }
    const capacitySnapshot = createDeferredSignal()
    const revokeSnapshot = createDeferredSignal()
    const pageOwnerCommitted = createDeferredSignal()
    const capacityProbe: ContentionProbe = {
      attempts: 0,
      firstSnapshotReached: capacitySnapshot.resolve,
      releaseAfterOwnerCommit: pageOwnerCommitted.promise,
    }
    const revokeProbe: ContentionProbe = {
      attempts: 0,
      firstSnapshotReached: revokeSnapshot.resolve,
      releaseAfterOwnerCommit: pageOwnerCommitted.promise,
    }
    const capacityPromise = fencedInsert(capacitySourceId, capacityPosting, capacityProbe).then(
      () => null,
      (error) => error,
    )
    const revokePromise = revoke(sourceId, revokeProbe)
    let pageOwnerCommitSucceeded = false
    try {
      await Promise.all([
        waitForBarrier(capacitySnapshot.promise, 'capacity contender'),
        waitForBarrier(revokeSnapshot.promise, 'page-first revoke contender'),
      ])
      await pageSession.commitTransaction()
      pageOwnerCommitSucceeded = true
    } finally {
      // Successful paths release the contenders only after the owner commit.
      // A failed path aborts first, then releases them only for cancellation.
      if (!pageOwnerCommitSucceeded && pageSession.inTransaction()) {
        await pageSession.abortTransaction().catch(() => undefined)
      }
      pageOwnerCommitted.resolve()
      await pageSession.endSession()
    }
    const capacityError = await capacityPromise
    if (!(capacityError instanceof SmokeCapacityError)) {
      throw new Error(`cross-source capacity contender was not rejected: ${String(capacityError)}`)
    }
    if (await postings.findOne({ _id: capacityPosting._id }, { projection: { _id: 1 } })) {
      throw new Error('over-cap cross-source posting survived its aborted transaction')
    }
    const pageFirst = await revokePromise
    if (capacityProbe.attempts <= 1 || revokeProbe.attempts <= 1) {
      throw new Error(
        `page-first did not force transaction retries: ` +
        `capacity=${capacityProbe.attempts}, revoke=${revokeProbe.attempts}`,
      )
    }

    if (pageFirst.affected !== ROWS) {
      throw new Error(`production-shaped revoke affected ${pageFirst.affected}; expected ${ROWS}`)
    }
    if (pageFirst.durationMs > MAX_REVOKE_MS) {
      throw new Error(`bounded production-shaped revoke took ${pageFirst.durationMs}ms; limit ${MAX_REVOKE_MS}ms`)
    }
    const stillAccessible = await postings.countDocuments({
      $or: [
        { status: { $ne: 'closed' } },
        { closedReason: { $ne: 'source-revoked' } },
        { purgeAt: { $exists: true } },
      ],
    })
    if (stillAccessible !== 0) throw new Error(`page-first left ${stillAccessible} accessible rows`)

    // The second commit-order race needs only one row; remove the temporary
    // first corpus so the test itself never operates above the proven bound.
    await postings.deleteMany({})

    // Commit order 2: an uncommitted revoke owns global meta and then the
    // source config while a page transaction contends in the same lock order.
    // After revoke commits, withTransaction retries the page callback against
    // revision 1; its stale revision-0 fence must miss.
    await postings.insertOne({
      _id: `${secondSourceId}:seed`,
      sourceIds: [secondSourceId],
      provenance: [{ sourceId: secondSourceId, sourceKey: `${secondSourceId}:seed` }],
      companyKey: 'revoke-first',
      domain: 'software-engineering',
      locationKeys: ['india:pune'],
      postedAt: new Date(),
      jdCompressed: Buffer.alloc(1_500, 2),
      status: 'open',
    })
    await metas.updateOne(
      { _id: 'jobs-source-control' },
      { $set: { retainedPostings: 1 } },
    )
    const revokeFirstSession = client.startSession()
    revokeFirstSession.startTransaction(TX_OPTIONS)
    const revokeFirstAuditTotal = await audits.countDocuments({}, { session: revokeFirstSession })
    const revokeFirstMeta = await metas.findOne(
      { _id: 'jobs-source-control', sourceLineageVersion: 1 },
      { session: revokeFirstSession, projection: { controlWriteSeq: 1 } },
    )
    if (!revokeFirstMeta || revokeFirstMeta.controlWriteSeq !== revokeFirstAuditTotal) {
      throw new Error('revoke-first global audit/meta sequence drift')
    }
    const revokeFirstGlobalFence = await metas.updateOne(
      {
        _id: 'jobs-source-control',
        sourceLineageVersion: 1,
        controlWriteSeq: revokeFirstAuditTotal,
      },
      { $inc: { controlWriteSeq: 1 } },
      { session: revokeFirstSession },
    )
    if (revokeFirstGlobalFence.matchedCount !== 1) throw new Error('revoke-first global fence missed')
    const revokeFirstFence = await configs.updateOne(
      { sourceId: secondSourceId, revision: 0, enabled: true },
      { $set: { revision: 1, enabled: false, health: 'revoked' } },
      { session: revokeFirstSession },
    )
    if (revokeFirstFence.matchedCount !== 1) throw new Error('revoke-first fence did not acquire authority')
    const revokeFirstRetained = await postings.countDocuments({}, { session: revokeFirstSession })
    if (revokeFirstRetained > JOB_SOURCE_CONTROL_MAX_POSTINGS) {
      throw new Error('revoke-first retained bound exceeded')
    }
    const revokeFirstSnapshot = await metas.updateOne(
      {
        _id: 'jobs-source-control',
        sourceLineageVersion: 1,
        controlWriteSeq: revokeFirstAuditTotal + 1,
      },
      { $set: { retainedPostings: revokeFirstRetained } },
      { session: revokeFirstSession },
    )
    if (revokeFirstSnapshot.matchedCount !== 1) throw new Error('revoke-first retained snapshot missed')
    await postings.updateMany(
      { sourceIds: secondSourceId },
      { $set: { status: 'closed', closedReason: 'source-revoked', closedAt: new Date() } },
      { session: revokeFirstSession, hint: JOB_SOURCE_CONTROL_INDEX_NAMES.postingSourceIds },
    )
    await audits.insertOne({
      sourceId: secondSourceId,
      operationId: `smoke:${secondSourceId}:revoke`,
      action: 'revoke',
      revision: 1,
      occurredAt: new Date(),
    }, { session: revokeFirstSession })

    const stalePageSnapshot = createDeferredSignal()
    const revokeOwnerCommitted = createDeferredSignal()
    const stalePageProbe: ContentionProbe = {
      attempts: 0,
      firstSnapshotReached: stalePageSnapshot.resolve,
      releaseAfterOwnerCommit: revokeOwnerCommitted.promise,
    }
    const stalePagePromise = fencedInsert(secondSourceId, {
      _id: `${secondSourceId}:late-page`,
      sourceIds: [secondSourceId],
      provenance: [{ sourceId: secondSourceId, sourceKey: `${secondSourceId}:late-page` }],
      companyKey: 'unauthorized',
      domain: 'software-engineering',
      locationKeys: ['india:pune'],
      postedAt: new Date(),
      jdCompressed: Buffer.alloc(1_500, 3),
      status: 'open',
    }, stalePageProbe).then(
      () => null,
      (error) => error,
    )
    let revokeOwnerCommitSucceeded = false
    try {
      await waitForBarrier(stalePageSnapshot.promise, 'revoke-first page contender')
      await revokeFirstSession.commitTransaction()
      revokeOwnerCommitSucceeded = true
    } finally {
      if (!revokeOwnerCommitSucceeded && revokeFirstSession.inTransaction()) {
        await revokeFirstSession.abortTransaction().catch(() => undefined)
      }
      revokeOwnerCommitted.resolve()
      await revokeFirstSession.endSession()
    }
    const stalePageError = await stalePagePromise
    if (!(stalePageError instanceof SmokeAuthorityError)) {
      throw new Error(`revoke-first stale page was not authority-rejected: ${String(stalePageError)}`)
    }
    if (stalePageProbe.attempts <= 1) {
      throw new Error(`revoke-first did not force a page transaction retry: attempts=${stalePageProbe.attempts}`)
    }
    if (await postings.findOne({ _id: `${secondSourceId}:late-page` }, { projection: { _id: 1 } })) {
      throw new Error('revoke-first persisted an unauthorized posting')
    }
    const revokeFirstSeed = await postings.findOne(
      { _id: `${secondSourceId}:seed` },
      { projection: { status: 1, closedReason: 1, purgeAt: 1 } },
    )
    if (
      !revokeFirstSeed ||
      revokeFirstSeed.status !== 'closed' ||
      revokeFirstSeed.closedReason !== 'source-revoked' ||
      revokeFirstSeed.purgeAt
    ) {
      throw new Error('revoke-first did not leave its seeded posting restricted and non-expiring')
    }

    console.log(
      `A02 replica-set smoke passed: retainedRows=${ROWS}, ` +
      `productionShapeRevoke=${pageFirst.durationMs}ms, ` +
      `retries=capacity:${capacityProbe.attempts - 1},` +
      `pageFirstRevoke:${revokeProbe.attempts - 1},` +
      `revokeFirstPage:${stalePageProbe.attempts - 1}, both commit orders safe`,
    )
  } catch (error) {
    runError = error
    throw error
  } finally {
    const collections = [configs, postings, audits, metas]
    const cleanup = await Promise.allSettled(collections.map((collection) => collection.drop()))
    const cleanupFailures = cleanup.flatMap((result, index) => (
      result.status === 'rejected'
        ? [{ collection: collections[index].collectionName, error: result.reason }]
        : []
    ))
    await mongoose.disconnect().catch(() => undefined)
    if (cleanupFailures.length > 0) {
      console.error('A02 smoke cleanup failed; remove these temporary collections manually:', cleanupFailures)
      if (!runError) {
        throw new Error(`A02 smoke left ${cleanupFailures.length} temporary collection(s) behind`)
      }
    }
  }
}

main().catch((error) => {
  console.error('A02 replica-set smoke failed:', error)
  process.exitCode = 1
})
