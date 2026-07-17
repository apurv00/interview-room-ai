import { completion } from '@shared/services/modelRouter'
import { DATA_BOUNDARY_RULE } from '@shared/services/promptSecurity'
import { logger } from '@shared/logger'
import type { JsonSchema } from '@shared/services/providers'

/**
 * JIT (just-in-time) backfill for a single missing `ideal_answers` entry.
 *
 * The batch enrichment in /api/generate-feedback runs once at interview
 * end and is best-effort: it routinely returns partial coverage (the
 * model picks the worst 3-4 and skips others) even though the prompt
 * asks for one entry per weak question. Pre-May-19 sessions also only
 * have top-3 outlines from the older "top-3 only" enrichment.
 *
 * Result: a drill question with avg < 60 frequently has no
 * `feedback.ideal_answers[i]` and falls back to the lighter
 * `QuestionInsightStrip`. Users flagged this as a visible regression
 * ("A lot of drill mode questions does not have Strong answer outline.").
 *
 * This helper generates ONE outline on demand when the drill context
 * route detects a missing entry. Single-question LLM call:
 *   - ~200-350 output tokens (vs the batch call's ~1500-2800)
 *   - haiku-class slot via `interview.generate-feedback`
 *   - 6s wall-clock cap so the drill page never feels frozen
 *
 * Returns null on any error/timeout/truncation. The caller (route) is
 * expected to fall back to `QuestionInsightStrip` in that case — same
 * UX as the existing batch-only world.
 */

const SINGLE_IDEAL_ANSWER_RESPONSE_FORMAT = {
  type: 'json_schema' as const,
  name: 'single_ideal_answer',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['strongAnswer', 'keyElements'],
    properties: {
      strongAnswer: { type: 'string' },
      keyElements: { type: 'array', items: { type: 'string' } },
    },
  } satisfies JsonSchema,
}

const BACKFILL_TIMEOUT_MS = 6000

export interface IdealAnswerBackfillInput {
  question: string
  candidateAnswer: string
  domainLabel: string
  interviewType: string
  /** Optional — only used for log context. */
  sessionId?: string
  /** Optional — only used for log context. */
  questionIndex?: number
}

export interface IdealAnswerBackfillResult {
  strongAnswer: string
  keyElements: string[]
}

export async function generateIdealAnswerForQuestion(
  input: IdealAnswerBackfillInput,
): Promise<IdealAnswerBackfillResult | null> {
  // The candidate's actual answer is included as evidence so the model
  // can write an outline that directly addresses what the candidate
  // missed — not a generic "perfect answer in a vacuum". Truncate to
  // 700 chars to bound the prompt (matches the batch enrichment cap).
  const trimmedAnswer = (input.candidateAnswer ?? '').replace(/\s+/g, ' ').trim().slice(0, 700)
  const trimmedQuestion = (input.question ?? '').replace(/\s+/g, ' ').trim().slice(0, 400)

  if (!trimmedQuestion) {
    return null
  }

  const system = `${DATA_BOUNDARY_RULE}

You are an interview coach. Given ONE interview question and the candidate's actual answer, write a single "strong-answer outline" the candidate can study before retrying.

Rules:
- The outline must be 2-4 sentences, written as a single paragraph from the candidate's perspective ("I prioritized…", "I chose…", "After launch…").
- It must directly address what the candidate's actual answer was missing (be specific to the evidence — do not produce generic STAR-framework boilerplate).
- Include at least one concrete metric or outcome.
- Then list 3-5 "key elements" — short noun phrases (3-7 words each) describing the moves that make a strong answer to THIS question.
- Return JSON matching the schema. No prose outside JSON.`

  const userPrompt = `Domain: ${input.domainLabel}
Interview type: ${input.interviewType}

Question:
${trimmedQuestion}

Candidate's actual answer:
${trimmedAnswer || '(no transcript captured)'}

Write the outline and key elements for this one question.`

  let timeoutHandle: NodeJS.Timeout | undefined
  try {
    const llmCall = completion({
        taskSlot: 'interview.generate-feedback',
        // JIT backfill blocks the drill page (6s cap below, by design):
        // without this per-call override it inherits the slot's
        // reasoningEffort 'high', which cannot finish inside 6s — every
        // backfill timed out 2026-07-11→17 (third call site of the slot
        // found in the full-slot audit; same class as fusion/enrichment).
        // 'none' keeps the interactive path snappy; deep-reasoning
        // exemplars belong to the async enrichment backfill, never to a
        // user-blocking call.
        reasoningEffort: 'none',
        system,
        messages: [{ role: 'user', content: userPrompt }],
        // Single-question outlines fit in 600 tokens easily. Headroom
        // keeps a verbose model from truncating.
        maxTokens: 900,
        responseFormat: SINGLE_IDEAL_ANSWER_RESPONSE_FORMAT,
      })
    // Same ghost-promise guard as the batch enrichment: the losing racer
    // cannot be aborted and its post-teardown rejection would surface as
    // an unhandledRejection.
    llmCall.catch(() => {})
    const result = await Promise.race([
      llmCall,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`ideal_answer backfill timed out after ${BACKFILL_TIMEOUT_MS}ms`)),
          BACKFILL_TIMEOUT_MS,
        )
      }),
    ])
    if (timeoutHandle) clearTimeout(timeoutHandle)
    if (result.truncated) {
      logger.warn(
        { sessionId: input.sessionId, questionIndex: input.questionIndex },
        'ideal_answer backfill: response truncated; falling back to QuestionInsightStrip',
      )
      return null
    }

    const parsed = safeParseJson(result.text)
    if (!parsed) return null

    const strongAnswer = typeof parsed.strongAnswer === 'string' ? parsed.strongAnswer.trim() : ''
    const keyElementsRaw = Array.isArray(parsed.keyElements) ? parsed.keyElements : []
    const keyElements = keyElementsRaw
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      .map((s) => s.trim())

    if (!strongAnswer || keyElements.length === 0) {
      return null
    }
    return { strongAnswer, keyElements }
  } catch (err) {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    logger.warn(
      { err, sessionId: input.sessionId, questionIndex: input.questionIndex },
      'ideal_answer backfill: LLM call failed; falling back to QuestionInsightStrip',
    )
    return null
  }
}

function safeParseJson(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}
