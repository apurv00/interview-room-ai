import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { computeComparison } from '@learn/services/comparisonService'
import { connectDB } from '@shared/db/connection'
import { isJobsAccountActive } from '@shared/services/jobsAccountFence'

export const dynamic = 'force-dynamic'

function accountUnavailable() {
  return NextResponse.json(
    { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
    { status: 401 },
  )
}

export async function GET(req: Request) {
  let requesterUserId: string | undefined
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    requesterUserId = session.user.id

    await connectDB()
    if (!(await isJobsAccountActive(session.user.id))) {
      return accountUnavailable()
    }

    const { searchParams } = new URL(req.url)
    const domain = searchParams.get('domain') || undefined
    const parentSessionId = searchParams.get('parentSessionId') || undefined

    // Current scores passed as query params
    const relevance = Number(searchParams.get('relevance') || 0)
    const structure = Number(searchParams.get('structure') || 0)
    const specificity = Number(searchParams.get('specificity') || 0)
    const ownership = Number(searchParams.get('ownership') || 0)
    const overall = Number(searchParams.get('overall') || 0)

    const currentScores: Record<string, number> = { relevance, structure, specificity, ownership }

    const comparison = await computeComparison(session.user.id, currentScores, overall, domain, parentSessionId)

    if (!(await isJobsAccountActive(session.user.id))) {
      return accountUnavailable()
    }

    return NextResponse.json(comparison)
  } catch {
    if (requesterUserId) {
      try {
        if (!(await isJobsAccountActive(requesterUserId))) {
          return accountUnavailable()
        }
      } catch {
        // Preserve the route's existing neutral fallback on lookup failure.
      }
    }
    return NextResponse.json({ dimensions: [], overallDelta: null, overallDirection: 'new', sessionsCompared: 0, sinceFirstDelta: null, comparisonMode: 'history' })
  }
}
