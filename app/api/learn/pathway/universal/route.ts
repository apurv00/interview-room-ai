import { NextResponse } from 'next/server'
import { z } from 'zod'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import {
  generateUniversalPlan,
  getUniversalPlan,
  markLessonComplete,
} from '@learn/services/pathwayPlanner'
import { getPhaseStatus } from '@learn/services/phaseAdvancement'

export const dynamic = 'force-dynamic'

export const GET = composeApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 30, keyPrefix: 'rl:pathway-universal-get' },
  async handler(_req, { user }) {
    const plan = await getUniversalPlan(user.id)
    if (!plan) {
      return NextResponse.json({ plan: null, phaseStatus: null })
    }
    const phaseStatus = getPhaseStatus(plan.sessionsCompleted ?? 0, plan.phaseThresholds)
    return NextResponse.json({ plan, phaseStatus })
  },
})

const PostSchema = z.object({
  domain: z.string().min(1).max(60),
  depth: z.string().min(1).max(40),
  targetRole: z.string().max(120).optional(),
})

export const POST = composeApiRoute<z.infer<typeof PostSchema>>({
  schema: PostSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 5, keyPrefix: 'rl:pathway-universal-post' },
  async handler(_req, { user, body }) {
    const plan = await generateUniversalPlan({
      userId: user.id,
      domain: body.domain,
      depth: body.depth,
      targetRole: body.targetRole,
    })
    if (!plan) {
      return NextResponse.json({ error: 'Failed to generate plan' }, { status: 500 })
    }
    const phaseStatus = getPhaseStatus(plan.sessionsCompleted ?? 0, plan.phaseThresholds)
    return NextResponse.json({ plan, phaseStatus })
  },
})

const PatchSchema = z.object({
  action: z.literal('complete_lesson'),
  lessonId: z.string().min(1).max(64),
})

export const PATCH = composeApiRoute<z.infer<typeof PatchSchema>>({
  schema: PatchSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 30, keyPrefix: 'rl:pathway-universal-patch' },
  async handler(_req, { user, body }) {
    const ok = await markLessonComplete(user.id, body.lessonId)
    if (!ok) {
      return NextResponse.json({ error: 'Lesson not found' }, { status: 404 })
    }
    return NextResponse.json({ success: true })
  },
})
