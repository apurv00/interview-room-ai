import { NextResponse } from 'next/server'
import { composeApiRoute } from '@/lib/middleware/composeApiRoute'
import { getCurrentPathway, markTaskComplete } from '@/lib/services/pathwayPlanner'
import { getUserCompetencySummary, getUserWeaknesses } from '@/lib/services/competencyService'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

// GET: Retrieve current pathway plan and competency summary
export const GET = composeApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 20, keyPrefix: 'rl:pathway' },

  async handler(req, { user }) {
    const [pathway, competencySummary, weaknesses] = await Promise.all([
      getCurrentPathway(user.id),
      getUserCompetencySummary(user.id),
      getUserWeaknesses(user.id, 10),
    ])

    return NextResponse.json({
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
