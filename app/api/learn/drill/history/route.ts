import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { getDrillHistory } from '@learn/services/drillService'
import { logger } from '@shared/logger'

export const dynamic = 'force-dynamic'

/**
 * GET /api/learn/drill/history?competency=<dim>&limit=<n>
 *
 * Returns the authenticated user's recent drill attempts, optionally
 * filtered by competency. Used by `DeltaContextNote` (Pathway P2 Wave
 * 5 feature 5C) to compute the per-competency mean delta trend that
 * sits next to the +N badge after a drill submission.
 *
 * Both params are optional:
 *   - `competency`: when set, filter at the DB layer so the limit
 *     applies to relevant rows only.
 *   - `limit`: capped at 50 to keep payloads small (the UI only ever
 *     needs the most recent handful for trend aggregation).
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(req.url)
    const competency = searchParams.get('competency')?.trim() || undefined
    const requestedLimit = Number(searchParams.get('limit'))
    const limit =
      Number.isInteger(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, 50)
        : 20

    const attempts = await getDrillHistory(session.user.id, limit, competency)

    return NextResponse.json({ attempts })
  } catch (err) {
    logger.error({ err }, 'Failed to load drill history')
    return NextResponse.json({ attempts: [] })
  }
}
