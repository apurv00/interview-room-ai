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

const DesignComponentSchema = z.object({
  id: z.string(),
  type: z.string(),
  label: z.string(),
  x: z.number(),
  y: z.number(),
})

const DesignConnectionSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  label: z.string().optional(),
})

const EvaluateDesignSchema = z.object({
  components: z.array(DesignComponentSchema).max(50),
  connections: z.array(DesignConnectionSchema).max(100),
  problemTitle: z.string().min(1).max(200),
  problemDescription: z.string().min(1).max(5000),
  requirements: z.array(z.string()).max(20),
  questionIndex: z.number().int().min(0),
  sessionId: z.string().optional(),
  // Grounded-follow-up inputs (grounded_followups flag). expectedComponents
  // comes from the problem definition — previously authored but never
  // consumed anywhere — and lets the eval aim a probe at an important gap.
  domain: z.string().max(64).optional(),
  experience: z.string().max(32).optional(),
  expectedComponents: z.array(z.string().max(100)).max(30).optional(),
})

type EvaluateDesignPayload = z.infer<typeof EvaluateDesignSchema>

/**
 * Serialize a design diagram into a text description Claude can evaluate.
 */
function serializeDesign(
  components: EvaluateDesignPayload['components'],
  connections: EvaluateDesignPayload['connections']
): string {
  if (components.length === 0) return 'Empty diagram — no components placed.'

  const nodeMap = new Map(components.map((c) => [c.id, c]))

  const lines: string[] = ['Architecture Components:']
  for (const c of components) {
    lines.push(`  - [${c.label}] (type: ${c.type})`)
  }

  if (connections.length > 0) {
    lines.push('')
    lines.push('Connections:')
    for (const conn of connections) {
      const from = nodeMap.get(conn.from)
      const to = nodeMap.get(conn.to)
      if (from && to) {
        const label = conn.label ? ` via ${conn.label}` : ''
        lines.push(`  [${from.label}] → [${to.label}]${label}`)
      }
    }
  }

  return lines.join('\n')
}

export const POST = composeApiRoute<EvaluateDesignPayload>({
  schema: EvaluateDesignSchema,
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 10,
    keyPrefix: 'rl:eval-design',
  },
  handler: async (_req, ctx) => {
    const { components, connections, problemTitle, problemDescription, requirements, questionIndex, sessionId, domain, experience, expectedComponents } = ctx.body
    const startTime = Date.now()

    const designText = serializeDesign(components, connections)

    // Grounded follow-ups (flag-gated): when ON, the eval writes the two
    // spoken follow-ups the round asks after submission — grounded in THIS
    // diagram and calibrated to the candidate's band — replacing the client's
    // hardcoded, experience-blind questions (entry candidates were getting the
    // CAP-theorem trade-off their templates explicitly forbid). When OFF, the
    // prompt and response are byte-identical to the pre-flag behavior.
    const groundedOn = isFeatureEnabled('grounded_followups')
    const groundedContract = groundedOn
      ? `,
  "grounded_follow_up": "ONE short spoken follow-up question (max 2 sentences) that names a SPECIFIC component or connection from the candidate's diagram — aimed at the weakest scored dimension, a flag, or an important missing component",
  "grounded_follow_up_2": "A second short spoken question probing a trade-off THIS design actually makes (pick the trade-off from their diagram, not a generic one), phrased for this candidate's experience level"`
      : ''
    const calibration = groundedOn ? buildFollowUpCalibration(domain, 'system-design', experience) : ''
    const expectedBlock = groundedOn && expectedComponents?.length
      ? `\nThe problem author expected components such as: ${expectedComponents.slice(0, 15).join(', ')}. If an important one is missing from the candidate's diagram, consider aiming a follow-up at that gap.\n`
      : ''

    try {
      const result = await completion({
        taskSlot: 'interview.evaluate-design',
        system: `${DATA_BOUNDARY_RULE}

You are a senior system design interviewer evaluating a candidate's architecture diagram. Evaluate the design strictly but fairly.

The candidate placed components on a canvas and drew connections between them. Their architecture is described below in text form.

${JSON_OUTPUT_RULE}
{
  "requirements_clarity": number (0-100, did they address the stated requirements?),
  "architecture": number (0-100, is the architecture sound and well-structured?),
  "scalability": number (0-100, can this design handle growth? load balancing, caching, etc.),
  "tradeoffs": number (0-100, did they consider trade-offs and alternatives?),
  "communication": number (0-100, is the design clear and well-organized?),
  "feedback": "3-4 sentences of specific feedback about the design",
  "missing_components": ["list of important components they should consider adding"],
  "follow_up_question": "A probing question about their design choices",
  "flags": ["specific issues found, e.g. 'single point of failure', 'no caching layer'"]${groundedContract}
}`,
        messages: [{
          role: 'user',
          content: `<problem>
Title: ${problemTitle}
${problemDescription}

Requirements:
${requirements.map((r) => `- ${r}`).join('\n')}
</problem>

<candidate_design>
${designText}
</candidate_design>
${calibration}${expectedBlock}
Evaluate this system design.`,
        }],
      })

      const raw = result.text || '{}'
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        return NextResponse.json({ error: 'Failed to parse evaluation' }, { status: 502 })
      }

      const evaluation = JSON.parse(jsonMatch[0])
      // Kill switch: never leak the grounded fields when the flag is off (or
      // the model returned non-strings) — absence makes the client fall back
      // to its hardcoded questions, byte-identical to today.
      if (!groundedOn || typeof evaluation.grounded_follow_up !== 'string' || !evaluation.grounded_follow_up.trim()) {
        delete evaluation.grounded_follow_up
      }
      if (!groundedOn || typeof evaluation.grounded_follow_up_2 !== 'string' || !evaluation.grounded_follow_up_2.trim()) {
        delete evaluation.grounded_follow_up_2
      }

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
      aiLogger.error({ err }, 'Design evaluation failed')
      return NextResponse.json({ error: 'Evaluation failed' }, { status: 500 })
    }
  },
})
