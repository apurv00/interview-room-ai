import { NextResponse } from 'next/server'
import { composeApiRoute } from '@/lib/middleware/composeApiRoute'
import { runBenchmarkSuite } from '@/lib/services/benchmarkService'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const BenchmarkSchema = z.object({
  domain: z.string().optional(),
  interviewType: z.string().optional(),
  category: z.string().optional(),
})

export const POST = composeApiRoute<z.infer<typeof BenchmarkSchema>>({
  schema: BenchmarkSchema,
  rateLimit: { windowMs: 300_000, maxRequests: 2, keyPrefix: 'rl:benchmark' },
  requiredRole: 'platform_admin',

  async handler(req, { body }) {
    const results = await runBenchmarkSuite({
      domain: body.domain,
      interviewType: body.interviewType,
      category: body.category,
    })

    return NextResponse.json(results)
  },
})
