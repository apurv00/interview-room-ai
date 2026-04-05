import { NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { MultimodalAnalysis } from '@shared/db/models/MultimodalAnalysis'
import { isFeatureEnabled } from '@shared/featureFlags'
import { getPlanLimits } from '@shared/services/stripe'
import { inngest } from '@interview/services/inngestClient'
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
        return NextResponse.json({
          jobId: existing._id.toString(),
          status: existing.status,
          message: 'Analysis already in progress',
        })
      }
      // If failed, allow retry — delete the old one
      await MultimodalAnalysis.deleteOne({ _id: existing._id })
    }

    // Verify session ownership and has recording
    const session = await InterviewSession.findOne({
      _id: sessionId,
      userId,
    })
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }
    if (!session.recordingR2Key) {
      return NextResponse.json(
        { error: 'Session has no recording — multimodal analysis requires a recording' },
        { status: 400 }
      )
    }

    // Quota check
    const planLimits = getPlanLimits(ctx.user.plan || 'free')
    const monthStart = new Date()
    monthStart.setDate(1)
    monthStart.setHours(0, 0, 0, 0)

    const usedThisMonth = await MultimodalAnalysis.countDocuments({
      userId,
      createdAt: { $gte: monthStart },
      status: { $in: ['completed', 'processing', 'pending'] },
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

    // Create analysis record
    const analysis = await MultimodalAnalysis.create({
      sessionId: new mongoose.Types.ObjectId(sessionId),
      userId: new mongoose.Types.ObjectId(userId),
      status: 'pending',
    })

    // Link to session
    session.multimodalAnalysisId = analysis._id
    await session.save()

    // Trigger Inngest pipeline
    await inngest.send({
      name: 'interview/analysis.requested',
      data: { sessionId, userId },
    })

    return NextResponse.json({
      jobId: analysis._id.toString(),
      status: 'pending',
    })
  },
})
