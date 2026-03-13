import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { User, Organization, InterviewSession } from '@shared/db/models'

export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await connectDB()
  const user = await User.findById(session.user.id).select('role organizationId').lean()
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  if (!user.organizationId) {
    return NextResponse.json({ org: null, recentCandidates: [], stats: { totalCandidates: 0, completedInterviews: 0, avgScore: 0, pendingInvites: 0 } })
  }

  if (!['recruiter', 'org_admin', 'platform_admin'].includes(user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const [org, sessions] = await Promise.all([
    Organization.findById(user.organizationId).lean(),
    InterviewSession.find({
      organizationId: user.organizationId,
    }).sort({ createdAt: -1 }).limit(50).lean(),
  ])

  if (!org) {
    return NextResponse.json({ org: null, recentCandidates: [], stats: { totalCandidates: 0, completedInterviews: 0, avgScore: 0, pendingInvites: 0 } })
  }

  const completed = sessions.filter(s => s.status === 'completed')
  const pending = sessions.filter(s => s.status === 'created')
  const uniqueCandidates = new Set(sessions.map(s => s.candidateEmail).filter(Boolean))

  const avgScore = completed.length > 0
    ? Math.round(completed.reduce((sum, s) => sum + (s.feedback?.overall_score || 0), 0) / completed.length)
    : 0

  const recentCandidates = sessions.slice(0, 10).map(s => ({
    email: s.candidateEmail || '',
    name: s.candidateName || '',
    status: s.status,
    score: s.feedback?.overall_score,
    role: s.config?.role || 'unknown',
    completedAt: s.completedAt?.toISOString(),
  }))

  return NextResponse.json({
    org: {
      name: org.name,
      plan: org.plan,
      currentSeats: org.currentSeats,
      maxSeats: org.maxSeats,
      monthlyInterviewsUsed: org.monthlyInterviewsUsed,
      monthlyInterviewLimit: org.monthlyInterviewLimit,
    },
    recentCandidates,
    stats: {
      totalCandidates: uniqueCandidates.size,
      completedInterviews: completed.length,
      avgScore,
      pendingInvites: pending.length,
    },
  })
}
