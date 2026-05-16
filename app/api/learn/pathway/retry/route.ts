import mongoose from 'mongoose'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models'
import { inngest } from '@shared/services/inngest'

/**
 * POST /api/learn/pathway/retry
 *
 * Re-enqueues pathway regeneration for a session whose previous Inngest
 * `pathway/regenerate` attempt failed. Reads the necessary inputs
 * (config, feedback, evaluations) off the session document so the
 * client doesn't need to re-supply them.
 *
 * Bug B follow-up (2026-05-16) — gives users a recovery path when the
 * Inngest job has terminally failed (`pathwayGenerationStatus: 'failed'`).
 * Without this, the only way to trigger another attempt was to complete
 * another interview, which made transient LLM failures permanently
 * sticky.
 *
 * Rate-limited tightly because:
 *   - each retry triggers another LLM call (cost)
 *   - if the underlying cause is persistent (bad data), unlimited
 *     retries just rack up cost without resolving anything
 */

const RetrySchema = z.object({
  sessionId: z.string().min(1),
})

export const POST = composeApiRoute<z.infer<typeof RetrySchema>>({
  schema: RetrySchema,
  rateLimit: { windowMs: 60_000, maxRequests: 3, keyPrefix: 'rl:pathway-retry' },

  async handler(_req, { user, body }) {
    const { sessionId } = body

    if (!mongoose.isValidObjectId(sessionId)) {
      return NextResponse.json({ error: 'Invalid sessionId' }, { status: 400 })
    }

    await connectDB()
    const session = await InterviewSession.findOne({
      _id: sessionId,
      userId: new mongoose.Types.ObjectId(user.id),
    })
      .select('config feedback evaluations pathwayGenerationStatus')
      .lean<{
        config: { role: string; interviewType?: string; experience: string }
        feedback?: unknown
        evaluations?: unknown[]
        pathwayGenerationStatus?: string
      }>()

    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }
    if (!session.feedback) {
      return NextResponse.json(
        { error: 'Session has no feedback yet — generate feedback first.' },
        { status: 409 }
      )
    }
    if (!Array.isArray(session.evaluations) || session.evaluations.length === 0) {
      return NextResponse.json(
        { error: 'Session has no evaluations to base a plan on.' },
        { status: 409 }
      )
    }
    // Only allow retry when previously failed (or no attempt recorded).
    // Block retries on 'running' or 'pending' to avoid duplicate jobs.
    if (
      session.pathwayGenerationStatus === 'running' ||
      session.pathwayGenerationStatus === 'pending'
    ) {
      return NextResponse.json(
        { error: 'A pathway regeneration is already in flight for this session.' },
        { status: 409 }
      )
    }

    // Flip back to 'pending' before re-emitting so the UI shows the
    // banner immediately. The Inngest job's first step will set it to
    // 'running'.
    await InterviewSession.findByIdAndUpdate(sessionId, {
      $set: { pathwayGenerationStatus: 'pending' },
      $unset: { pathwayGenerationError: 1 },
    })

    await inngest.send({
      name: 'pathway/regenerate',
      data: {
        sessionId,
        userId: user.id,
        domain: session.config.role,
        interviewType: session.config.interviewType ?? 'behavioral',
        experience: session.config.experience,
        feedback: session.feedback,
        typedEvaluations: session.evaluations,
      },
    })

    return NextResponse.json({ success: true, status: 'pending' })
  },
})
