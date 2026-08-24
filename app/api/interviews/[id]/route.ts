import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import mongoose from 'mongoose'
import { ZodError, z } from 'zod'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { UpdateSessionSchema } from '@interview/validators/interview'
import { getSession, updateSession } from '@interview/services/core/interviewService'
import { awardXp } from '@learn/services/xpService'
import { recordActivity, updateStreak } from '@learn/services/streakService'
import { checkAndAwardBadges } from '@learn/services/badgeService'
import { XP_AMOUNTS } from '@learn/config/xpTable'
import { logger } from '@shared/logger'
import { AppError } from '@shared/errors'
import { deleteInterviewSession } from '@shared/services/accountDeletion'
import { flushUsageBuffer } from '@shared/services/usageBuffer'
import { InterviewSession } from '@shared/db/models'
import {
  activeJobsAccountIds,
  isJobsAccountActive,
} from '@shared/services/jobsAccountFence'
import {
  JobsAccountInactiveError,
  JobsAccountTransactionsRequiredError,
} from '@shared/services/jobsAccountFence'
import { deleteFromR2 } from '@shared/storage/r2'
import {
  associateRecordingArtifact,
  cleanupSupersededRecordingArtifact,
  RecordingArtifactKeyRejectedError,
  RecordingArtifactSessionNotFoundError,
} from '@interview/services/core/recordingArtifactService'

export const dynamic = 'force-dynamic'

const accountUnavailableResponse = () => NextResponse.json(
  { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
  { status: 401 },
)

type SessionUpdateInput = Parameters<typeof updateSession>[4]

const LegacyRecordingArtifactPatchSchema = z.union([
  z.object({
    recordingR2Key: z.string().min(1).max(1000),
    recordingSizeBytes: z.number().int().min(0),
    recordingDurationSeconds: z.number().min(1).max(14_400).optional(),
  }).strict().transform((value) => ({
    type: 'recording' as const,
    key: value.recordingR2Key,
    sizeBytes: value.recordingSizeBytes,
    ...(value.recordingDurationSeconds !== undefined
      ? { durationSeconds: value.recordingDurationSeconds }
      : {}),
  })),
  z.object({
    screenRecordingR2Key: z.string().min(1).max(1000),
    screenRecordingSizeBytes: z.number().int().min(0),
  }).strict().transform((value) => ({
    type: 'screen-recording' as const,
    key: value.screenRecordingR2Key,
    sizeBytes: value.screenRecordingSizeBytes,
  })),
  z.object({
    audioRecordingR2Key: z.string().min(1).max(1000),
    audioRecordingSizeBytes: z.number().int().min(0),
  }).strict().transform((value) => ({
    type: 'audio-recording' as const,
    key: value.audioRecordingR2Key,
    sizeBytes: value.audioRecordingSizeBytes,
  })),
])

const LEGACY_RECORDING_ARTIFACT_FIELDS = new Set([
  'recordingR2Key',
  'recordingSizeBytes',
  'screenRecordingR2Key',
  'screenRecordingSizeBytes',
  'audioRecordingR2Key',
  'audioRecordingSizeBytes',
])

async function bestEffortDeleteRecordingArtifact(
  key: string,
  ownerUserId: string,
  sessionId: string,
): Promise<void> {
  try {
    await deleteFromR2(key, { ownerUserId, sessionId })
  } catch (error) {
    logger.warn({ error, key }, 'Legacy recording finalization compensation failed')
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  let requesterUserId: string | undefined
  try {
    if (!mongoose.Types.ObjectId.isValid(params.id)) {
      return NextResponse.json({ error: 'Invalid session ID format' }, { status: 400 })
    }

    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    requesterUserId = session.user.id

    await connectDB()
    if (!(await isJobsAccountActive(session.user.id))) {
      return accountUnavailableResponse()
    }

    const excludeTranscript = req.nextUrl.searchParams.get('excludeTranscript') === 'true'
    const interviewSession = await getSession(
      params.id,
      session.user.id,
      session.user.role,
      session.user.organizationId,
      { excludeTranscript }
    )
    const ownerUserId = interviewSession.userId.toString()
    const requesterIsOwner = ownerUserId === session.user.id

    // A platform administrator must not read a retained session after its owner has
    // crossed the deletion fence. Use 404 so this path does not disclose the
    // lifecycle state of another account.
    if (!requesterIsOwner && !(await isJobsAccountActive(ownerUserId))) {
      return NextResponse.json({ error: 'Interview session not found' }, { status: 404 })
    }

    // Strip internal storage keys from response — expose a boolean flag instead
    const responseData = interviewSession.toObject ? interviewSession.toObject() : { ...interviewSession }
    const hasRecording = !!responseData.recordingR2Key
    const hasScreenRecording = !!responseData.screenRecordingR2Key
    const hasAudioRecording = !!responseData.audioRecordingR2Key
    const hasLiveTranscriptWords =
      Array.isArray(responseData.liveTranscriptWords) && responseData.liveTranscriptWords.length > 0

    // hasStoredTranscript must be derived independently of the
    // excludeTranscript projection — otherwise transcript-only sessions
    // queried with excludeTranscript=true (the feedback page) would
    // incorrectly report hasAnalysisSource=false even though
    // /api/analysis/start would accept them (Codex P2 #4 on PR #332).
    // When transcript was projected out, derive size server-side via
    // $size+$ifNull so the array never leaves Mongo.
    let hasStoredTranscript: boolean
    if (excludeTranscript) {
      const [stat] = await InterviewSession.aggregate([
        { $match: { _id: new mongoose.Types.ObjectId(params.id) } },
        {
          $project: {
            hasStoredTranscript: {
              $gt: [{ $size: { $ifNull: ['$transcript', []] } }, 0],
            },
          },
        },
      ])
      hasStoredTranscript = !!(stat?.hasStoredTranscript)
    } else {
      hasStoredTranscript =
        Array.isArray(responseData.transcript) && responseData.transcript.length > 0
    }

    delete responseData.recordingR2Key
    delete responseData.screenRecordingR2Key
    delete responseData.audioRecordingR2Key
    delete responseData.facialLandmarksR2Key
    delete responseData.resumeR2Key
    delete responseData.jdR2Key
    // Mongoose preserves unknown fields hydrated from older documents even
    // after they leave the current schema. Keep retired invite metadata and
    // candidate context behind the response boundary until those rows are
    // physically migrated.
    delete responseData.templateId
    delete responseData.candidateEmail
    delete responseData.candidateName
    delete responseData.recruiterNotes
    delete responseData.inviteTokenHash
    delete responseData.inviteTokenExpiry
    delete responseData.liveTranscriptWords
    responseData.hasRecording = hasRecording
    responseData.hasScreenRecording = hasScreenRecording
    // Lets the feedback page fetch the audio-only replay object without a
    // guaranteed-404 probe on sessions that predate the audio track.
    responseData.hasAudioRecording = hasAudioRecording
    // Mirror the gate in /api/analysis/start: transcript or live words only.
    // Evaluations alone do NOT drive analysis (Codex P2 #1 on PR #332).
    responseData.hasAnalysisSource = hasLiveTranscriptWords || hasStoredTranscript

    // Strip PII and non-essential fields from platform-administrator reads.
    const isOwner = responseData.userId?.toString() === session.user.id
    if (!isOwner) {
      delete responseData.resumeText
      delete responseData.userAgent
      delete responseData.jobDescription
      delete responseData.parsedResume
      delete responseData.parsedJobDescription
      delete responseData.resumeFileName
      delete responseData.jdFileName
      delete responseData.recordingUrl
      delete responseData.shareToken
    }

    // Deletion may commit while getSession/aggregate is in flight. Recheck
    // immediately before returning any captured feedback, config, or JD.
    const finalActiveAccountIds = await activeJobsAccountIds(
      requesterIsOwner ? [session.user.id] : [session.user.id, ownerUserId],
    )
    if (!finalActiveAccountIds.has(session.user.id)) {
      return accountUnavailableResponse()
    }
    if (!requesterIsOwner && !finalActiveAccountIds.has(ownerUserId)) {
      return NextResponse.json({ error: 'Interview session not found' }, { status: 404 })
    }

    return NextResponse.json(responseData)
  } catch (err) {
    if (requesterUserId) {
      try {
        if (!(await isJobsAccountActive(requesterUserId))) {
          return accountUnavailableResponse()
        }
      } catch {
        // Preserve the original AppError/route failure if this recheck fails.
      }
    }
    if (err instanceof AppError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.statusCode })
    }
    logger.error({ err, sessionId: params.id }, 'Failed to get interview session')
    return NextResponse.json({ error: 'Failed to get session' }, { status: 500 })
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  let requesterUserId: string | undefined
  try {
    if (!mongoose.Types.ObjectId.isValid(params.id)) {
      return NextResponse.json({ error: 'Invalid session ID format' }, { status: 400 })
    }

    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    requesterUserId = session.user.id

    const originUserId = req.headers.get('x-origin-user-id')
    if (originUserId !== null && originUserId !== session.user.id) {
      return NextResponse.json(
        { error: 'sign-in session changed', code: 'SESSION_CHANGED' },
        { status: 409 },
      )
    }
    await connectDB()
    if (!(await isJobsAccountActive(session.user.id))) {
      return accountUnavailableResponse()
    }

    const body = await req.json()
    const bodyFields = body && typeof body === 'object' && !Array.isArray(body)
      ? Object.keys(body as Record<string, unknown>)
      : []
    const isLegacyArtifactAttempt = bodyFields.some((field) =>
      LEGACY_RECORDING_ARTIFACT_FIELDS.has(field),
    )
    const legacyArtifactResult = isLegacyArtifactAttempt
      ? LegacyRecordingArtifactPatchSchema.safeParse(body)
      : null
    const legacyArtifact = legacyArtifactResult?.success
      ? legacyArtifactResult.data
      : null
    const validated = legacyArtifact
      ? null
      : UpdateSessionSchema.parse(body) as SessionUpdateInput

    // Cached interview clients may still finalize a direct upload through
    // this PATCH. Keep that narrow legacy shape safe while the dedicated
    // /api/recordings/finalize endpoint rolls out; raw storage keys never
    // reach the generic session updater or its org-admin edit authority.
    if (isLegacyArtifactAttempt && !legacyArtifact) {
      return NextResponse.json(
        { error: 'Recording artifacts must be finalized separately' },
        { status: 400 },
      )
    }
    if (legacyArtifact) {
      try {
        const result = await associateRecordingArtifact({
          userId: session.user.id,
          sessionId: params.id,
          ...legacyArtifact,
        })
        if (!result.accepted) {
          await bestEffortDeleteRecordingArtifact(
            legacyArtifact.key,
            session.user.id,
            params.id,
          )
          return NextResponse.json({ success: true, sessionId: params.id, superseded: true })
        }
        await cleanupSupersededRecordingArtifact(
          result.previousKey,
          legacyArtifact.key,
          session.user.id,
          params.id,
        )
        if (!(await isJobsAccountActive(session.user.id))) {
          await bestEffortDeleteRecordingArtifact(
            legacyArtifact.key,
            session.user.id,
            params.id,
          )
          return accountUnavailableResponse()
        }
        return NextResponse.json({ success: true, sessionId: params.id })
      } catch (error) {
        if (error instanceof RecordingArtifactKeyRejectedError) {
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }
        if (error instanceof JobsAccountInactiveError) {
          await bestEffortDeleteRecordingArtifact(
            legacyArtifact.key,
            session.user.id,
            params.id,
          )
          return accountUnavailableResponse()
        }
        if (error instanceof RecordingArtifactSessionNotFoundError) {
          await bestEffortDeleteRecordingArtifact(
            legacyArtifact.key,
            session.user.id,
            params.id,
          )
          if (!(await isJobsAccountActive(session.user.id))) {
            return accountUnavailableResponse()
          }
          return NextResponse.json({ error: 'Interview session not found' }, { status: 404 })
        }
        if (error instanceof JobsAccountTransactionsRequiredError) {
          await bestEffortDeleteRecordingArtifact(
            legacyArtifact.key,
            session.user.id,
            params.id,
          )
          return NextResponse.json(
            { error: 'Recording finalization requires MongoDB transactions', code: 'TRANSACTIONS_REQUIRED' },
            { status: 503 },
          )
        }
        throw error
      }
    }

    // `updateSession` returns both the updated document AND the session's
    // `priorStatus` (status BEFORE this PATCH applied). We use priorStatus
    // to fire the `interview_complete` engagement rewards below only on
    // the first transition into `'completed'` — subsequent re-PATCHes
    // (degraded-reload F5 after PR #313 stopped persisting the outer-catch
    // fallback, double-submits, retries) are no-ops on rewards. Pulling
    // the prior status from here instead of pre-reading in the route
    // matters because Mongoose is configured with `bufferCommands: false`
    // (shared/db/connection.ts) and `updateSession` is the first caller
    // in this handler that runs `await connectDB()`. A pre-read before
    // that call would throw on cold serverless invocations
    // (Codex P1 on PR #313).
    const { updated, priorStatus } = await updateSession(
      params.id,
      session.user.id,
      session.user.role,
      session.user.organizationId,
      validated as SessionUpdateInput
    )
    const wasAlreadyCompleted = priorStatus === 'completed'

    // Award XP and update streak when interview is completed — ONLY on the
    // first transition. Non-reward side effects (usage buffer flush) stay
    // unconditional — they are idempotent by nature (buffer drains on
    // first call; subsequent calls are no-ops).
    if (validated?.status === 'completed') {
      // Flush buffered usage records to Mongo (fire-and-forget, non-fatal)
      void flushUsageBuffer(params.id).catch((err) =>
        logger.warn({ err, sessionId: params.id }, 'Failed to flush usage buffer (non-fatal)'),
      )

      if (!wasAlreadyCompleted) {
        const overallScore = validated.feedback?.overall_score
        try {
          await awardXp(session.user.id, 'interview_complete', XP_AMOUNTS.interview_complete, { sessionId: params.id })
          await recordActivity(session.user.id)
          const streakResult = await updateStreak(session.user.id)
          await checkAndAwardBadges(session.user.id, {
            type: 'interview_complete',
            score: overallScore,
            currentStreak: streakResult.currentStreak,
          })
        } catch (engErr) {
          // Don't fail the interview save if engagement tracking fails
          logger.error({ err: engErr }, 'Engagement tracking failed')
        }
      } else {
        logger.info(
          { sessionId: params.id, userId: session.user.id, event: 'interview_complete_rewards_skipped' },
          'PATCH status=completed on already-completed session; skipping duplicate engagement rewards',
        )
      }
    }

    if (!(await isJobsAccountActive(session.user.id))) {
      return accountUnavailableResponse()
    }
    return NextResponse.json({ success: true, sessionId: updated._id.toString() })
  } catch (err) {
    if (requesterUserId) {
      try {
        if (!(await isJobsAccountActive(requesterUserId))) {
          return accountUnavailableResponse()
        }
      } catch {
        // Preserve the original validation/AppError contract when unavailable.
      }
    }
    if (err instanceof ZodError) {
      return NextResponse.json(
        {
          error: 'Validation failed',
          ...(process.env.NODE_ENV !== 'production' && {
            details: err.issues.map((e) => ({
              path: e.path.join('.'),
              message: e.message,
            })),
          }),
        },
        { status: 400 }
      )
    }
    if (err instanceof AppError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.statusCode })
    }
    logger.error({ err, sessionId: params.id }, 'Failed to update interview session')
    return NextResponse.json({ error: 'Failed to update session' }, { status: 500 })
  }
}

/**
 * DELETE /api/interviews/[id]
 *
 * Permanently removes a single interview session: the session document,
 * its multimodal analysis, its session summary, and any R2 artefacts
 * (recording, facial landmarks, resume, JD). Verifies ownership.
 *
 * This is the *full* delete used by the /history "Delete" button. The
 * sibling /api/interviews/[id]/data endpoint only redacts sensitive
 * fields and is kept for backwards compatibility with the existing
 * "Forget my data" flow on the feedback page.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    if (!mongoose.Types.ObjectId.isValid(params.id)) {
      return NextResponse.json({ error: 'Invalid session ID format' }, { status: 400 })
    }

    const authSession = await getServerSession(authOptions)
    if (!authSession?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const result = await deleteInterviewSession(
      params.id,
      authSession.user.id,
      authSession.user.role === 'platform_admin'
    )
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown'
    if (message === 'Forbidden') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (message === 'Session not found') {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }
    if (message === 'Invalid session id') {
      return NextResponse.json({ error: 'Invalid session ID format' }, { status: 400 })
    }
    logger.error({ err, sessionId: params.id }, 'Failed to delete interview session')
    return NextResponse.json({ error: 'Failed to delete session' }, { status: 500 })
  }
}
