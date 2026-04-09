import { NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { MultimodalAnalysis } from '@shared/db/models/MultimodalAnalysis'
import { isFeatureEnabled } from '@shared/featureFlags'
import { getPlanLimits } from '@shared/services/stripe'
import { inngest } from '@shared/services/inngest'
import { aiLogger } from '@shared/logger'
import { StartAnalysisSchema } from '@interview/validators/multimodal'

export const dynamic = 'force-dynamic'

interface StartPayload {
  sessionId: string
}

export const POST = composeApiRoute<StartPayload>({
  schema: StartAnalysisSchema,
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 3,
    keyPrefix: 'rl:analysis-start',
  },
  handler: async (_req, ctx) => {
    const { sessionId } = ctx.body
    const userId = ctx.user.id

    // Feature flag check
    if (!isFeatureEnabled('multimodal_analysis')) {
      return NextResponse.json(
        { error: 'Multimodal analysis is not enabled' },
        { status: 403 }
      )
    }

    await connectDB()

    // A stuck pending/processing record (e.g. server killed mid-pipeline)
    // should not lock the user out forever. Anything older than 10 minutes
    // still in pending/processing is considered abandoned.
    const STALE_PENDING_CUTOFF_MS = 10 * 60 * 1000
    const staleCutoff = new Date(Date.now() - STALE_PENDING_CUTOFF_MS)

    // Check if analysis already exists
    const existing = await MultimodalAnalysis.findOne({ sessionId })
    if (existing) {
      if (existing.status === 'completed') {
        return NextResponse.json({
          jobId: existing._id.toString(),
          status: existing.status,
          message: 'Analysis already completed',
        })
      }
      if (existing.status === 'processing' || existing.status === 'pending') {
        // Recent in-flight job — let the client keep polling.
        if (existing.createdAt >= staleCutoff) {
          return NextResponse.json({
            jobId: existing._id.toString(),
            status: existing.status,
            message: 'Analysis already in progress',
          })
        }
        // Stale: treat as abandoned and recreate below.
      }
      // If failed or stale, allow retry — delete the old one
      await MultimodalAnalysis.deleteOne({ _id: existing._id })
    }

    // Verify session ownership and that some audio source is available
    // for transcription. Non-privacy-mode sessions upload the full camera
    // webm; privacy-mode sessions upload only the small audio-only track.
    // Either satisfies the pipeline — `stepTranscribeAndDownload` already
    // prefers the audio-only key when present.
    const session = await InterviewSession.findOne({
      _id: sessionId,
      userId,
    })
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }
    if (!session.recordingR2Key && !session.audioRecordingR2Key) {
      return NextResponse.json(
        { error: 'Session has no audio to transcribe — multimodal analysis requires a recording or audio track' },
        { status: 400 }
      )
    }

    // Quota check — exclude stale pending/processing records (>10 min old)
    // so a stuck job doesn't permanently consume the user's monthly quota.
    const planLimits = getPlanLimits(ctx.user.plan || 'free')
    const monthStart = new Date()
    monthStart.setDate(1)
    monthStart.setHours(0, 0, 0, 0)

    const usedThisMonth = await MultimodalAnalysis.countDocuments({
      userId,
      createdAt: { $gte: monthStart },
      $or: [
        { status: 'completed' },
        { status: { $in: ['pending', 'processing'] }, createdAt: { $gte: staleCutoff } },
      ],
    })

    if (usedThisMonth >= planLimits.monthlyAnalysisLimit) {
      return NextResponse.json(
        {
          error: 'Monthly analysis quota reached',
          used: usedThisMonth,
          limit: planLimits.monthlyAnalysisLimit,
          plan: ctx.user.plan || 'free',
        },
        { status: 429 }
      )
    }

    // Create analysis record in 'pending' state. The Inngest job handler
    // will flip it to 'processing' in step 1 (stepFetchSession) and then
    // to 'completed' or 'failed' on the way out.
    const analysis = await MultimodalAnalysis.create({
      sessionId: new mongoose.Types.ObjectId(sessionId),
      userId: new mongoose.Types.ObjectId(userId),
      status: 'pending',
    })

    // Link to session
    session.multimodalAnalysisId = analysis._id
    await session.save()

    // Enqueue the background job. The client is already polling
    // /api/analysis/[sessionId] every 3s and watches the DB row advance
    // pending → processing → completed as the Inngest function steps run.
    // Retries and dead-lettering are handled by Inngest; onFailure in the
    // job handler marks the row status='failed' so the polling UI surfaces
    // the error.
    try {
      await inngest.send({
        name: 'analysis/requested',
        data: { sessionId, userId, startTime: Date.now() },
      })
      return NextResponse.json({
        jobId: analysis._id.toString(),
        status: 'pending',
      })
    } catch (err) {
      // If Inngest itself is unreachable (network / signing error), mark
      // the row failed so the polling client shows the error immediately
      // instead of spinning until the stuck timeout.
      const errorMessage = err instanceof Error ? err.message : 'Unknown error'
      aiLogger.error({ err, sessionId, userId }, 'Failed to enqueue Inngest analysis event')
      await MultimodalAnalysis.findByIdAndUpdate(analysis._id, {
        status: 'failed',
        error: `Failed to enqueue analysis: ${errorMessage}`,
      })
      return NextResponse.json(
        {
          jobId: analysis._id.toString(),
          status: 'failed',
          error: errorMessage,
        },
        { status: 500 }
      )
    }
  },
})
