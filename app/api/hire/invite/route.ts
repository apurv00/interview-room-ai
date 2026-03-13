import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { User, Organization, InterviewSession, InterviewTemplate } from '@shared/db/models'
import { z } from 'zod'
import crypto from 'crypto'

export const dynamic = 'force-dynamic'

const InviteSchema = z.object({
  candidateEmail: z.string().email().max(200),
  candidateName: z.string().max(200).optional(),
  role: z.string().min(1).max(50),
  interviewType: z.string().min(1).max(50).default('hr-screening'),
  experience: z.enum(['0-2', '3-6', '7+']).default('3-6'),
  duration: z.union([z.literal(10), z.literal(20), z.literal(30)]).default(20),
  templateId: z.string().optional(),
  recruiterNotes: z.string().max(1000).optional(),
  jobDescription: z.string().max(50000).optional(),
})

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await connectDB()
  const user = await User.findById(session.user.id).select('role organizationId').lean()
  if (!user?.organizationId || !['recruiter', 'org_admin', 'platform_admin'].includes(user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json()
  const parsed = InviteSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid data', details: parsed.error.flatten() }, { status: 400 })
  }

  const org = await Organization.findById(user.organizationId).lean()
  if (!org) {
    return NextResponse.json({ error: 'Organization not found' }, { status: 404 })
  }

  // Check usage limits
  if (org.monthlyInterviewsUsed >= org.monthlyInterviewLimit) {
    return NextResponse.json({ error: 'Monthly interview limit reached' }, { status: 429 })
  }

  const { candidateEmail, candidateName, role, interviewType, experience, duration, templateId, recruiterNotes, jobDescription } = parsed.data

  // Create interview session for the candidate
  const interviewSession = await InterviewSession.create({
    userId: user._id, // placeholder, will be updated when candidate takes the interview
    organizationId: user.organizationId,
    config: { role, interviewType, experience, duration, ...(jobDescription && { jobDescription }) },
    ...(jobDescription && { jobDescription }),
    status: 'created',
    candidateEmail: candidateEmail.toLowerCase(),
    candidateName,
    recruiterNotes,
    templateId: templateId || undefined,
  })

  // Generate invite token
  const token = crypto.randomBytes(32).toString('hex')

  // In production, you'd send an email here. For now, return the invite link.
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://interviewprep.guru'
  const inviteLink = `${baseUrl}/interview?invite=${interviewSession._id}&token=${token}`

  // Increment org usage
  await Organization.findByIdAndUpdate(user.organizationId, {
    $inc: { monthlyInterviewsUsed: 1 },
  })

  return NextResponse.json({
    success: true,
    sessionId: interviewSession._id.toString(),
    inviteLink,
    candidateEmail,
  })
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await connectDB()
  const user = await User.findById(session.user.id).select('role organizationId').lean()
  if (!user?.organizationId || !['recruiter', 'org_admin', 'platform_admin'].includes(user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const pendingInvites = await InterviewSession.find({
    organizationId: user.organizationId,
    status: 'created',
    candidateEmail: { $exists: true },
  }).sort({ createdAt: -1 }).limit(50).lean()

  return NextResponse.json({
    invites: pendingInvites.map(s => ({
      id: s._id.toString(),
      candidateEmail: s.candidateEmail,
      candidateName: s.candidateName,
      role: s.config?.role,
      interviewType: s.config?.interviewType,
      createdAt: s.createdAt.toISOString(),
      status: s.status,
    })),
  })
}
