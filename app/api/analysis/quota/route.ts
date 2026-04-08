import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { MultimodalAnalysis } from '@shared/db/models/MultimodalAnalysis'
import { getPlanLimits } from '@shared/services/stripe'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await connectDB()

  const monthStart = new Date()
  monthStart.setDate(1)
  monthStart.setHours(0, 0, 0, 0)

  // A "consumed" analysis is either completed, OR pending/processing AND
  // started recently (within the last 10 minutes). Anything older than 10
  // minutes that hasn't reached completed/failed is treated as abandoned —
  // counting it would permanently lock the user out due to a stuck job.
  const STALE_PENDING_CUTOFF_MS = 10 * 60 * 1000
  const staleCutoff = new Date(Date.now() - STALE_PENDING_CUTOFF_MS)

  const used = await MultimodalAnalysis.countDocuments({
    userId: session.user.id,
    createdAt: { $gte: monthStart },
    $or: [
      { status: 'completed' },
      { status: { $in: ['pending', 'processing'] }, createdAt: { $gte: staleCutoff } },
    ],
  })

  const plan = session.user.plan || 'free'
  const limits = getPlanLimits(plan)

  return NextResponse.json({
    used,
    limit: limits.monthlyAnalysisLimit,
    remaining: Math.max(0, limits.monthlyAnalysisLimit - used),
    plan,
  })
}
