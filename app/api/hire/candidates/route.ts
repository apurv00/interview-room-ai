import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/authOptions'
import { connectDB } from '@/lib/db/connection'
import { User, InterviewSession } from '@/lib/db/models'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await connectDB()
  const user = await User.findById(session.user.id).select('role organizationId').lean()
  if (!user?.organizationId || !['recruiter', 'org_admin', 'platform_admin'].includes(user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(req.url)
  const statusFilter = searchParams.get('status')
  const roleFilter = searchParams.get('role')
  const page = parseInt(searchParams.get('page') || '1', 10)
  const limit = 20

  const query: Record<string, unknown> = { organizationId: user.organizationId }
  if (statusFilter && ['created', 'in_progress', 'completed', 'abandoned'].includes(statusFilter)) {
    query.status = statusFilter
  }
  if (roleFilter) {
    query['config.role'] = roleFilter
  }

  const [sessions, total] = await Promise.all([
    InterviewSession.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    InterviewSession.countDocuments(query),
  ])

  const candidates = sessions.map(s => ({
    id: s._id.toString(),
    candidateEmail: s.candidateEmail || '',
    candidateName: s.candidateName || '',
    role: s.config?.role || '',
    interviewType: s.config?.interviewType || 'hr-screening',
    experience: s.config?.experience || '',
    status: s.status,
    overallScore: s.feedback?.overall_score ?? null,
    passProb: s.feedback?.pass_probability ?? null,
    strengths: s.feedback?.dimensions?.answer_quality?.strengths?.slice(0, 2) || [],
    weaknesses: s.feedback?.dimensions?.answer_quality?.weaknesses?.slice(0, 2) || [],
    redFlags: s.feedback?.red_flags?.slice(0, 3) || [],
    recruiterNotes: s.recruiterNotes || '',
    createdAt: s.createdAt.toISOString(),
    completedAt: s.completedAt?.toISOString() || null,
    durationSeconds: s.durationActualSeconds || null,
  }))

  return NextResponse.json({
    candidates,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  })
}
