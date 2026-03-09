import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { composeApiRoute } from '@/lib/middleware/composeApiRoute'
import { EvaluateAnswerSchema } from '@/lib/validators/interview'
import { trackUsage } from '@/lib/services/usageTracking'
import { aiLogger } from '@/lib/logger'
import type { AnswerEvaluation } from '@/lib/types'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const client = new Anthropic()

type EvaluateAnswerBody = z.infer<typeof EvaluateAnswerSchema>

export const POST = composeApiRoute<EvaluateAnswerBody>({
  schema: EvaluateAnswerSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 30, keyPrefix: 'rl:eval' },
  authOptional: true,

  async handler(req, { user, body }) {
    const { config, question, answer, questionIndex } = body
    const startTime = Date.now()

    // Build JD context if available
    let jdContext = ''
    if (config.jobDescription) {
      jdContext = `\n\nJOB DESCRIPTION (excerpt):\n${config.jobDescription.slice(0, 3000)}\n\nUse this JD to evaluate how well the answer aligns with the role's requirements.`
    }

    const systemPrompt = `You are an expert interview coach evaluating candidates for ${config.role} roles at the ${config.experience} experience level. You score objectively and fairly.${jdContext}`

    const jdAlignmentDimension = config.jobDescription
      ? `\n- jdAlignment: How well does this answer demonstrate skills/experience relevant to the job description requirements? (integer 0-100)`
      : ''

    const jdAlignmentSchema = config.jobDescription
      ? `\n  "jdAlignment": number,`
      : ''

    const userPrompt = `Evaluate this interview answer:

Question: "${question}"

Candidate's answer: "${answer}"

Score on these dimensions (integer 0–100):
- relevance: How well does the answer address the question?
- structure: Does it follow STAR (Situation, Task, Action, Result)?
- specificity: Are there concrete metrics, numbers, or named examples?
- ownership: Does the candidate use "I" (not "we") and show personal accountability?${jdAlignmentDimension}

Also determine:
- needsFollowUp: true if the answer is vague, too short (<30 words), evasive, or missing key info
- followUpQuestion: if needsFollowUp is true, provide a concise probing follow-up (one sentence)
- flags: array of red-flag strings (e.g. "Blame-shifting", "No measurable impact", "Inconsistency detected"). Empty array if none.

Respond with ONLY valid JSON matching this schema:
{
  "relevance": number,
  "structure": number,
  "specificity": number,
  "ownership": number,${jdAlignmentSchema}
  "needsFollowUp": boolean,
  "followUpQuestion": string | null,
  "flags": string[]
}`

    try {
      const message = await client.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 400,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      })

      const raw = message.content[0].type === 'text' ? message.content[0].text.trim() : '{}'
      const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
      const scores = JSON.parse(cleaned)

      const evaluation: AnswerEvaluation = {
        questionIndex,
        question,
        answer,
        relevance: scores.relevance ?? 50,
        structure: scores.structure ?? 50,
        specificity: scores.specificity ?? 50,
        ownership: scores.ownership ?? 50,
        ...(scores.jdAlignment !== undefined && { jdAlignment: scores.jdAlignment }),
        needsFollowUp: scores.needsFollowUp ?? false,
        followUpQuestion: scores.followUpQuestion ?? undefined,
        flags: scores.flags ?? [],
      }

      trackUsage({
        user,
        type: 'api_call_evaluate',
        sessionId: body.sessionId,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        modelUsed: 'claude-opus-4-6',
        durationMs: Date.now() - startTime,
        success: true,
      }).catch(() => {})

      return NextResponse.json(evaluation)
    } catch (err) {
      aiLogger.error({ err }, 'Claude API error in evaluate-answer')

      trackUsage({
        user,
        type: 'api_call_evaluate',
        sessionId: body.sessionId,
        inputTokens: 0,
        outputTokens: 0,
        modelUsed: 'claude-opus-4-6',
        durationMs: Date.now() - startTime,
        success: false,
        errorMessage: err instanceof Error ? err.message : 'Unknown error',
      }).catch(() => {})

      // Neutral fallback so the interview continues
      return NextResponse.json({
        questionIndex,
        question,
        answer,
        relevance: 60,
        structure: 55,
        specificity: 55,
        ownership: 60,
        needsFollowUp: false,
        flags: [],
      } as AnswerEvaluation)
    }
  },
})
