import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { checkATS } from '@resume/services/resumeAIService'
import { ATSCheckSchema } from '@resume/validators/resume'

export const dynamic = 'force-dynamic'

// Open to anonymous users — ATS check is the cheapest, highest-conversion
// resume tool and should not be gated. Stateless. Anonymous IPs capped at
// 5 checks per day to bound abuse.
export const POST = composeApiRoute({
  schema: ATSCheckSchema,
  authOptional: true,
  rateLimit: {
    keyPrefix: 'rl:resume-ats-check',
    windowMs: 60_000,
    maxRequests: 5,
    anonDailyLimit: 5,
  },
  handler: async (_req, { body }) => {
    try {
      const result = await checkATS(body)
      return NextResponse.json(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'ATS check failed'
      return NextResponse.json({ error: message }, { status: 500 })
    }
  },
})
