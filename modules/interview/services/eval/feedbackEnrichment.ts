import { completion } from '@shared/services/modelRouter'
import { DATA_BOUNDARY_RULE, JSON_OUTPUT_RULE } from '@shared/services/promptSecurity'
import { FEEDBACK_ENRICHMENT_RESPONSE_FORMAT } from '@interview/config/feedbackJsonSchemas'

/**
 * Feedback enrichment core — ideal_answers + drill_recommendations.
 *
 * Extracted from app/api/generate-feedback/route.ts (2026-07-17) when
 * enrichment moved off the request path onto the `feedback/enrich.requested`
 * Inngest job. The content is authored teaching material, so this is the one
 * enrichment path and it runs at full quality: reasoningEffort 'high' with a
 * budget sized for the WORST case, not the typical one.
 *
 * Worst-case sizing (30-minute interviews, the founder-mandated envelope):
 * a 30-min session can answer enough questions to saturate the weak-question
 * cap (10). 10 ideal_answers × ~300-350 output tokens ≈ 3,500, plus 2-3
 * drill_recommendations ≈ 500, plus 'high' reasoning tokens which OpenAI
 * bills against max_completion_tokens (observed in the thousands on
 * gpt-5.6-luna for generation this size). 12,000 keeps truncation — the
 * G.2/G.6 failure class — out of reach at every interview duration.
 *
 * There is deliberately NO caller-side timeout here: this function runs
 * inside an Inngest step (own invocation, ~300s budget on Vercel, unbounded
 * on the VM, retried by Inngest). Latency is the job's problem, never the
 * user's. Do not add a Promise.race — that pattern belongs to request-path
 * calls only, and mis-sized races caused the 2026-07-11→17 outages.
 */

const WEAK_QUESTION_CAP = 10
const ENRICHMENT_MAX_TOKENS = 12_000

export interface EnrichmentEvaluation {
  [key: string]: unknown
}

export interface EnrichmentResult {
  ideal_answers: Array<Record<string, unknown>>
  drill_recommendations: Array<Record<string, unknown>>
  usage: { inputTokens: number; outputTokens: number }
  model: string
}

function scoreForEvaluation(e: Record<string, unknown>): number {
  return Math.round((
    (Number(e.relevance) || 0) +
    (Number(e.structure) || 0) +
    (Number(e.specificity) || 0) +
    (Number(e.ownership) || 0)
  ) / 4)
}

/**
 * Build the LLM context block listing weak questions (avg < 60).
 *
 * Same semantics as the pre-async inline version (2026-05-19 "all weak
 * questions" widening): one entry per weak question, capped at 10, weakest
 * first. Caps bound the prompt at every interview duration — a 30-minute
 * session hits the cap, it does not blow past it.
 */
export function weakestQuestionContext(
  evaluations: EnrichmentEvaluation[],
  cap = WEAK_QUESTION_CAP,
): string {
  return evaluations
    .filter((e) => e.status !== 'failed')
    .map((e) => ({ e, score: scoreForEvaluation(e) }))
    .filter(({ score }) => score < 60)
    .sort((a, b) => a.score - b.score || Number(a.e.questionIndex ?? 0) - Number(b.e.questionIndex ?? 0))
    .slice(0, cap)
    .map(({ e, score }) => {
      const questionIndex = Number(e.questionIndex ?? 0)
      const question = String(e.question ?? '').replace(/\s+/g, ' ').slice(0, 320)
      const answer = String(e.answerSummary || e.answer || '').replace(/\s+/g, ' ').slice(0, 700)
      return `Q${questionIndex + 1} (avg ${score})\nQuestion: ${question}\nAnswer evidence: ${answer}`
    })
    .join('\n\n')
}

function stripJsonFences(raw: string): string {
  return raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')
}

/**
 * Run the full-quality enrichment generation. Returns null-equivalent empty
 * arrays only when there are no weak questions (nothing to generate).
 * Throws on LLM/parse failure — the Inngest job turns that into retries and,
 * ultimately, an explicit enrichmentStatus:'failed' on the session.
 */
export async function runFeedbackEnrichment(params: {
  evaluations: EnrichmentEvaluation[]
  domainLabel: string
  interviewType: string
}): Promise<EnrichmentResult | null> {
  const targetContext = weakestQuestionContext(params.evaluations)
  if (!targetContext) {
    return null
  }

  const system = `You are an expert interview coach writing supplemental study material for a candidate who has just received scored feedback.

${DATA_BOUNDARY_RULE}

${JSON_OUTPUT_RULE}

Generate only supplemental coaching enrichment. Keep it schema-conformant.`

  const userPrompt = `Create supplemental feedback for this ${params.domainLabel} ${params.interviewType} interview.

Weak-question evidence (all answers with avg score < 60):
${targetContext}

Return ONE ideal_answer for EACH weak question listed above (match by questionIndex), plus 2-3 drill_recommendations. Each drill must have exactly two practice questions.

For EACH drill_recommendation, populate \`targetQuestions\` with the 0-based questionIndex values from the weak-question evidence above that this drill addresses. Use an empty array \`[]\` ONLY when the drill is genuinely cross-cutting (e.g. a general delivery drill not tied to any specific question). Prefer 1-2 entries when a clear question-to-drill mapping exists.`

  const result = await completion({
    taskSlot: 'interview.generate-feedback',
    // Full quality by design: enrichment is authored teaching content and
    // nothing waits on it here. See sizing note in the module header.
    reasoningEffort: 'high',
    system,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens: ENRICHMENT_MAX_TOKENS,
    responseFormat: FEEDBACK_ENRICHMENT_RESPONSE_FORMAT,
  })

  if (result.truncated) {
    throw new Error('Feedback enrichment response was truncated')
  }
  const parsed = JSON.parse(stripJsonFences(result.text || '{}')) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Feedback enrichment response was not a JSON object')
  }
  const record = parsed as Record<string, unknown>
  return {
    ideal_answers: Array.isArray(record.ideal_answers) ? (record.ideal_answers as Array<Record<string, unknown>>) : [],
    drill_recommendations: Array.isArray(record.drill_recommendations) ? (record.drill_recommendations as Array<Record<string, unknown>>) : [],
    usage: {
      inputTokens: result.inputTokens ?? 0,
      outputTokens: result.outputTokens ?? 0,
    },
    model: result.model ?? 'unknown',
  }
}
