import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { InterviewSession, User } from '@shared/db/models'
import { InterviewDepth } from '@shared/db/models/InterviewDepth'
import type { IInterviewSession } from '@shared/db/models'
import type { InterviewConfig, TranscriptEntry, AnswerEvaluation, SpeechMetrics, FeedbackData } from '@shared/types'
import { NotFoundError, ForbiddenError, UsageLimitError } from '@shared/errors'
import { canViewSession, canEditSession } from '@shared/auth/permissions'
import { FALLBACK_DEPTHS } from '@shared/db/seed'
import { logger } from '@shared/logger'

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
  /**
   * If set, the new session is a retake. The service resolves this id to
   * the root of the retake chain so every retake of the same original
   * session shares the same `parentSessionId`. `retakeNumber` is then
   * derived from the current max within that chain + 1.
   */
  parentSessionId?: string
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
  recordingR2Key?: string
  recordingSizeBytes?: number
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

  const now = new Date()
  const currentMonth = now.getMonth()
  const currentYear = now.getFullYear()

  // Monthly auto-reset: zero the counter if we're in a new month since last reset.
  // This runs before the atomic increment so the limit check uses fresh data.
  await User.updateOne(
    {
      _id: new mongoose.Types.ObjectId(input.userId),
      $or: [
        { usageResetAt: { $exists: false } },
        { $expr: { $ne: [{ $month: '$usageResetAt' }, currentMonth + 1] } },
        { $expr: { $ne: [{ $year: '$usageResetAt' }, currentYear] } },
      ],
    },
    { $set: { monthlyInterviewsUsed: 0, usageResetAt: now } }
  )

  // Development-phase backfill: ensure every user has the unlimited limit set.
  // Handles users created before the field was added (field missing in MongoDB)
  // and users with any limit below the uncapped default.
  await User.updateOne(
    {
      _id: new mongoose.Types.ObjectId(input.userId),
      $or: [
        { monthlyInterviewLimit: { $exists: false } },
        { monthlyInterviewLimit: null },
        { monthlyInterviewLimit: { $lt: 999999 } },
      ],
    },
    { $set: { monthlyInterviewLimit: 999999 } }
  )

  // Also ensure monthlyInterviewsUsed exists (for users created before this field)
  await User.updateOne(
    {
      _id: new mongoose.Types.ObjectId(input.userId),
      monthlyInterviewsUsed: { $exists: false },
    },
    { $set: { monthlyInterviewsUsed: 0 } }
  )

  // Atomic increment-first: check limit AND increment in a single operation.
  // Uses $expr to compare field values atomically — no race condition.
  const updatedUser = await User.findOneAndUpdate(
    {
      _id: new mongoose.Types.ObjectId(input.userId),
      $expr: { $lt: ['$monthlyInterviewsUsed', '$monthlyInterviewLimit'] },
    },
    {
      $inc: { monthlyInterviewsUsed: 1, interviewCount: 1 },
      $set: { lastInterviewAt: now },
    },
    { new: true }
  )

  if (!updatedUser) {
    // Either user doesn't exist or usage limit reached
    const exists = await User.exists({ _id: input.userId })
    if (!exists) throw new NotFoundError('User')
    throw new UsageLimitError()
  }

  // Look up scoring dimensions for this interview type
  let scoringDimensions: Array<{ name: string; label: string; weight: number }> | undefined
  const interviewType = input.config.interviewType || 'behavioral'
  try {
    const depth = await InterviewDepth.findOne({ slug: interviewType, isActive: true }).lean()
    if (depth?.scoringDimensions?.length) {
      scoringDimensions = depth.scoringDimensions
    }
  } catch { /* fallback below */ }
  if (!scoringDimensions) {
    const fallback = FALLBACK_DEPTHS.find(d => d.slug === interviewType)
    if (fallback?.scoringDimensions) scoringDimensions = fallback.scoringDimensions
  }

  // Resolve the retake chain root — if the caller passes a parent that is
  // itself a retake, we link to its root so the chain stays flat. We also
  // compute the next `retakeNumber` in that chain.
  let rootParentId: mongoose.Types.ObjectId | undefined
  let retakeNumber: number | undefined
  if (input.parentSessionId) {
    try {
      const parent = await InterviewSession.findById(input.parentSessionId)
        .select('_id parentSessionId userId')
        .lean()
      if (parent && parent.userId.toString() === input.userId) {
        rootParentId = (parent.parentSessionId as mongoose.Types.ObjectId | undefined) ||
          (parent._id as mongoose.Types.ObjectId)
        const maxInChain = await InterviewSession.findOne({
          userId: new mongoose.Types.ObjectId(input.userId),
          parentSessionId: rootParentId,
        })
          .select('retakeNumber')
          .sort({ retakeNumber: -1 })
          .lean()
        retakeNumber = ((maxInChain?.retakeNumber as number | undefined) || 0) + 1
      }
    } catch {
      // If lookup fails we simply skip the retake linkage rather than
      // blocking session creation — retake is an enhancement, not a gate.
      rootParentId = undefined
      retakeNumber = undefined
    }
  }

  let session: IInterviewSession
  try {
    session = await InterviewSession.create({
      userId: new mongoose.Types.ObjectId(input.userId),
      organizationId: input.organizationId
        ? new mongoose.Types.ObjectId(input.organizationId)
        : undefined,
      config: input.config,
      status: 'created',
      scoringDimensions,
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
      // Privacy mode — promoted from config to a top-level field so it can
      // be queried/audited independently of the nested config blob.
      privacyMode: input.config.privacyMode === true ? true : undefined,
      parentSessionId: rootParentId,
      retakeNumber,
    })
  } catch (err) {
    // Rollback the usage increment if session creation fails
    await User.findByIdAndUpdate(input.userId, {
      $inc: { monthlyInterviewsUsed: -1, interviewCount: -1 },
    })
    throw err
  }

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

  if (!canEditSession(
    { userId: session.userId.toString(), organizationId: session.organizationId?.toString() },
    { id: userId, role, organizationId }
  )) {
    throw new ForbiddenError('You do not have permission to edit this session')
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
  if (input.recordingR2Key) updateFields.recordingR2Key = input.recordingR2Key
  if (input.recordingSizeBytes !== undefined) updateFields.recordingSizeBytes = input.recordingSizeBytes

  const updated = await InterviewSession.findByIdAndUpdate(sessionId, updateFields, { new: true })
  if (!updated) throw new NotFoundError('Interview session')

  logger.info({ sessionId, status: input.status }, 'Interview session updated')

  return updated
}

export async function getSession(
  sessionId: string,
  userId: string,
  role: string,
  organizationId: string | undefined,
  options?: { excludeTranscript?: boolean }
): Promise<IInterviewSession> {
  await connectDB()

  let query = InterviewSession.findById(sessionId)
  if (options?.excludeTranscript) {
    query = query.select('-transcript')
  }
  const session = await query
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
