import mongoose from 'mongoose'
import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models'
import { getCurrentPathway, markTaskComplete } from '@learn/services/pathwayPlanner'
import { getUserCompetencySummary, getUserWeaknesses } from '@learn/services/competencyService'
import { buildPathwayViewModel } from '@learn/services/pathwayViewModel'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

// GET: Retrieve current pathway plan and competency summary
export const GET = composeApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 20, keyPrefix: 'rl:pathway' },

  async handler(req, { user }) {
    const { searchParams } = new URL(req.url)
    const fromFeedback = searchParams.get('fromFeedback')

    // Resolve the upstream session's pathway-generation status when the
    // caller arrived from feedback. This lets the view model distinguish
    // "still running" (banner) from "failed after retries" (retry CTA)
    // — Bug B fix. Defensive try/catch so a bad sessionId or DB hiccup
    // never blocks the pathway page itself.
    let feedbackSessionStatus: string | null = null
    let feedbackSessionError: string | null = null
    if (fromFeedback) {
      try {
        await connectDB()
        if (mongoose.isValidObjectId(fromFeedback)) {
          const sess = await InterviewSession.findOne({
            _id: fromFeedback,
            userId: new mongoose.Types.ObjectId(user.id),
          })
            .select('pathwayGenerationStatus pathwayGenerationError')
            .lean<{
              pathwayGenerationStatus?: string
              pathwayGenerationError?: string
            }>()
          feedbackSessionStatus = sess?.pathwayGenerationStatus ?? null
          feedbackSessionError = sess?.pathwayGenerationError ?? null
        }
      } catch {
        // Swallow — status lookup is informational only.
      }
    }

    const [pathway, competencySummary, weaknesses] = await Promise.all([
      getCurrentPathway(user.id),
      getUserCompetencySummary(user.id),
      getUserWeaknesses(user.id, 10),
    ])
    const viewModel = buildPathwayViewModel({
      pathway,
      competencySummary,
      weaknesses,
      fromFeedback,
      feedbackSessionStatus,
      feedbackSessionError,
    })

    return NextResponse.json({
      ...viewModel,
      pathway,
      competencySummary,
      weaknesses,
    })
  },
})

// PATCH: Mark a practice task as complete
const PatchSchema = z.object({
  action: z.literal('complete_task'),
  taskId: z.string().min(1),
})

export const PATCH = composeApiRoute<z.infer<typeof PatchSchema>>({
  schema: PatchSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 20, keyPrefix: 'rl:pathway-patch' },

  async handler(req, { user, body }) {
    const success = await markTaskComplete(user.id, body.taskId)

    if (!success) {
      return NextResponse.json(
        { error: 'Task not found or already completed' },
        { status: 404 }
      )
    }

    return NextResponse.json({ success: true })
  },
})
