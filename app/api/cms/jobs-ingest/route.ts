import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { JobSourceConfig, JobIngestCycle, JobPosting } from '@shared/db/models'

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
  const [sources, cycles, corpus] = await Promise.all([
    JobSourceConfig.find({}).select('-__v').lean(),
    JobIngestCycle.find({ kind: 'sync' }).sort({ createdAt: -1 }).limit(20).select('-__v').lean(),
    JobPosting.aggregate([
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
  ])

  const corpusByStatus: Record<string, number> = {}
  for (const row of corpus as Array<{ _id: string; n: number }>) corpusByStatus[row._id] = row.n

  return NextResponse.json({
    sources: sources.map((s) => ({
      sourceId: s.sourceId,
      kind: s.kind,
      enabled: s.enabled,
      health: s.health,
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
      quotaSpent: c.quotaSpent ?? 0,
      drops: c.drops ?? {},
      healthTransitions: c.healthTransitions ?? [],
    })),
    corpus: {
      open: corpusByStatus.open ?? 0,
      closed: corpusByStatus.closed ?? 0,
    },
  })
}
