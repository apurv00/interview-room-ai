import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { generateJobDescription } from '@interview/services/jdGeneratorService'

export const dynamic = 'force-dynamic'

const GenerateJDSchema = z.object({
  company: z.string().min(1).max(200),
  role: z.string().min(1).max(200),
  resumeText: z.string().max(50000).optional(),
})

export const POST = composeApiRoute({
  schema: GenerateJDSchema,
  rateLimit: { windowMs: 3_600_000, maxRequests: 5, keyPrefix: 'jd:generate' },
  handler: async (_req: NextRequest, { body }) => {
    const result = await generateJobDescription({
      company: body.company,
      role: body.role,
      resumeText: body.resumeText,
    })
    return NextResponse.json(result)
  },
})
