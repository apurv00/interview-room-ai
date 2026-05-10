import { NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { MultimodalAnalysis } from '@shared/db/models/MultimodalAnalysis'
import { isFeatureEnabled } from '@shared/featureFlags'
import { enforceAnalysisCap } from '@shared/services/analysisCleanup'
import { aiLogger } from '@shared/logger'
import { StartAnalysisSchema } from '@interview/validators/multimodal'

export const dynamic = 'force-dynamic'
// Vercel Free plan hard-caps serverless functions at 60s.
export const maxDuration = 60

const MAX_ACTIVE_ANALYSES = 10

/** Check if Inngest is configured (both keys present). */
function isInngestConfigured(): boolean {
  return !!(process.env.INNGEST_EVENT_KEY && process.env.INNGEST_SIGNING_KEY)
}

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
    if (!mongoose.Types.ObjectId.isValid(sessionId)) {
      return NextResponse.json({ error: 'Invalid session ID format' }, { status: 400 })
    }
    const sessionObjectId = new mongoose.Types.ObjectId(sessionId)

    // Feature flag check
    if (!isFeatureEnabled('multimodal_analysis')) {
      return NextResponse.json(
        { error: 'Multimodal analysis is not enabled' },
        { status: 403 }
      )
    }

    await connectDB()

    // A stuck pending/processing record (e.g. server killed mid-pipeline)
    // should not lock the user out forever. Anything older than 3 minutes
    // still in pending/processing is considered abandoned. The pipeline
    // completes in 7-15s (fast path) so 3 min is very generous. Aligned
    // with the client's 2-min "stuck" warning in AnalysisTrigger.
    const STALE_PENDING_CUTOFF_MS = 3 * 60 * 1000
    const staleCutoff = new Date(Date.now() - STALE_PENDING_CUTOFF_MS)

    // Check if analysis already exists
    const existing = await MultimodalAnalysis.findOne({ sessionId: sessionObjectId })
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

    // Verify session ownership and that at least one analysis source is
    // available. Prefer live Deepgram words / stored transcript so analysis
    // is not blocked by a large replay-video upload.
    const session = await InterviewSession.findOne({
      _id: sessionObjectId,
      userId,
    })
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }
    const hasLiveTranscriptWords =
      Array.isArray(session.liveTranscriptWords) && session.liveTranscriptWords.length > 0
    const hasStoredTranscript =
      Array.isArray(session.transcript) && session.transcript.length > 0
    const hasAnalysisSource = hasLiveTranscriptWords || hasStoredTranscript
    if (!hasAnalysisSource) {
      return NextResponse.json(
        { error: 'Session has no transcript or live words for analysis' },
        { status: 400 }
      )
    }

    // Cap check: max 10 active analyses per user (rolling, not monthly).
    // We allow the request even at cap — the cleanup runs AFTER the new
    // analysis completes, so the user always keeps their latest 10.
    // Only block if there are already 10 in-flight (pending/processing)
    // to prevent runaway concurrent requests.
    const inFlightCount = await MultimodalAnalysis.countDocuments({
      userId,
      status: { $in: ['pending', 'processing'] },
      createdAt: { $gte: staleCutoff },
    })

    if (inFlightCount >= 3) {
      return NextResponse.json(
        { error: 'Analysis already in progress — please wait for it to complete' },
        { status: 429 }
      )
    }

    // Create analysis record in 'pending' state. The Inngest job handler
    // will flip it to 'processing' in step 1 (stepFetchSession) and then
    // to 'completed' or 'failed' on the way out.
    const analysis = await MultimodalAnalysis.create({
      sessionId: sessionObjectId,
      userId: new mongoose.Types.ObjectId(userId),
      status: 'pending',
    })

    // Link to session
    session.multimodalAnalysisId = analysis._id
    await session.save()

    // ── Dispatch: Inngest (background) or inline (fallback) ──
    if (isInngestConfigured()) {
      try {
        const { inngest } = await import('@shared/services/inngest')
        await inngest.send({
          name: 'analysis/requested',
          data: { sessionId, userId, startTime: Date.now() },
        })
        return NextResponse.json({
          jobId: analysis._id.toString(),
          status: 'pending',
        })
      } catch (err) {
        aiLogger.warn({ err, sessionId }, 'Inngest send failed — falling back to inline')
        // Fall through to inline
      }
    }

    // Inline fallback: run the pipeline synchronously.
    // Results saved to same MultimodalAnalysis collection.
    //
    // Soft timeout: 50s (10s buffer below maxDuration=60) so the response
    // is sent before Vercel hard-kills the function. If the pipeline
    // doesn't finish in time, leave the row in 'processing' state and
    // surface a retry option to the user.
    if (!isInngestConfigured()) {
      aiLogger.warn({ sessionId }, 'Inngest not configured — running analysis inline (may timeout for long interviews)')
    }
    const INLINE_SOFT_TIMEOUT_MS = 50_000
    try {
      const { runMultimodalPipeline } = await import('@interview/services/analysis/multimodalPipeline')
      await Promise.race([
        runMultimodalPipeline(sessionId, userId, { inline: true }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('SOFT_TIMEOUT')), INLINE_SOFT_TIMEOUT_MS)
        ),
      ])

      // Enforce 10-analysis cap — delete oldest + their R2 recordings
      await enforceAnalysisCap(userId, MAX_ACTIVE_ANALYSES)

      return NextResponse.json({
        jobId: analysis._id.toString(),
        status: 'completed',
      })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error'

      // Soft timeout — leave row in processing so polling client can keep
      // waiting. The pipeline may still complete in the background even
      // after this response is sent (Node serverless functions don't
      // hard-kill on early return), and the client will pick it up.
      if (errorMessage === 'SOFT_TIMEOUT') {
        aiLogger.warn({ sessionId, userId }, 'Inline multimodal pipeline soft timeout — pipeline still running')
        await MultimodalAnalysis.findOneAndUpdate(
          { _id: analysis._id },
          { status: 'processing' }
        ).catch(() => {})
        return NextResponse.json({
          jobId: analysis._id.toString(),
          status: 'processing',
          message: 'Analysis is taking longer than expected — please refresh in a minute.',
        })
      }

      aiLogger.error({ err, sessionId, userId }, 'Inline multimodal pipeline failed')
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
