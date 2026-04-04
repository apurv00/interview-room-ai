import { NextResponse } from 'next/server'
import { z } from 'zod'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { generate14DayPlan, getTodaysTasks } from '@learn/services/dailyPlanService'

const GeneratePlanSchema = z.object({
  domain: z.string().min(1).max(50),
  interviewType: z.string().max(50).optional(),
  experience: z.enum(['0-2', '3-6', '7+']).optional(),
})

export const POST = composeApiRoute<z.infer<typeof GeneratePlanSchema>>({
  schema: GeneratePlanSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 5, keyPrefix: 'rl:gen-plan' },

  async handler(_req, { user, body }) {
    const plan = await generate14DayPlan(
      user.id,
      body.domain,
      body.interviewType,
      body.experience
    )

    if (!plan) {
      return NextResponse.json({ error: 'Failed to generate plan' }, { status: 500 })
    }

    return NextResponse.json({ success: true, plan })
  },
})

export const GET = composeApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 30, keyPrefix: 'rl:get-plan' },

  async handler(_req, { user }) {
    const result = await getTodaysTasks(user.id)
    return NextResponse.json(result)
  },
})
