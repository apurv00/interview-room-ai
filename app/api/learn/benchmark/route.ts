import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { getPeerBenchmark } from '@learn/services/benchmarkService'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(req.url)
    const domain = searchParams.get('domain') || undefined
    const interviewType = searchParams.get('interviewType') || undefined
    const overall = Number(searchParams.get('overall') || 0)
    const relevance = Number(searchParams.get('relevance') || 0)
    const structure = Number(searchParams.get('structure') || 0)
    const specificity = Number(searchParams.get('specificity') || 0)
    const ownership = Number(searchParams.get('ownership') || 0)

    const result = await getPeerBenchmark(
      session.user.id,
      overall,
      { relevance, structure, specificity, ownership },
      domain,
      interviewType,
    )

    return NextResponse.json(result)
  } catch {
    return NextResponse.json({
      available: false,
      peerCount: 0,
      overallPercentile: null,
      overallAvg: null,
      dimensionPercentiles: [],
      distribution: [],
    })
  }
}
