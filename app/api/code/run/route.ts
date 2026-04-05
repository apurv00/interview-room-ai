import { NextResponse } from 'next/server'
import { z } from 'zod'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { executeCode, runTestCases } from '@interview/services/codeSandboxService'

export const dynamic = 'force-dynamic'

const RunCodeSchema = z.object({
  code: z.string().min(1).max(50000),
  language: z.enum(['python', 'javascript', 'typescript', 'java', 'cpp']),
  stdin: z.string().max(10000).optional(),
  testCases: z.array(z.object({
    input: z.string().max(10000),
    expectedOutput: z.string().max(10000),
  })).max(20).optional(),
})

type RunCodePayload = z.infer<typeof RunCodeSchema>

export const POST = composeApiRoute<RunCodePayload>({
  schema: RunCodeSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 20, keyPrefix: 'rl:code-run' },

  async handler(_req, { body }) {
    const { code, language, stdin, testCases } = body

    // If test cases provided, run against them
    if (testCases?.length) {
      const results = await runTestCases(code, language, testCases)
      const allPassed = results.every(r => r.passed)
      return NextResponse.json({
        testResults: results,
        allPassed,
        passedCount: results.filter(r => r.passed).length,
        totalCount: results.length,
      })
    }

    // Otherwise, just execute with optional stdin
    const result = await executeCode(code, language, stdin || '')
    return NextResponse.json(result)
  },
})
