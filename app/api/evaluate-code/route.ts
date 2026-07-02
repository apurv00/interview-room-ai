import { NextResponse } from 'next/server'
import { completion } from '@shared/services/modelRouter'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { trackUsage } from '@shared/services/usageTracking'
import { aiLogger } from '@shared/logger'
import { DATA_BOUNDARY_RULE, JSON_OUTPUT_RULE } from '@shared/services/promptSecurity'
import { isFeatureEnabled } from '@shared/featureFlags'
import { buildFollowUpCalibration } from '@interview/flow/probeGuidance'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const EvaluateCodeSchema = z.object({
  code: z.string().min(1).max(50000),
  language: z.enum(['python', 'javascript', 'typescript', 'java', 'cpp']),
  problemTitle: z.string().min(1).max(200),
  problemDescription: z.string().min(1).max(5000),
  questionIndex: z.number().int().min(0),
  sessionId: z.string().optional(),
  // Band calibration for the grounded follow-up (grounded_followups flag).
  // Optional: absent → follow-up is generated uncalibrated (or not at all
  // when the flag is off). domain cap matches the CMS domain-slug validator
  // (max 100, modules/cms/validators/cms.ts) — a tighter cap would 400 the
  // WHOLE eval for CMS domains with 65-100 char slugs and convert the main
  // submission eval into a 'failed' row (Codex P2 on #487).
  domain: z.string().max(100).optional(),
  experience: z.string().max(32).optional(),
})

type EvaluateCodePayload = z.infer<typeof EvaluateCodeSchema>

export const POST = composeApiRoute<EvaluateCodePayload>({
  schema: EvaluateCodeSchema,
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 10,
    keyPrefix: 'rl:eval-code',
  },
  handler: async (_req, ctx) => {
    const { code, language, problemTitle, problemDescription, questionIndex, sessionId, domain, experience } = ctx.body
    const startTime = Date.now()

    // Grounded follow-up (flag-gated): when ON, the eval also writes ONE
    // spoken follow-up question referencing the candidate's actual code,
    // calibrated by the flow templates' per-band probing guidance. When OFF,
    // the prompt and response are byte-identical to the pre-flag behavior —
    // the client falls back to its hardcoded follow-up string.
    const groundedOn = isFeatureEnabled('grounded_followups')
    const groundedContract = groundedOn
      ? `,
  "grounded_follow_up": "ONE short spoken follow-up question (max 2 sentences) grounded in THIS submission — reference a specific function, variable, or implementation choice in the candidate's code, aimed at the weakest scored dimension or a flag"`
      : ''
    const calibration = groundedOn ? buildFollowUpCalibration(domain, 'coding', experience) : ''

    try {
      const result = await completion({
        taskSlot: 'interview.evaluate-code',
        system: `${DATA_BOUNDARY_RULE}

You are a senior technical interviewer evaluating a coding solution. Evaluate the code strictly but fairly.

${JSON_OUTPUT_RULE}
{
  "correctness": number (0-100, does it solve the problem correctly for all cases?),
  "efficiency": number (0-100, time and space complexity quality),
  "code_quality": number (0-100, readability, naming, structure, idiomatic usage),
  "communication": number (0-100, is the code self-documenting? good variable names?),
  "edge_cases": number (0-100, handles edge cases like empty input, null, overflow?),
  "feedback": "2-3 sentences of specific feedback",
  "complexity": "O(n) time, O(n) space" or similar,
  "flags": ["specific issues found, e.g. 'missing null check', 'inefficient nested loop'"]${groundedContract}
}
${calibration}`,
        messages: [{
          role: 'user',
          content: `<problem>\nTitle: ${problemTitle}\n${problemDescription}\n</problem>\n\n<code language="${language}">\n${code}\n</code>\n\nEvaluate this ${language} solution.`,
        }],
      })

      const raw = result.text || '{}'
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        return NextResponse.json({ error: 'Failed to parse evaluation' }, { status: 502 })
      }

      const evaluation = JSON.parse(jsonMatch[0])
      // Kill switch: never leak the field when the flag is off (or the model
      // returned a non-string) — absence is what makes the client fall back.
      if (!groundedOn || typeof evaluation.grounded_follow_up !== 'string' || !evaluation.grounded_follow_up.trim()) {
        delete evaluation.grounded_follow_up
      }

      // Track usage
      await trackUsage({
        user: ctx.user,
        type: 'api_call_evaluate',
        sessionId,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        modelUsed: result.model,
        durationMs: Date.now() - startTime,
        success: true,
      }).catch(() => {})

      return NextResponse.json({
        questionIndex,
        ...evaluation,
      })
    } catch (err) {
      aiLogger.error({ err }, 'Code evaluation failed')
      return NextResponse.json({ error: 'Evaluation failed' }, { status: 500 })
    }
  },
})
