import mongoose from 'mongoose'
import { connectDB } from '@/lib/db/connection'
import { InterviewSession, User } from '@/lib/db/models'
import type { IInterviewSession } from '@/lib/db/models'
import type { InterviewConfig, TranscriptEntry, AnswerEvaluation, SpeechMetrics, FeedbackData } from '@/lib/types'
import { NotFoundError, ForbiddenError, UsageLimitError } from '@/lib/errors'
import { canViewSession } from '@/lib/auth/permissions'
import { logger } from '@/lib/logger'

interface CreateSessionInput {
  userId: string
  organizationId?: string
  config: InterviewConfig
  templateId?: string
  candidateEmail?: string
  candidateName?: string
  userAgent?: string
  jobDescription?: string
  resumeText?: string
  jdFileName?: string
  resumeFileName?: string
}

interface UpdateSessionInput {
  status?: 'created' | 'in_progress' | 'completed' | 'abandoned'
  transcript?: TranscriptEntry[]
  evaluations?: AnswerEvaluation[]
  speechMetrics?: SpeechMetrics[]
  feedback?: FeedbackData
  durationActualSeconds?: number
  startedAt?: string
  completedAt?: string
}

interface ListSessionsInput {
  userId: string
  organizationId?: string
  role: string
  page?: number
  limit?: number
  status?: string
}

export async function createSession(input: CreateSessionInput): Promise<IInterviewSession> {
  await connectDB()

  // Check usage limits
  const user = await User.findById(input.userId)
  if (!user) throw new NotFoundError('User')

  // Monthly auto-reset: if we're in a new month since last reset, zero the counter
  const now = new Date()
  const lastResetRaw = user.usageResetAt || user.createdAt
  const lastReset = lastResetRaw ? new Date(lastResetRaw) : now
  if (lastReset.getMonth() !== now.getMonth() || lastReset.getFullYear() !== now.getFullYear()) {
    user.monthlyInterviewsUsed = 0
    user.usageResetAt = now
    await user.save()
    logger.info({ userId: input.userId }, 'Monthly usage counter reset')
  }

  // Enforce limit for ALL plans (enterprise has limit 999999 so effectively unlimited)
  if (user.monthlyInterviewsUsed >= user.monthlyInterviewLimit) {
    throw new UsageLimitError()
  }

  const session = await InterviewSession.create({
    userId: new mongoose.Types.ObjectId(input.userId),
    organizationId: input.organizationId
      ? new mongoose.Types.ObjectId(input.organizationId)
      : undefined,
    config: input.config,
    status: 'created',
    templateId: input.templateId
      ? new mongoose.Types.ObjectId(input.templateId)
      : undefined,
    candidateEmail: input.candidateEmail,
    candidateName: input.candidateName,
    userAgent: input.userAgent,
    jobDescription: input.jobDescription,
    resumeText: input.resumeText,
    jdFileName: input.jdFileName,
    resumeFileName: input.resumeFileName,
  })

  // Increment usage
  await User.findByIdAndUpdate(input.userId, {
    $inc: { monthlyInterviewsUsed: 1, interviewCount: 1 },
    $set: { lastInterviewAt: new Date() },
  })

  logger.info({ sessionId: session._id, userId: input.userId }, 'Interview session created')

  return session
}

export async function updateSession(
  sessionId: string,
  userId: string,
  role: string,
  organizationId: string | undefined,
  input: UpdateSessionInput
): Promise<IInterviewSession> {
  await connectDB()

  const session = await InterviewSession.findById(sessionId)
  if (!session) throw new NotFoundError('Interview session')

  if (!canViewSession(
    { userId: session.userId.toString(), organizationId: session.organizationId?.toString() },
    { id: userId, role, organizationId }
  )) {
    throw new ForbiddenError('You do not have access to this session')
  }

  const updateFields: Record<string, unknown> = {}
  if (input.status) updateFields.status = input.status
  if (input.transcript) updateFields.transcript = input.transcript
  if (input.evaluations) updateFields.evaluations = input.evaluations
  if (input.speechMetrics) updateFields.speechMetrics = input.speechMetrics
  if (input.feedback) updateFields.feedback = input.feedback
  if (input.durationActualSeconds !== undefined) updateFields.durationActualSeconds = input.durationActualSeconds
  if (input.startedAt) updateFields.startedAt = new Date(input.startedAt)
  if (input.completedAt) updateFields.completedAt = new Date(input.completedAt)

  const updated = await InterviewSession.findByIdAndUpdate(sessionId, updateFields, { new: true })
  if (!updated) throw new NotFoundError('Interview session')

  logger.info({ sessionId, status: input.status }, 'Interview session updated')

  return updated
}

export async function getSession(
  sessionId: string,
  userId: string,
  role: string,
  organizationId: string | undefined
): Promise<IInterviewSession> {
  await connectDB()

  const session = await InterviewSession.findById(sessionId)
  if (!session) throw new NotFoundError('Interview session')

  if (!canViewSession(
    { userId: session.userId.toString(), organizationId: session.organizationId?.toString() },
    { id: userId, role, organizationId }
  )) {
    throw new ForbiddenError('You do not have access to this session')
  }

  return session
}

export async function listSessions(input: ListSessionsInput) {
  await connectDB()

  const page = input.page || 1
  const limit = Math.min(input.limit || 20, 50)
  const skip = (page - 1) * limit

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filter: any = {}

  // If recruiter/admin, show org sessions; otherwise show own sessions
  if (input.organizationId && ['recruiter', 'org_admin', 'platform_admin'].includes(input.role)) {
    filter.organizationId = new mongoose.Types.ObjectId(input.organizationId)
  } else {
    filter.userId = new mongoose.Types.ObjectId(input.userId)
  }

  if (input.status) {
    filter.status = input.status
  }

  const [sessions, total] = await Promise.all([
    InterviewSession.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('-transcript -evaluations -speechMetrics')
      .lean(),
    InterviewSession.countDocuments(filter),
  ])

  return {
    sessions,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  }
}
