import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { parseResumeToStructured } from '@resume/services/resumeAIService'
import { ParseResumeSchema } from '@resume/validators/resume'

export const dynamic = 'force-dynamic'

// Open to anonymous users so they can hydrate the resume builder from a paste
// or upload without signing in. The resume parser is stateless (no user.id
// dependency). Authed users get the regular per-minute limit; anonymous users
// are additionally capped at 10 parses per IP per day to bound abuse.
export const POST = composeApiRoute({
  schema: ParseResumeSchema,
  authOptional: true,
  rateLimit: {
    keyPrefix: 'rl:resume-parse',
    windowMs: 60_000,
    maxRequests: 5,
    anonDailyLimit: 10,
  },
  handler: async (_req, { body }) => {
    try {
      const result = await parseResumeToStructured(body.text)
      if (!result) {
        return NextResponse.json({ error: 'Failed to parse resume' }, { status: 500 })
      }
      return NextResponse.json(result)
    } catch {
      return NextResponse.json({ error: 'Failed to parse resume' }, { status: 500 })
    }
  },
})
