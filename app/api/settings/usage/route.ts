import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/authOptions'
import { connectDB } from '@/lib/db/connection'
import { User } from '@/lib/db/models'

export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await connectDB()
  const user = await User.findById(session.user.id).select(
    'plan monthlyInterviewsUsed monthlyInterviewLimit planExpiresAt stripeCustomerId createdAt usageResetAt'
  )

  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  // Calculate reset date (1st of next month)
  const now = new Date()
  const resetDate = new Date(now.getFullYear(), now.getMonth() + 1, 1)

  return NextResponse.json({
    plan: user.plan,
    monthlyInterviewsUsed: user.monthlyInterviewsUsed,
    monthlyInterviewLimit: user.monthlyInterviewLimit,
    planExpiresAt: user.planExpiresAt?.toISOString() || null,
    hasStripeCustomer: !!user.stripeCustomerId,
    memberSince: user.createdAt.toISOString(),
    resetsAt: resetDate.toISOString(),
  })
}
