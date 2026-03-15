import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { parseJobDescription } from '@interview/services/jdParserService'

const ParseJDSchema = z.object({
  text: z.string().min(20).max(15000),
})

export const POST = composeApiRoute({
  schema: ParseJDSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 10, keyPrefix: 'interview:parse-jd' },
  handler: async (_req: NextRequest, { body }) => {
    const parsed = await parseJobDescription(body.text)
    return NextResponse.json(parsed)
  },
})
