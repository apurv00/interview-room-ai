import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { ScoreTelemetry } from '@shared/db/models'
import { logger } from '@shared/logger'

/**
 * CMS admin-only score-telemetry dashboard backend (Work Item G.1).
 *
 * Returns aggregate statistics and a small histogram of the delta between
 * Claude's raw overall_score and the deterministic formula output. This
 * is the measurement surface that gates scoring-rebalance work (G.8+).
 *
 * Platform-admin only. Response shape is stable, documented in the page
 * component that renders it.
 */

export const dynamic = 'force-dynamic'

async function requireAdmin() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  if (session.user.role !== 'platform_admin') {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  return { session }
}

/** Bucketed histogram over a fixed [-50, 50] range in 10-point buckets. */
function bucketKey(delta: number): string {
  const clamped = Math.max(-50, Math.min(50, delta))
  const lo = Math.floor(clamped / 10) * 10
  return `${lo}..${lo + 10}`
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAdmin()
    if ('error' in auth && auth.error) return auth.error

    await connectDB()

    const sinceHours = Number(req.nextUrl.searchParams.get('hours') ?? '168')
    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000)

    const rows = await ScoreTelemetry.find({
      source: 'generate-feedback',
      createdAt: { $gte: since },
    })
      .select('claudeOverallScore deterministicOverallScore deltaOverall truncated recordReason modelUsed createdAt')
      .lean()

    // Aggregate stats. Only rows with both scores present count toward
    // the delta distribution — rows missing the Claude value are still
    // counted in the reason breakdown.
    const histogram: Record<string, number> = {}
    let withDelta = 0
    let deltaSum = 0
    let deltaAbsSum = 0
    let clauseHigher = 0
    let formulaHigher = 0

    const reasonCounts: Record<string, number> = {}
    const modelCounts: Record<string, number> = {}
    let truncatedCount = 0

    for (const r of rows) {
      reasonCounts[r.recordReason] = (reasonCounts[r.recordReason] ?? 0) + 1
      modelCounts[r.modelUsed] = (modelCounts[r.modelUsed] ?? 0) + 1
      if (r.truncated) truncatedCount++

      if (typeof r.deltaOverall === 'number') {
        withDelta++
        deltaSum += r.deltaOverall
        deltaAbsSum += Math.abs(r.deltaOverall)
        if (r.deltaOverall > 0) clauseHigher++
        else if (r.deltaOverall < 0) formulaHigher++
        const k = bucketKey(r.deltaOverall)
        histogram[k] = (histogram[k] ?? 0) + 1
      }
    }

    const avgDelta = withDelta > 0 ? Math.round((deltaSum / withDelta) * 10) / 10 : null
    const meanAbsDelta = withDelta > 0 ? Math.round((deltaAbsSum / withDelta) * 10) / 10 : null

    return NextResponse.json({
      windowHours: sinceHours,
      since: since.toISOString(),
      totalRows: rows.length,
      withDelta,
      avgDelta,
      meanAbsDelta,
      claudeHigherCount: clauseHigher,
      formulaHigherCount: formulaHigher,
      truncatedCount,
      reasonCounts,
      modelCounts,
      histogram,
    })
  } catch (err) {
    logger.error({ err }, 'CMS GET /score-telemetry error')
    return NextResponse.json({ error: 'Failed to fetch telemetry' }, { status: 500 })
  }
}
