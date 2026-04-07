import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { tailorResume } from '@resume/services/resumeAIService'
import { TailorSchema } from '@resume/validators/resume'

export const dynamic = 'force-dynamic'

// Open to anonymous users so the strongest "wow" tool of the resume funnel
// (job-specific tailoring) is reachable from SEO landings without sign-in.
// Stateless service — no user.id dependency. Anonymous IPs capped at 3
// tailors per day; one full Sonnet call ~$0.05 → bounded ~$0.15/day/IP.
export const POST = composeApiRoute({
  schema: TailorSchema,
  authOptional: true,
  rateLimit: {
    keyPrefix: 'rl:resume-tailor',
    windowMs: 60_000,
    maxRequests: 5,
    anonDailyLimit: 3,
  },
  handler: async (_req, { body }) => {
    try {
      const result = await tailorResume(body)
      return NextResponse.json(result)
    } catch {
      return NextResponse.json({ error: 'Failed to tailor resume' }, { status: 500 })
    }
  },
})
