import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { saveDrillAttempt } from '@learn/services/drillService'
import { awardXp } from '@learn/services/xpService'
import { recordActivity, updateStreak } from '@learn/services/streakService'
import { checkAndAwardBadges } from '@learn/services/badgeService'
import { XP_AMOUNTS } from '@learn/config/xpTable'
import { streamCompletion } from '@shared/services/modelRouter'
import { aiLogger } from '@shared/logger'
import { JSON_OUTPUT_RULE } from '@shared/services/promptSecurity'

export const dynamic = 'force-dynamic'

/**
 * Wave 5 — type-guard on the LLM `scores` payload before we persist
 * it into `DrillAttempt.breakdown`. Validates THREE things:
 *
 *   1. Each field IS a number (typeof check rejects strings/null/undefined)
 *   2. Each field is FINITE (`typeof NaN === 'number'` slips past
 *      a naive typeof — Codex P1 on PR #388)
 *   3. Each field is in 0-100 (matches the schema's min/max bounds)
 */
function isFourDimScore(s: unknown): s is {
  relevance: number
  structure: number
  specificity: number
  ownership: number
} {
  if (!s || typeof s !== 'object') return false
  const r = s as Record<string, unknown>
  return (
    isValidDimScore(r.relevance) &&
    isValidDimScore(r.structure) &&
    isValidDimScore(r.specificity) &&
    isValidDimScore(r.ownership)
  )
}

function isValidDimScore(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100
}

/** Strip leading/trailing markdown code fences the LLM sometimes wraps
 *  its JSON output in. */
function stripFences(raw: string): string {
  return raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
}

interface DrillRequestBody {
  sessionId: string
  questionIndex?: number
  question: string
  originalAnswer?: string
  originalScore?: number
  newAnswer: string
  competency?: string
}

function buildPrompt(question: string, newAnswer: string): string {
  return `Score this interview answer on 4 dimensions (0-100 each):

Question: "${question}"

<candidate_answer>
${newAnswer}
</candidate_answer>

Score on:
- relevance: How directly does the answer address the question?
- structure: Does it follow STAR format (Situation, Task, Action, Result)?
- specificity: Are there concrete examples, metrics, and details?
- ownership: Does the candidate show personal contribution and accountability?

${JSON_OUTPUT_RULE}
{"relevance": number, "structure": number, "specificity": number, "ownership": number}`
}

const SYSTEM_PROMPT =
  "You are an expert interview coach. Score the candidate's answer objectively."

/**
 * Streaming SSE response. Default provider for `learn.drill-evaluate`
 * is OpenAI (native streaming via openai adapter); Anthropic fallback
 * polyfills via streamCompletion's complete()-as-single-delta shim.
 * Provider + fallback are CMS-overridable via /cms/model-config.
 *
 * Side-effects (Codex P1 on streaming PR): XP / streak / badges
 * fire ONLY after `saveDrillAttempt` succeeds. The original streaming
 * draft dispatched them at stream-start to overlap with the model,
 * but that granted progression rewards for evaluations that later
 * failed parsing / shape-check / persistence — a regression from the
 * sync path which only rewards a saved attempt. The user has already
 * seen all four scores progressively by the time `done` lands, so
 * moving rewards to post-save adds zero perceived latency.
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  let body: DrillRequestBody
  try {
    body = (await req.json()) as DrillRequestBody
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const { sessionId, question, newAnswer } = body
  if (!question || !newAnswer || !sessionId) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const userId = session.user.id
  const { questionIndex, originalAnswer, originalScore, competency } = body
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let accumulated = ''
      const emitted = new Set<string>()

      // Centralized SSE writer + close. Calling controller.close()
      // twice throws TypeError (WHATWG spec) — Vercel Agent flagged
      // the previous "close inside catch + close in finally" pattern.
      // We track `closed` and let the single outer `finally` close.
      let closed = false
      const sse = (event: string, data: unknown) => {
        if (closed) return
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        )
      }

      try {
        for await (const ev of streamCompletion(
          {
            taskSlot: 'learn.drill-evaluate',
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: buildPrompt(question, newAnswer) }],
          },
          req.signal,
        )) {
          if (ev.kind === 'delta') {
            accumulated += ev.text
            const scanBuffer = stripFences(accumulated)
            // `matchAll` returns a RegExpStringIterator which the
            // project's tsconfig won't iterate via for-of without
            // `downlevelIteration`. Materializing via Array.from is
            // simpler than touching tsconfig.
            const matches = Array.from(
              scanBuffer.matchAll(/"(relevance|structure|specificity|ownership)":\s*(\d+)/g),
            )
            for (const m of matches) {
              const dim = m[1]
              if (emitted.has(dim)) continue
              emitted.add(dim)
              sse('score', { dimension: dim, score: Number(m[2]) })
            }
          } else if (ev.kind === 'json_delta') {
            // Reserved for forced-JSON modes (Anthropic tool_use,
            // OpenAI json_schema strict). Drill route doesn't request
            // a structured response_format today, so this branch is
            // unreachable — kept here so the union is exhaustive.
            accumulated += ev.partialJson
          } else if (ev.kind === 'done') {
            const cleaned = stripFences(accumulated)
            let scores: unknown
            try {
              scores = JSON.parse(cleaned || '{}')
            } catch (parseErr) {
              aiLogger.error(
                { err: parseErr, accumulatedPrefix: accumulated.slice(0, 400) },
                'Drill stream: final JSON parse failed',
              )
              sse('error', { message: 'Evaluation failed (parse error)' })
              return
            }
            if (!isFourDimScore(scores)) {
              aiLogger.warn(
                { scoresPreview: typeof scores === 'object' ? JSON.stringify(scores).slice(0, 400) : String(scores) },
                'Drill stream: final scores failed shape validation',
              )
              sse('error', { message: 'Evaluation produced invalid scores' })
              return
            }
            const newScore = Math.round(
              (scores.relevance + scores.structure + scores.specificity + scores.ownership) / 4,
            )
            try {
              await saveDrillAttempt(userId, {
                sessionId,
                questionIndex: questionIndex ?? 0,
                question,
                originalAnswer: originalAnswer || '',
                originalScore: originalScore ?? 0,
                newAnswer,
                newScore,
                competency: competency || 'general',
                breakdown: scores,
              })
            } catch (saveErr) {
              aiLogger.error(
                { err: saveErr, userId, sessionId },
                'Drill stream: saveDrillAttempt failed',
              )
              // No XP / streak / badges here — Codex P1: don't reward
              // an attempt that didn't persist. User still sees scores.
              sse('complete', {
                newScore,
                delta: newScore - (originalScore ?? 0),
                breakdown: scores,
                persistFailed: true,
              })
              return
            }
            // Save succeeded — emit `complete` first so the user sees
            // the final state immediately, then run side-effects.
            // `allSettled` so any single failure (XP write, streak DB
            // hiccup, badge service) doesn't block close or surface
            // as an error frame.
            sse('complete', {
              newScore,
              delta: newScore - (originalScore ?? 0),
              breakdown: scores,
            })
            await Promise.allSettled([
              awardXp(userId, 'drill_complete', XP_AMOUNTS.drill_complete, { sessionId, questionIndex }),
              recordActivity(userId),
              updateStreak(userId).then((streakResult) =>
                checkAndAwardBadges(userId, {
                  type: 'drill_complete',
                  // Badges keyed on currentStreak, not raw score —
                  // score:0 is intentional and matches sync path.
                  score: 0,
                  currentStreak: streakResult.currentStreak,
                }),
              ),
            ])
          }
        }
      } catch (err) {
        if (req.signal.aborted) {
          aiLogger.info({ userId, sessionId }, 'Drill stream: client aborted')
        } else {
          aiLogger.error({ err, userId, sessionId }, 'Drill stream: upstream error')
          sse('error', { message: 'Evaluation failed' })
        }
      } finally {
        closed = true
        try {
          controller.close()
        } catch {
          // Already closed (e.g. underlying source rejected and the
          // stream tore itself down). Idempotent here so we never
          // surface a noisy 500.
        }
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disable Vercel's automatic gzip/brotli on this response —
      // SSE depends on the proxy not buffering.
      'X-Accel-Buffering': 'no',
    },
  })
}
