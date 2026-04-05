import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { User, Organization, InterviewSession, InterviewTemplate } from '@shared/db/models'
import { sendEmail } from '@shared/services/emailService'
import type { Duration } from '@shared/types'
import crypto from 'crypto'

type OrgId = mongoose.Types.ObjectId | string

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HireUser {
  _id: OrgId
  role: string
  organizationId?: OrgId
}

export interface DashboardStats {
  totalCandidates: number
  completedInterviews: number
  avgScore: number
  pendingInvites: number
}

export interface CandidateListItem {
  id: string
  candidateEmail: string
  candidateName: string
  role: string
  interviewType: string
  experience: string
  status: string
  overallScore: number | null
  passProb: string | number | null
  strengths: string[]
  weaknesses: string[]
  redFlags: string[]
  recruiterNotes: string
  createdAt: string
  completedAt: string | null
  durationSeconds: number | null
}

// ─── Auth Helper ────────────────────────────────────────────────────────────

const RECRUITER_ROLES = ['recruiter', 'org_admin', 'platform_admin']
const ADMIN_ROLES = ['org_admin', 'platform_admin']

export async function getHireUser(userId: string): Promise<HireUser | null> {
  await connectDB()
  return User.findById(userId).select('role organizationId').lean()
}

export function isRecruiter(user: HireUser): user is HireUser & { organizationId: OrgId } {
  return !!user.organizationId && RECRUITER_ROLES.includes(user.role)
}

export function isOrgAdmin(user: HireUser): user is HireUser & { organizationId: OrgId } {
  return !!user.organizationId && ADMIN_ROLES.includes(user.role)
}

// ─── Dashboard ──────────────────────────────────────────────────────────────

export async function getDashboardData(organizationId: OrgId) {
  const [org, sessions] = await Promise.all([
    Organization.findById(organizationId).lean(),
    InterviewSession.find({ organizationId }).sort({ createdAt: -1 }).limit(50).lean(),
  ])

  if (!org) {
    return { org: null, recentCandidates: [], stats: { totalCandidates: 0, completedInterviews: 0, avgScore: 0, pendingInvites: 0 } }
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

  return {
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
    } as DashboardStats,
  }
}

// ─── Candidates ─────────────────────────────────────────────────────────────

export async function listCandidates(
  organizationId: OrgId,
  filters: { status?: string; role?: string; page?: number }
) {
  const limit = 20
  const page = filters.page || 1

  const query: Record<string, unknown> = { organizationId }
  if (filters.status && ['created', 'in_progress', 'completed', 'abandoned'].includes(filters.status)) {
    query.status = filters.status
  }
  if (filters.role) {
    query['config.role'] = filters.role
  }

  const [sessions, total] = await Promise.all([
    InterviewSession.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    InterviewSession.countDocuments(query),
  ])

  const candidates: CandidateListItem[] = sessions.map(s => ({
    id: s._id.toString(),
    candidateEmail: s.candidateEmail || '',
    candidateName: s.candidateName || '',
    role: s.config?.role || '',
    interviewType: s.config?.interviewType || 'screening',
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

  return {
    candidates,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  }
}

// ─── Invites ────────────────────────────────────────────────────────────────

const INVITE_TOKEN_EXPIRY_DAYS = 7

export async function createInvite(
  userId: OrgId,
  organizationId: OrgId,
  data: {
    candidateEmail: string
    candidateName?: string
    role: string
    interviewType: string
    experience: string
    duration: Duration
    templateId?: string
    recruiterNotes?: string
    jobDescription?: string
  }
) {
  // Atomic quota check + increment (prevents race condition)
  const updatedOrg = await Organization.findOneAndUpdate(
    {
      _id: organizationId,
      $expr: { $lt: ['$monthlyInterviewsUsed', '$monthlyInterviewLimit'] },
    },
    { $inc: { monthlyInterviewsUsed: 1 } },
    { new: true }
  )

  if (!updatedOrg) {
    const exists = await Organization.exists({ _id: organizationId })
    if (!exists) return { error: 'Organization not found', status: 404 }
    return { error: 'Monthly interview limit reached', status: 429 }
  }

  const { candidateEmail, candidateName, role, interviewType, experience, duration, templateId, recruiterNotes, jobDescription } = data

  // Generate invite token and store its hash for verification
  const token = crypto.randomBytes(32).toString('hex')
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  const tokenExpiry = new Date(Date.now() + INVITE_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000)

  const interviewSession = await InterviewSession.create({
    userId,
    organizationId,
    config: { role, interviewType, experience, duration, ...(jobDescription && { jobDescription }) },
    ...(jobDescription && { jobDescription }),
    status: 'created',
    candidateEmail: candidateEmail.toLowerCase(),
    candidateName,
    recruiterNotes,
    templateId: templateId || undefined,
    inviteTokenHash: tokenHash,
    inviteTokenExpiry: tokenExpiry,
  })

  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://interviewprep.guru'
  const inviteLink = `${baseUrl}/interview?invite=${interviewSession._id}&token=${token}`

  // Send invite email to the candidate (fire-and-forget — don't block on email failure)
  const emailSent = await sendEmail({
    to: candidateEmail.toLowerCase(),
    subject: `You've been invited to an interview — ${role} (${interviewType})`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px;">
        <h2 style="color: #0f1419; margin: 0 0 16px;">You're Invited to Interview</h2>
        ${candidateName ? `<p style="color: #536471; margin: 0 0 12px;">Hi ${candidateName},</p>` : ''}
        <p style="color: #536471; margin: 0 0 24px;">
          You've been invited to complete a <strong>${interviewType}</strong> interview for the
          <strong>${role}</strong> role${experience ? ` (${experience} years experience)` : ''}.
          The interview will take approximately <strong>${duration} minutes</strong>.
        </p>
        <a href="${inviteLink}" style="display: inline-block; background: #6366f1; color: #fff; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 600;">
          Start Interview
        </a>
        <p style="color: #8b98a5; font-size: 13px; margin: 24px 0 0;">
          This link expires in 7 days. If you have questions, please contact your recruiter directly.
        </p>
      </div>
    `,
  }).catch(() => false)

  return {
    success: true,
    sessionId: interviewSession._id.toString(),
    inviteLink,
    candidateEmail,
    emailSent,
  }
}

/**
 * Verify an invite token against the stored hash.
 * Returns true if the token is valid and not expired.
 */
export async function verifyInviteToken(sessionId: string, token: string): Promise<boolean> {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  const session = await InterviewSession.findOne({
    _id: sessionId,
    inviteTokenHash: tokenHash,
    inviteTokenExpiry: { $gt: new Date() },
  }).lean()
  return !!session
}

export async function listPendingInvites(organizationId: OrgId) {
  const pendingInvites = await InterviewSession.find({
    organizationId,
    status: 'created',
    candidateEmail: { $exists: true },
  }).sort({ createdAt: -1 }).limit(50).lean()

  return {
    invites: pendingInvites.map(s => ({
      id: s._id.toString(),
      candidateEmail: s.candidateEmail,
      candidateName: s.candidateName,
      role: s.config?.role,
      interviewType: s.config?.interviewType,
      createdAt: s.createdAt.toISOString(),
      status: s.status,
    })),
  }
}

// ─── Org Management ─────────────────────────────────────────────────────────

export async function createOrg(userId: string, data: { name: string; slug: string; domain?: string }) {
  await connectDB()
  const user = await User.findById(userId).lean()
  if (!user) return { error: 'User not found', status: 404 }
  if (user.organizationId) return { error: 'Already in an organization', status: 400 }

  const existing = await Organization.findOne({ slug: data.slug }).lean()
  if (existing) return { error: 'Organization slug already taken', status: 409 }

  const org = await Organization.create({
    name: data.name,
    slug: data.slug,
    domain: data.domain,
    createdBy: user._id,
    plan: 'starter',
    maxSeats: 5,
    currentSeats: 1,
    monthlyInterviewLimit: 100,
  })

  await User.findByIdAndUpdate(userId, {
    $set: { organizationId: org._id, role: 'org_admin' },
  })

  return {
    success: true,
    organization: { id: org._id.toString(), name: org.name, slug: org.slug },
  }
}

export async function getOrg(organizationId: OrgId) {
  const [org, teamCount] = await Promise.all([
    Organization.findById(organizationId).lean(),
    User.countDocuments({ organizationId }),
  ])

  if (!org) return { organization: null }

  return {
    organization: {
      id: org._id.toString(),
      name: org.name,
      slug: org.slug,
      domain: org.domain,
      plan: org.plan,
      maxSeats: org.maxSeats,
      currentSeats: teamCount,
      monthlyInterviewLimit: org.monthlyInterviewLimit,
      monthlyInterviewsUsed: org.monthlyInterviewsUsed,
      settings: org.settings,
    },
  }
}

export async function updateOrgSettings(
  organizationId: OrgId,
  data: { name?: string; settings?: Record<string, unknown> }
) {
  const update: Record<string, unknown> = {}
  if (data.name) update.name = data.name
  if (data.settings) {
    for (const [key, val] of Object.entries(data.settings)) {
      if (val !== undefined) update[`settings.${key}`] = val
    }
  }

  await Organization.findByIdAndUpdate(organizationId, { $set: update })
  return { success: true }
}

// ─── Templates ──────────────────────────────────────────────────────────────

export async function listTemplates(organizationId: OrgId) {
  const templates = await InterviewTemplate.find({ organizationId })
    .sort({ createdAt: -1 }).lean()

  return {
    templates: templates.map(t => ({
      id: t._id.toString(),
      name: t.name,
      description: t.description || '',
      role: t.role,
      experienceLevel: t.experienceLevel,
      questionCount: t.questions?.length || 0,
      duration: t.settings?.duration || 10,
      isActive: t.isActive,
      createdAt: t.createdAt.toISOString(),
    })),
  }
}

export async function createTemplate(
  organizationId: OrgId,
  createdBy: OrgId,
  data: {
    name: string
    description?: string
    role: string
    experienceLevel?: string
    questions?: Array<{ text: string; category?: string; difficulty?: string }>
    settings?: { duration?: number; questionCount?: number }
  }
) {
  const template = await InterviewTemplate.create({
    organizationId,
    name: data.name,
    description: data.description,
    role: data.role,
    experienceLevel: data.experienceLevel,
    questions: data.questions || [],
    settings: {
      duration: data.settings?.duration || 10,
      questionCount: data.questions?.length || 6,
      allowFollowUps: true,
    },
    createdBy,
  })

  return {
    success: true,
    template: { id: template._id.toString(), name: template.name },
  }
}
