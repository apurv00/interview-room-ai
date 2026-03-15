import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { computeComparison } from '@learn/services/comparisonService'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(req.url)
    const domain = searchParams.get('domain') || undefined

    // Current scores passed as query params
    const relevance = Number(searchParams.get('relevance') || 0)
    const structure = Number(searchParams.get('structure') || 0)
    const specificity = Number(searchParams.get('specificity') || 0)
    const ownership = Number(searchParams.get('ownership') || 0)
    const overall = Number(searchParams.get('overall') || 0)

    const currentScores: Record<string, number> = { relevance, structure, specificity, ownership }

    const comparison = await computeComparison(session.user.id, currentScores, overall, domain)

    return NextResponse.json(comparison)
  } catch {
    return NextResponse.json({ dimensions: [], overallDelta: null, overallDirection: 'new', sessionsCompared: 0, sinceFirstDelta: null })
  }
}
