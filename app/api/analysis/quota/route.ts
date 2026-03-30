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

  const used = await MultimodalAnalysis.countDocuments({
    userId: session.user.id,
    createdAt: { $gte: monthStart },
    status: { $in: ['completed', 'processing', 'pending'] },
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
