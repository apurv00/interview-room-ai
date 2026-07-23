import { NextResponse } from 'next/server'
import { z } from 'zod'
import { JOB_SOURCE_LINEAGE_UNKNOWN, JobPosting, JobsVerdictConfigAudit } from '@shared/db/models'
import {
  JOBS_VERDICT_CONFIG_LIMITS,
  jobsVerdictConfigIssueOf,
} from '@shared/validators/jobsVerdictConfigLimits'
import { requireCurrentPlatformAdmin } from '@jobs/services/adminAuth'
import { checkJobsRateLimit } from '@jobs/services/rateLimit'
import { JOB_POSTING_AGE_OUT_MS } from '@jobs/services/retentionService'
import {
  getJobsVerdictConfigSnapshot,
  JobsVerdictConfigConflictError,
  JobsVerdictConfigMigrationRequiredError,
  JobsVerdictConfigRepairRequiredError,
  JobsVerdictConfigRevisionNotFoundError,
  JobsVerdictConfigTransactionsRequiredError,
  JobsVerdictConfigValidationError,
  rollbackJobsVerdictConfig,
  updateJobsVerdictConfig,
} from '@jobs/services/verdictConfigControl'
import {
  fenceQualityDecisionSources,
  getAutomaticQualityDecision,
  getQualityDecisionReviewHistory,
  listQualityDecisionPage,
  QualityDecisionConflictError,
  QualityDecisionNotFoundError,
  QualityDecisionTransactionsRequiredError,
  QualityDecisionValidationError,
  reviewQualityDecision,
  reviewQualityDecisionInSession,
  withQualityDecisionTransaction,
  type QualityDecisionListItem,
} from '@jobs/services/qualityDecisionService'

export const dynamic = 'force-dynamic'

const configSchema = z.object({
  collectionEnabled: z.boolean(),
  enforceEnabled: z.boolean(),
  rankingEnabled: z.literal(false),
  dailyVerdictCap: z.number().int()
    .min(JOBS_VERDICT_CONFIG_LIMITS.dailyVerdictCap.min)
    .max(JOBS_VERDICT_CONFIG_LIMITS.dailyVerdictCap.max),
  dailyBudgetUsd: z.number().finite()
    .min(JOBS_VERDICT_CONFIG_LIMITS.dailyBudgetUsd.min)
    .max(JOBS_VERDICT_CONFIG_LIMITS.dailyBudgetUsd.max),
  monthlyBudgetUsd: z.number().finite()
    .min(JOBS_VERDICT_CONFIG_LIMITS.monthlyBudgetUsd.min)
    .max(JOBS_VERDICT_CONFIG_LIMITS.monthlyBudgetUsd.max),
  perCompanyDailyCap: z.number().int()
    .min(JOBS_VERDICT_CONFIG_LIMITS.perCompanyDailyCap.min)
    .max(JOBS_VERDICT_CONFIG_LIMITS.perCompanyDailyCap.max),
  perSourceDailyCap: z.number().int()
    .min(JOBS_VERDICT_CONFIG_LIMITS.perSourceDailyCap.min)
    .max(JOBS_VERDICT_CONFIG_LIMITS.perSourceDailyCap.max),
  inputUsdPerMTok: z.number().finite()
    .min(JOBS_VERDICT_CONFIG_LIMITS.inputUsdPerMTok.min)
    .max(JOBS_VERDICT_CONFIG_LIMITS.inputUsdPerMTok.max),
  outputUsdPerMTok: z.number().finite()
    .min(JOBS_VERDICT_CONFIG_LIMITS.outputUsdPerMTok.min)
    .max(JOBS_VERDICT_CONFIG_LIMITS.outputUsdPerMTok.max),
  notes: z.string().max(2000).optional(),
}).strict().superRefine((config, context) => {
  const issue = jobsVerdictConfigIssueOf(config)
  if (issue) context.addIssue({ code: 'custom', message: issue })
})

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('update-config'),
    expectedRevision: z.number().int().nonnegative(),
    config: configSchema,
    reason: z.string().trim().min(8).max(1000),
  }).strict(),
  z.object({
    action: z.literal('rollback-config'),
    expectedRevision: z.number().int().nonnegative(),
    targetRevision: z.number().int().nonnegative(),
    reason: z.string().trim().min(8).max(1000),
  }).strict(),
  z.object({
    action: z.literal('review-decision'),
    decisionId: z.string().regex(/^[a-f0-9]{24}$/i),
    expectedReviewRevision: z.number().int().nonnegative(),
    resolution: z.enum(['confirmed', 'restored']),
    reason: z.string().trim().min(8).max(1000),
  }).strict(),
])

const operationIdSchema = z.string().uuid()
const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i)
const getQuerySchema = z.object({
  reviewStatus: z.enum(['unreviewed', 'upheld']).default('unreviewed'),
  beforeAt: z.string().datetime().optional(),
  beforeId: objectIdSchema.optional(),
  decisionId: objectIdSchema.optional(),
}).superRefine((query, context) => {
  if (!!query.beforeAt !== !!query.beforeId) {
    context.addIssue({ code: 'custom', message: 'beforeAt and beforeId must be supplied together' })
  }
  if (query.decisionId && (query.beforeAt || query.beforeId)) {
    context.addIssue({ code: 'custom', message: 'decisionId cannot be combined with a page cursor' })
  }
})
const noStoreHeaders = { 'Cache-Control': 'private, no-store' }

interface PostingContext {
  id: string
  title: string
  company: string
  locations: string[]
  isRemote: boolean
  status: string
  closedReason?: string
}

function evidenceSummary(decision: QualityDecisionListItem): string {
  const evidence = decision.evidence
  if (evidence.kind === 'hard-drop') {
    const reasons = evidence.reasonCodes?.join(', ') || 'quality floor'
    const repost = evidence.massRepostCompanyCount === undefined
      ? ''
      : `; ${evidence.massRepostCompanyCount} companies shared the body`
    return `${reasons}; ${evidence.bodyLength ?? 0} normalized characters${repost}`
  }
  if (evidence.kind === 'llm-verdict') {
    const reasons = evidence.reasonCodes?.join(', ') || 'no reason codes'
    return `${evidence.verdict ?? 'unknown'} (${Math.round((evidence.genuineness ?? 0) * 100)}% genuine); ${reasons}`
  }
  if (evidence.basis === 'crowd') {
    return `${evidence.reportCount ?? 0}/${evidence.quorum ?? 0} trusted reports reached the current quorum`
  }
  return `${evidence.outcome ?? 'unknown'} machine result across ${evidence.checkedOptionCount ?? 0} current option(s)`
}

async function postingContextsOf(decisions: QualityDecisionListItem[]): Promise<Map<string, PostingContext>> {
  const ids = Array.from(new Set(decisions.flatMap((decision) => decision.postingId ? [decision.postingId] : [])))
  if (!ids.length) return new Map()
  const rows = await JobPosting.find(
    { _id: { $in: ids } },
    { title: 1, company: 1, locations: 1, isRemote: 1, status: 1, closedReason: 1 },
  ).lean()
  return new Map(rows.map((row) => [String(row._id), {
    id: String(row._id),
    title: String(row.title ?? ''),
    company: String(row.company ?? ''),
    locations: Array.isArray(row.locations) ? row.locations.map(String).slice(0, 8) : [],
    isRemote: !!row.isRemote,
    status: String(row.status ?? 'unknown'),
    ...(typeof row.closedReason === 'string' ? { closedReason: row.closedReason } : {}),
  }]))
}

function decisionSummary(decision: QualityDecisionListItem, postings: Map<string, PostingContext>) {
  return {
    id: decision.id,
    decisionKey: decision.decisionKey,
    domain: decision.domain,
    outcome: decision.action,
    reviewStatus: decision.reviewStatus,
    reviewRevision: decision.reviewRevision,
    occurredAt: decision.occurredAt,
    lastSeenAt: decision.lastSeenAt,
    seenCount: decision.seenCount,
    serviceActor: decision.serviceActor,
    inputHash: decision.inputHash,
    policyRevision: decision.policyRevision,
    ...(decision.configRevision === undefined ? {} : { configRevision: decision.configRevision }),
    sourceRevisions: decision.sourceRevisions,
    ...(decision.postingId ? {
      postingId: decision.postingId,
      ...(postings.get(decision.postingId) ? { posting: postings.get(decision.postingId) } : {}),
    } : {}),
    evidenceSummary: evidenceSummary(decision),
    ...(decision.reviewOverlay ? { reviewOverlay: decision.reviewOverlay } : {}),
  }
}

async function authorizeMutation() {
  return requireCurrentPlatformAdmin({
    beforeAuthorityLookup: (actorUserId) => checkJobsRateLimit(actorUserId, 'admin-command'),
  })
}

async function assertCurrentDecisionSources(
  sourceRevisions: Array<{ sourceId: string; controlRevision: number; operationalRevision: number }>,
  session: import('mongoose').ClientSession,
) {
  await fenceQualityDecisionSources(sourceRevisions, session)
}

async function restoreDecision(
  command: Parameters<typeof reviewQualityDecision>[0],
) {
  return withQualityDecisionTransaction(async (session) => {
    let effect: 'allow-on-next-sync' | 'reopened' | 'recovery-check-requested' | undefined
    const result = await reviewQualityDecisionInSession(command, session, async (_transition, _session, root) => {
      if (!['drop', 'demote', 'close'].includes(root.action)) {
        throw new QualityDecisionConflictError(`${root.action} is not a restrictive decision`)
      }
      await assertCurrentDecisionSources(root.sourceRevisions, session)
      if (root.domain === 'hard-drop') {
        if (!root.reviewOverlay) {
          throw new QualityDecisionConflictError('hard-drop review evidence is unavailable')
        }
        effect = 'allow-on-next-sync'
        return
      }
      if (root.domain === 'llm-verdict') {
        if (!root.postingId || root.action !== 'close' || root.evidence.kind !== 'llm-verdict') {
          throw new QualityDecisionConflictError('only an exact LLM closure can be restored')
        }
        const now = new Date()
        const staleBefore = new Date(now.getTime() - JOB_POSTING_AGE_OUT_MS)
        const posting = await JobPosting.findById(root.postingId, null, { session })
          .select('status closedReason llmVerdict sourceIds provenance.sourceId validThrough lastSeenAt updatedAt')
          .lean()
        const currentSourceIds = Array.from(new Set([
          ...(posting?.sourceIds ?? []),
          ...(posting?.provenance ?? []).map((entry) => entry.sourceId),
        ])).sort()
        const decisionSourceIds = root.sourceRevisions.map((revision) => revision.sourceId).sort()
        const lastSeenAt = posting?.lastSeenAt ? new Date(posting.lastSeenAt) : null
        const validThrough = posting?.validThrough ? new Date(posting.validThrough) : null
        if (
          !posting ||
          posting.status !== 'closed' ||
          posting.closedReason !== 'llm-verdict' ||
          posting.llmVerdict?.status !== 'scored' ||
          posting.llmVerdict?.verdictInputHash !== root.inputHash ||
          posting.llmVerdict?.epoch !== root.evidence.epoch ||
          currentSourceIds.length === 0 ||
          currentSourceIds.includes(JOB_SOURCE_LINEAGE_UNKNOWN) ||
          JSON.stringify(currentSourceIds) !== JSON.stringify(decisionSourceIds) ||
          !lastSeenAt || !Number.isFinite(lastSeenAt.getTime()) || lastSeenAt < staleBefore ||
          (validThrough !== null && (!Number.isFinite(validThrough.getTime()) || validThrough <= now)) ||
          !posting.updatedAt
        ) throw new QualityDecisionConflictError('posting or verdict evidence changed after this decision')
        const write = await JobPosting.updateOne(
          {
            _id: root.postingId,
            updatedAt: posting.updatedAt,
            status: 'closed',
            closedReason: 'llm-verdict',
            lastSeenAt: { $gte: staleBefore },
            $or: [
              { validThrough: { $exists: false } },
              { validThrough: null },
              { validThrough: { $gt: now } },
            ],
            'llmVerdict.status': 'scored',
            'llmVerdict.verdictInputHash': root.inputHash,
            'llmVerdict.epoch': root.evidence.epoch,
          },
          {
            $set: { status: 'open' },
            $unset: { closedReason: 1, closedAt: 1, purgeAt: 1 },
          },
          { session },
        )
        if ((write.matchedCount ?? 0) !== 1) {
          throw new QualityDecisionConflictError('posting changed during verdict restoration')
        }
        effect = 'reopened'
        return
      }
      if (!root.postingId) throw new QualityDecisionConflictError('link decision has no posting')
      const write = await JobPosting.updateOne(
        {
          _id: root.postingId,
          $or: [
            { status: 'open' },
            { status: 'closed', closedReason: 'dead-apply-link' },
          ],
        },
        { $set: { linkCheckRequestedAt: new Date() } },
        { session },
      )
      if ((write.matchedCount ?? 0) !== 1) {
        throw new QualityDecisionConflictError('posting is no longer eligible for link recovery')
      }
      effect = 'recovery-check-requested'
    })
    return { ...result, effect: effect ?? 'already-applied' }
  })
}

export async function GET(req: Request) {
  const authorization = await requireCurrentPlatformAdmin()
  if (!authorization.ok) {
    if (authorization.response) return authorization.response
    return NextResponse.json({ error: authorization.error }, { status: authorization.status, headers: noStoreHeaders })
  }

  const url = new URL(req.url)
  const parsedQuery = getQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()))
  if (!parsedQuery.success) {
    return NextResponse.json({
      error: 'invalid verdict-governance query',
      issues: parsedQuery.error.issues,
    }, { status: 400, headers: noStoreHeaders })
  }

  try {
    if (parsedQuery.data.decisionId) {
      const [decision, reviewHistory] = await Promise.all([
        getAutomaticQualityDecision(parsedQuery.data.decisionId),
        getQualityDecisionReviewHistory(parsedQuery.data.decisionId),
      ])
      if (!decision) {
        return NextResponse.json({ error: 'quality decision not found' }, { status: 404, headers: noStoreHeaders })
      }
      const postings = await postingContextsOf([decision])
      return NextResponse.json({
        audit: {
          decision: decisionSummary(decision, postings),
          reviewHistory,
        },
      }, { headers: noStoreHeaders })
    }

    const before = parsedQuery.data.beforeAt && parsedQuery.data.beforeId
      ? { occurredAt: new Date(parsedQuery.data.beforeAt), id: parsedQuery.data.beforeId }
      : undefined
    const [config, history, page] = await Promise.all([
      getJobsVerdictConfigSnapshot(),
      JobsVerdictConfigAudit.find({}).sort({ revision: -1 }).limit(25).lean(),
      listQualityDecisionPage({
        reviewStatuses: [parsedQuery.data.reviewStatus],
        limit: 50,
        ...(before ? { before } : {}),
      }),
    ])
    const postings = await postingContextsOf(page.items)
    return NextResponse.json({
      config,
      history: history.map((entry) => ({
        revision: entry.revision,
        action: entry.action,
        reason: entry.reason,
        actorUserId: String(entry.actorUserId),
        occurredAt: entry.occurredAt,
        to: entry.to,
      })),
      reviewStatus: parsedQuery.data.reviewStatus,
      decisions: page.items.map((decision) => decisionSummary(decision, postings)),
      ...(page.nextCursor ? { nextDecisionCursor: page.nextCursor } : {}),
    }, { headers: noStoreHeaders })
  } catch (error) {
    if (
      error instanceof JobsVerdictConfigMigrationRequiredError ||
      error instanceof JobsVerdictConfigRepairRequiredError
    ) {
      const code = error instanceof JobsVerdictConfigRepairRequiredError
        ? 'VERDICT_CONFIG_REPAIR_REQUIRED'
        : 'VERDICT_CONFIG_MIGRATION_REQUIRED'
      return NextResponse.json({ error: error.message, code }, { status: 503, headers: noStoreHeaders })
    }
    return NextResponse.json({ error: 'verdict governance is unavailable' }, { status: 500, headers: noStoreHeaders })
  }
}

export async function POST(req: Request) {
  const authorization = await authorizeMutation()
  if (!authorization.ok) {
    if (authorization.response) return authorization.response
    return NextResponse.json({ error: authorization.error }, { status: authorization.status, headers: noStoreHeaders })
  }

  const operationId = operationIdSchema.safeParse(req.headers.get('idempotency-key'))
  if (!operationId.success) {
    return NextResponse.json({ error: 'a UUID Idempotency-Key header is required' }, { status: 400, headers: noStoreHeaders })
  }
  let input: unknown
  try {
    input = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400, headers: noStoreHeaders })
  }
  const parsed = bodySchema.safeParse(input)
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid verdict-governance request', issues: parsed.error.issues }, { status: 400, headers: noStoreHeaders })
  }

  try {
    if (parsed.data.action === 'update-config') {
      const result = await updateJobsVerdictConfig({
        operationId: operationId.data,
        actorUserId: authorization.actorUserId,
        reason: parsed.data.reason,
        expectedRevision: parsed.data.expectedRevision,
        config: parsed.data.config,
      })
      return NextResponse.json({ ok: true, result }, { headers: noStoreHeaders })
    }
    if (parsed.data.action === 'rollback-config') {
      const result = await rollbackJobsVerdictConfig({
        operationId: operationId.data,
        actorUserId: authorization.actorUserId,
        reason: parsed.data.reason,
        expectedRevision: parsed.data.expectedRevision,
        targetRevision: parsed.data.targetRevision,
      })
      return NextResponse.json({ ok: true, result }, { headers: noStoreHeaders })
    }
    const reviewCommand = {
      operationId: operationId.data,
      decisionId: parsed.data.decisionId,
      action: parsed.data.resolution === 'confirmed' ? 'uphold' : 'restore',
      expectedReviewRevision: parsed.data.expectedReviewRevision,
      actorUserId: authorization.actorUserId,
      reason: parsed.data.reason,
    } as const
    const result = parsed.data.resolution === 'restored'
      ? await restoreDecision(reviewCommand)
      : await reviewQualityDecision(reviewCommand)
    return NextResponse.json({ ok: true, result }, { headers: noStoreHeaders })
  } catch (error) {
    if (error instanceof JobsVerdictConfigValidationError || error instanceof QualityDecisionValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400, headers: noStoreHeaders })
    }
    if (error instanceof JobsVerdictConfigRevisionNotFoundError || error instanceof QualityDecisionNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404, headers: noStoreHeaders })
    }
    if (error instanceof JobsVerdictConfigConflictError || error instanceof QualityDecisionConflictError) {
      return NextResponse.json({
        error: error.message,
        ...(error instanceof JobsVerdictConfigConflictError && error.currentRevision !== undefined
          ? { currentRevision: error.currentRevision }
          : {}),
      }, { status: 409, headers: noStoreHeaders })
    }
    if (
      error instanceof JobsVerdictConfigMigrationRequiredError ||
      error instanceof JobsVerdictConfigRepairRequiredError ||
      error instanceof JobsVerdictConfigTransactionsRequiredError ||
      error instanceof QualityDecisionTransactionsRequiredError
    ) {
      return NextResponse.json({ error: error.message, code: 'VERDICT_GOVERNANCE_UNAVAILABLE' }, { status: 503, headers: noStoreHeaders })
    }
    return NextResponse.json({ error: 'verdict-governance command failed' }, { status: 500, headers: noStoreHeaders })
  }
}
