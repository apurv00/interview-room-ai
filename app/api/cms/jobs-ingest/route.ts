import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { JobSourceConfig, JobIngestCycle, JobPosting, JobsVerdictConfig } from '@shared/db/models'
import {
  JOB_SOURCE_CONTROL_MAX_POSTINGS,
  JOB_SOURCE_CONTROL_WARN_POSTINGS,
} from '@jobs/config/sourceControlLimits'

export const dynamic = 'force-dynamic'

/**
 * GET /api/cms/jobs-ingest — dashboard data (score-telemetry pattern:
 * local admin gate, lean reads, stable documented JSON shape).
 */
async function requireAdmin() {
  const session = await getServerSession(authOptions)
  if (!session?.user) return { status: 401 as const }
  if ((session.user as { role?: string }).role !== 'platform_admin') return { status: 403 as const }
  return null
}

export async function GET() {
  const denied = await requireAdmin()
  if (denied) return NextResponse.json({ error: 'platform_admin required' }, { status: denied.status })

  await connectDB()
  const [sources, cycles, corpus, retainedPostings, verdictConfig, verdictCycles, verdictBacklog, verdictDist, tombstones] = await Promise.all([
    JobSourceConfig.find({}).select('-__v').lean(),
    JobIngestCycle.find({ kind: 'sync' }).sort({ createdAt: -1 }).limit(20).select('-__v').lean(),
    JobPosting.aggregate([
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
    JobPosting.countDocuments({}),
    JobsVerdictConfig.getConfig(),
    JobIngestCycle.find({ kind: 'llm-verdict' }).sort({ createdAt: -1 }).limit(20).select('-__v').lean(),
    JobPosting.countDocuments({ status: 'open', 'llmVerdict.status': 'pending' }),
    JobPosting.aggregate([
      { $match: { 'llmVerdict.status': 'scored' } },
      { $group: { _id: '$llmVerdict.verdict', n: { $sum: 1 } } },
    ]),
    JobPosting.countDocuments({ closedReason: 'llm-verdict' }),
  ])

  const corpusByStatus: Record<string, number> = {}
  for (const row of corpus as Array<{ _id: string; n: number }>) corpusByStatus[row._id] = row.n

  return NextResponse.json({
    sources: sources.map((s) => ({
      sourceId: s.sourceId,
      kind: s.kind,
      enabled: s.enabled,
      health: s.health,
      controlRevision: s.controlRevision ?? 0,
      lastControl: s.lastControl
        ? {
            revision: s.lastControl.revision,
            action: s.lastControl.action,
            at: s.lastControl.at,
          }
        : null,
      cadenceMinutes: s.cadenceMinutes,
      lastSyncAt: s.lastSyncAt ?? null,
    })),
    cycles: cycles.map((c) => ({
      sourceId: c.sourceId,
      startedAt: c.startedAt,
      finishedAt: c.finishedAt ?? null,
      fetched: c.fetched ?? 0,
      normalized: c.normalized ?? 0,
      driftNulls: c.driftNulls ?? 0,
      newCount: c.newCount ?? 0,
      merged: c.merged ?? 0,
      refreshed: c.refreshed ?? 0,
      storeErrors: c.storeErrors ?? 0,
      quotaSpent: c.quotaSpent ?? 0,
      drops: c.drops ?? {},
      healthTransitions: c.healthTransitions ?? [],
    })),
    corpus: {
      open: corpusByStatus.open ?? 0,
      closed: corpusByStatus.closed ?? 0,
      retained: retainedPostings,
      retainedWarningAt: JOB_SOURCE_CONTROL_WARN_POSTINGS,
      retainedLimit: JOB_SOURCE_CONTROL_MAX_POSTINGS,
      retainedHeadroom: JOB_SOURCE_CONTROL_MAX_POSTINGS - retainedPostings,
      retainedWarning: retainedPostings >= JOB_SOURCE_CONTROL_WARN_POSTINGS,
    },
    // LLM verdict panel (§4.6): shadow-exit criteria read from here.
    verdict: {
      config: verdictConfig,
      backlogPending: verdictBacklog,
      tombstones,
      distribution: Object.fromEntries((verdictDist as Array<{ _id: string; n: number }>).map((r) => [r._id, r.n])),
      cycles: verdictCycles.map((c) => ({
        startedAt: c.startedAt,
        finishedAt: c.finishedAt ?? null,
        llm: c.llm ?? null,
        healthTransitions: c.healthTransitions ?? [],
      })),
    },
  })
}

/**
 * PATCH /api/cms/jobs-ingest — edit the JobsVerdictConfig singleton (§4.5
 * rollout switches; DB rows, never env flags). platform_admin only; upserts
 * the single doc. `enforceEnabled` without `collectionEnabled` is rejected —
 * enforcement of verdicts nobody collects is a misconfiguration.
 */
export async function PATCH(req: Request) {
  const denied = await requireAdmin()
  if (denied) return NextResponse.json({ error: 'platform_admin required' }, { status: denied.status })

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 })
  }

  const set: Record<string, unknown> = {}
  const bools = ['collectionEnabled', 'enforceEnabled'] as const
  const nums = ['dailyVerdictCap', 'dailyBudgetUsd', 'monthlyBudgetUsd', 'perCompanyDailyCap', 'perSourceDailyCap', 'inputUsdPerMTok', 'outputUsdPerMTok'] as const
  for (const k of bools) if (typeof body[k] === 'boolean') set[k] = body[k]
  for (const k of nums) if (typeof body[k] === 'number' && body[k] >= 0 && Number.isFinite(body[k])) set[k] = body[k]
  if (typeof body.notes === 'string') set.notes = body.notes.slice(0, 2000)
  if (!Object.keys(set).length) return NextResponse.json({ error: 'no valid fields' }, { status: 400 })

  await connectDB()
  const current = await JobsVerdictConfig.getConfig()
  const next = { ...current, ...set }
  if (next.enforceEnabled && !next.collectionEnabled) {
    return NextResponse.json({ error: 'enforceEnabled requires collectionEnabled' }, { status: 400 })
  }
  await JobsVerdictConfig.updateOne({}, { $set: set }, { upsert: true })
  return NextResponse.json({ ok: true, config: next })
}
