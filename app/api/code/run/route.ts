import { NextResponse } from 'next/server'
import { z } from 'zod'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { simulateCodeRun, runExampleTests } from '@interview/services/core/codeSimulationService'

export const dynamic = 'force-dynamic'

// The coding interview is LLM-driven end to end (problem gen, clarifications, and
// submission scoring via /api/evaluate-code), so the convenience "Run" button
// predicts output with the model rather than executing in a sandbox. The response
// carries `simulated: true` so the UI labels it "AI-estimated".
// When `examples` are sent, Run instead acts as a LeetCode-style test harness:
// it judges the candidate's code against each example and returns pass/fail.
const RunCodeSchema = z.object({
  code: z.string().min(1).max(50000),
  language: z.enum(['python', 'javascript', 'typescript', 'java', 'cpp']),
  stdin: z.string().max(10000).optional(),
  examples: z
    .array(z.object({ input: z.string().max(2000), output: z.string().max(2000) }))
    .max(12)
    .optional(),
  problem: z
    .object({ title: z.string().max(300), description: z.string().max(8000) })
    .optional(),
})

type RunCodePayload = z.infer<typeof RunCodeSchema>

export const POST = composeApiRoute<RunCodePayload>({
  schema: RunCodeSchema,
  // 10/min — every Run is now an LLM call (it was a free sandbox before), so this is
  // sized like sibling LLM routes (evaluate-code 10, clarify-coding 8) rather than the
  // old sandbox-era 20. composeApiRoute still scales this by plan.
  rateLimit: { windowMs: 60_000, maxRequests: 10, keyPrefix: 'rl:code-run' },

  async handler(_req, { body }) {
    const { code, language, stdin, examples, problem } = body
    // LeetCode-style: run against the example test cases when provided.
    if (examples && examples.length > 0) {
      const result = await runExampleTests(code, language, examples, problem ?? { title: '', description: '' })
      return NextResponse.json(result)
    }
    const result = await simulateCodeRun(code, language, stdin || '')
    return NextResponse.json(result)
  },
})
