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
import { parseJobDescription, buildParsedJDContext } from '../persona/jdParserService'
import { parseAndCacheResume, buildParsedResumeContext } from '../persona/resumeContextService'
import { setCachedJDContext, setCachedResumeContext } from '../persona/documentContextCache'
import { warmSessionConfigCache } from './sessionConfigCache'
import { getPlannedQuestionCountForFeedback } from '../eval/sessionScoringPolicy'
import type { InterviewLatencyTelemetryInput } from '../../validators/interview'
import type { Duration } from '@shared/types'

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
  recordingDurationSeconds?: number
  screenRecordingR2Key?: string
  screenRecordingSizeBytes?: number
  audioRecordingR2Key?: string
  audioRecordingSizeBytes?: number
  liveTranscriptWords?: Array<{
    word: string
    start: number
    end: number
    confidence: number
  }>
  codingProblemId?: string
  designProblemId?: string
  scoringDimensions?: Array<{ name: string; label: string; weight: number }>
  plannedQuestionCount?: number
  answeredCount?: number
  endReason?: 'normal' | 'time_up' | 'user_ended' | 'usage_limit' | 'abandoned'
  wasTruncatedByTimer?: boolean[]
  interviewLatencyTelemetry?: InterviewLatencyTelemetryInput
}

interface ListSessionsInput {
  userId: string
  organizationId?: string
  role: string
  page?: number
  limit?: number
  status?: string
}

/**
 * Whether a depth may run at a given experience band. Experience-restricted built-in
 * depths (e.g. academics → ['0-2']) are gated; depths with no restriction (empty list)
 * run at any band. Data-driven from FALLBACK_DEPTHS so it tracks the seed automatically.
 * Unknown (CMS) depths default to allowed.
 */
export function isDepthAllowedForExperience(depthSlug: string, experience: string): boolean {
  const depth = FALLBACK_DEPTHS.find(d => d.slug === depthSlug)
  const exps = depth?.applicableExperience ?? []
  return exps.length === 0 || exps.includes(experience)
}

export async function createSession(input: CreateSessionInput): Promise<IInterviewSession> {
  await connectDB()

  // Server-side experience gate: an experience-restricted depth (academics → 0-2) must
  // NOT run on the wrong band even if a tampered client config or a direct API call
  // bypasses the UI gate. Checked before the usage increment so a rejected attempt costs
  // the user no monthly credit.
  const requestedDepth = input.config.interviewType || 'behavioral'
  if (!isDepthAllowedForExperience(requestedDepth, input.config.experience)) {
    throw new ForbiddenError(
      `The "${requestedDepth}" interview type is not available for the ${input.config.experience} experience level.`,
    )
  }

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
    { returnDocument: 'after' }
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

  // G.7: capture the planned question count at creation time so generate-feedback can later compute
  // answered/planned completion ratio. TYPE-AWARE (coding/system-design use their 1-2 submission budget,
  // not getQuestionCount) so the persisted value matches what feedback scores against — otherwise a
  // coding session stores 30 and looks incomplete. Falls back gracefully for out-of-band durations so
  // session creation never fails.
  let plannedQuestionCount: number | undefined
  try {
    plannedQuestionCount = getPlannedQuestionCountForFeedback(
      input.config.interviewType,
      input.config.duration as Duration,
    )
  } catch {
    plannedQuestionCount = undefined
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
      // Jobs attribution — promoted for the same reason (the config subdoc
      // strips unknown keys). attributionRoundTrip.test.ts trips if this
      // line is removed.
      attribution: input.config.attribution,
      parentSessionId: rootParentId,
      retakeNumber,
      plannedQuestionCount,
    })
  } catch (err) {
    // Rollback the usage increment if session creation fails
    await User.findByIdAndUpdate(input.userId, {
      $inc: { monthlyInterviewsUsed: -1, interviewCount: -1 },
    })
    throw err
  }

  logger.info({ sessionId: session._id, userId: input.userId }, 'Interview session created')

  // ── Document Intelligence Layer ────────────────────────────────────────
  // Parse JD + resume in parallel so the runtime loop (generate-question /
  // evaluate-answer) can send compact, importance-ranked context instead of
  // a raw .slice(0, 2500) of the source text. Parse failures are NON-FATAL —
  // the on-demand fallback in `documentContextCache` handles the gap.
  if (input.jobDescription || input.resumeText) {
    const sid = (session._id as mongoose.Types.ObjectId).toString()
    const domain = input.config.role
    try {
      const [jdResult, resumeResult] = await Promise.allSettled([
        input.jobDescription ? parseJobDescription(input.jobDescription) : Promise.resolve(null),
        input.resumeText ? parseAndCacheResume(sid, input.resumeText, domain) : Promise.resolve(null),
      ])

      const update: Record<string, unknown> = {}

      if (jdResult.status === 'fulfilled' && jdResult.value && jdResult.value.requirements?.length) {
        update.parsedJobDescription = jdResult.value
        const ctx = buildParsedJDContext(jdResult.value)
        if (ctx) {
          try { await setCachedJDContext(sid, ctx) } catch { /* non-fatal */ }
        }
      }

      if (resumeResult.status === 'fulfilled' && resumeResult.value) {
        update.parsedResume = resumeResult.value
        const ctx = buildParsedResumeContext(resumeResult.value, domain)
        if (ctx) {
          try { await setCachedResumeContext(sid, ctx) } catch { /* non-fatal */ }
        }
      }

      if (Object.keys(update).length > 0) {
        try {
          await InterviewSession.findByIdAndUpdate(session._id, update)
        } catch (err) {
          logger.warn({ err, sessionId: sid }, 'Failed to persist parsed documents (non-fatal)')
        }
      }
    } catch (err) {
      logger.warn({ err, sessionId: session._id }, 'Document Intelligence Layer failed (non-fatal)')
    }
  }

  // Pre-warm session config cache (domain, depth, rubric, user profile) so
  // the first generate-question call hits Redis instead of Mongo.
  warmSessionConfigCache((session._id as mongoose.Types.ObjectId).toString(), {
    role: input.config.role,
    interviewType: input.config.interviewType || 'behavioral',
    userId: input.userId,
    experience: input.config.experience || '0-2',
  })

  return session
}

/**
 * Return shape for {@link updateSession}.
 *
 * `priorStatus` is the session's `status` before this update ran. The
 * PATCH handler uses it to fire `interview_complete` XP/streak/badge
 * rewards only on the first transition into `'completed'` so that
 * repeated completion PATCHes (degraded-reload F5, double-submits,
 * retries) don't duplicate engagement side effects. Returning it from
 * here instead of having the route pre-read the session avoids a
 * duplicate `findById` that would otherwise run before `connectDB()`,
 * which Mongoose's `bufferCommands: false` setting makes unsafe on
 * cold serverless invocations (Codex P1 on PR #313).
 */
export interface UpdateSessionResult {
  updated: IInterviewSession
  priorStatus?: string
}

export async function updateSession(
  sessionId: string,
  userId: string,
  role: string,
  organizationId: string | undefined,
  input: UpdateSessionInput
): Promise<UpdateSessionResult> {
  await connectDB()

  const session = await InterviewSession.findById(sessionId)
  if (!session) throw new NotFoundError('Interview session')

  if (!canEditSession(
    { userId: session.userId.toString(), organizationId: session.organizationId?.toString() },
    { id: userId, role, organizationId }
  )) {
    throw new ForbiddenError('You do not have permission to edit this session')
  }

  // Capture pre-update status so the caller can detect state transitions
  // without issuing a redundant pre-read. See UpdateSessionResult.
  const priorStatus = typeof session.status === 'string' ? session.status : undefined

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
  if (input.recordingDurationSeconds !== undefined) updateFields.recordingDurationSeconds = input.recordingDurationSeconds
  if (input.screenRecordingR2Key) updateFields.screenRecordingR2Key = input.screenRecordingR2Key
  if (input.screenRecordingSizeBytes !== undefined) updateFields.screenRecordingSizeBytes = input.screenRecordingSizeBytes
  if (input.audioRecordingR2Key) updateFields.audioRecordingR2Key = input.audioRecordingR2Key
  if (input.audioRecordingSizeBytes !== undefined) updateFields.audioRecordingSizeBytes = input.audioRecordingSizeBytes
  if (input.liveTranscriptWords) updateFields.liveTranscriptWords = input.liveTranscriptWords
  if (input.codingProblemId) updateFields.codingProblemId = input.codingProblemId
  if (input.designProblemId) updateFields.designProblemId = input.designProblemId
  if (input.scoringDimensions) updateFields.scoringDimensions = input.scoringDimensions
  if (input.plannedQuestionCount !== undefined) updateFields.plannedQuestionCount = input.plannedQuestionCount
  if (input.answeredCount !== undefined) updateFields.answeredCount = input.answeredCount
  if (input.endReason) updateFields.endReason = input.endReason
  if (input.wasTruncatedByTimer) updateFields.wasTruncatedByTimer = input.wasTruncatedByTimer
  if (input.interviewLatencyTelemetry) updateFields.interviewLatencyTelemetry = input.interviewLatencyTelemetry

  const updated = await InterviewSession.findByIdAndUpdate(sessionId, updateFields, { returnDocument: 'after' })
  if (!updated) throw new NotFoundError('Interview session')

  logger.info({ sessionId, status: input.status }, 'Interview session updated')

  return { updated, priorStatus }
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

  const filter: Record<string, unknown> = {}

  // If recruiter/admin, show org sessions; otherwise show own sessions
  if (input.organizationId && ['recruiter', 'org_admin', 'platform_admin'].includes(input.role)) {
    filter.organizationId = new mongoose.Types.ObjectId(input.organizationId)
  } else {
    filter.userId = new mongoose.Types.ObjectId(input.userId)
  }

  if (input.status) {
    filter.status = input.status
  }

  // Aggregation, not find().select(), because the previous projection
  // (`-transcript -evaluations -speechMetrics`) still loaded full
  // `liveTranscriptWords` arrays — tens of thousands of word objects
  // per session — only to compute a boolean and `delete` it from the
  // response. Now that PR #332 starts persisting liveTranscriptWords,
  // that materialisation is a real memory + latency regression as
  // session count grows (Codex P2 on PR #332).
  //
  // The pipeline:
  //   1. $addFields derives `hasLiveTranscriptWords` and
  //      `hasStoredTranscript` from $size+$ifNull, so existence checks
  //      do not require shipping the underlying arrays out of Mongo.
  //   2. $project drops the heavy arrays before rows leave the server.
  //
  // Booleans match the gate in /api/analysis/start (transcript or live
  // words only — evaluations alone are not a transcript source).
  const [sessions, total] = await Promise.all([
    InterviewSession.aggregate([
      { $match: filter },
      { $sort: { createdAt: -1 } },
      { $skip: skip },
      { $limit: limit },
      {
        $addFields: {
          hasLiveTranscriptWords: {
            $gt: [{ $size: { $ifNull: ['$liveTranscriptWords', []] } }, 0],
          },
          hasStoredTranscript: {
            $gt: [{ $size: { $ifNull: ['$transcript', []] } }, 0],
          },
        },
      },
      {
        $project: {
          transcript: 0,
          evaluations: 0,
          speechMetrics: 0,
          liveTranscriptWords: 0,
        },
      },
    ]),
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
