import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { saveDrillAttempt } from '@learn/services/drillService'
import { awardXp } from '@learn/services/xpService'
import { recordActivity, updateStreak } from '@learn/services/streakService'
import { checkAndAwardBadges } from '@learn/services/badgeService'
import { XP_AMOUNTS } from '@learn/config/xpTable'
import { completion, streamCompletion } from '@shared/services/modelRouter'
import { aiLogger } from '@shared/logger'
import { JSON_OUTPUT_RULE } from '@shared/services/promptSecurity'
import { isFeatureEnabled } from '@shared/featureFlags'

export const dynamic = 'force-dynamic'

/**
 * Wave 5 — type-guard on the LLM `scores` payload before we persist
 * it into `DrillAttempt.breakdown`. Validates THREE things:
 *
 *   1. Each field IS a number (typeof check rejects strings/null/undefined)
 *   2. Each field is FINITE (`typeof NaN === 'number'` slips past
 *      a naive typeof — Codex P1 on PR #388)
 *   3. Each field is in 0-100 (matches the schema's min/max bounds)
 *
 * On any drift we drop `breakdown` entirely; the avg `newScore` path
 * remains intact (honest degradation rather than 500ing the save).
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

/**
 * Strip leading/trailing markdown code fences the LLM sometimes wraps
 * its JSON output in. Same shape the non-streaming path uses; pulled
 * out into a helper so the streaming path can apply it identically.
 */
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

interface ValidatedBody extends DrillRequestBody {
  userId: string
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

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = (await req.json()) as DrillRequestBody
    const { sessionId, question, newAnswer } = body
    if (!question || !newAnswer || !sessionId) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    const validated: ValidatedBody = { ...body, userId: session.user.id }

    // Wave 5 / streaming evaluator — when the flag is on AND the
    // CMS-resolved provider for `learn.drill-evaluate` has a native
    // streaming adapter, run the SSE branch. Otherwise the request
    // collapses to the synchronous branch with zero change in
    // behaviour (the polyfill path inside streamCompletion would
    // make this work even when the flag is on for non-streaming
    // providers, but we keep the explicit flag gate so we can
    // disable streaming completely with one env-var flip).
    if (isFeatureEnabled('drill_streaming')) {
      return handleStreamingEval(req, validated)
    }
    return handleSynchronousEval(validated)
  } catch (err) {
    aiLogger.error({ err }, 'Drill evaluate error')
    return NextResponse.json({ error: 'Evaluation failed' }, { status: 500 })
  }
}

/**
 * Original synchronous path. Unchanged behaviour from the pre-Wave-5
 * streaming PR — `completion()` → parse → save → side-effects →
 * JSON response. Kept around so the feature flag can fail back here
 * with zero risk of regression if the streaming branch misbehaves.
 */
async function handleSynchronousEval(body: ValidatedBody) {
  const { userId, sessionId, questionIndex, question, originalAnswer, originalScore, newAnswer, competency } = body

  const aiResult = await completion({
    taskSlot: 'learn.drill-evaluate',
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildPrompt(question, newAnswer) }],
  })

  const raw = aiResult.text || '{}'
  const cleaned = stripFences(raw)
  const scores = JSON.parse(cleaned)

  const newScore = Math.round(
    (scores.relevance + scores.structure + scores.specificity + scores.ownership) / 4,
  )

  const result = await saveDrillAttempt(userId, {
    sessionId,
    questionIndex: questionIndex ?? 0,
    question,
    originalAnswer: originalAnswer || '',
    originalScore: originalScore ?? 0,
    newAnswer,
    newScore,
    competency: competency || 'general',
    ...(isFourDimScore(scores) && { breakdown: scores }),
  })

  await awardXp(userId, 'drill_complete', XP_AMOUNTS.drill_complete, {
    sessionId,
    questionIndex,
  })
  await recordActivity(userId)
  const streakResult = await updateStreak(userId)
  await checkAndAwardBadges(userId, {
    type: 'drill_complete',
    score: newScore,
    currentStreak: streakResult.currentStreak,
  })

  return NextResponse.json({
    ...result,
    newScore,
    delta: newScore - (originalScore ?? 0),
    breakdown: scores,
  })
}

/**
 * Streaming path (Phase 1 — OpenAI native; other providers polyfill
 * via streamCompletion's `complete()` fallback inside the iterator).
 *
 * The route returns `text/event-stream`. As the model emits text
 * chunks we accumulate into a buffer and scan for each per-dimension
 * `"name": N` pair, emitting one `event: score` per dim AS SOON AS it
 * is complete in the buffer. On the terminal `done` event we parse
 * the final scores, run `saveDrillAttempt` (cluster C), emit
 * `event: complete`, then await the score-independent side-effect
 * clusters in parallel before closing the stream.
 *
 * Side-effect cluster partitioning (Plan agent on the streaming
 * plan):
 *   - Cluster A (xp + recordActivity): score-independent, dispatched
 *     immediately on stream start, awaited at the end via
 *     allSettled so a single failure doesn't sink the complete event.
 *   - Cluster B (updateStreak → checkAndAwardBadges): order-dependent
 *     but score-independent (we pass score:0 because badges trigger
 *     on streak milestones not raw drill score), dispatched early.
 *   - Cluster C (saveDrillAttempt): requires newScore. Awaited in
 *     the `done` handler BEFORE emitting `complete`. On failure we
 *     still emit `complete` with `persistFailed:true` so the UI
 *     doesn't lose what the user already saw on screen.
 */
async function handleStreamingEval(req: NextRequest, body: ValidatedBody) {
  const { userId, sessionId, questionIndex, question, originalAnswer, originalScore, newAnswer, competency } = body
  const encoder = new TextEncoder()

  // Dispatched immediately; awaited in `done` handler.
  const clusterA = Promise.allSettled([
    awardXp(userId, 'drill_complete', XP_AMOUNTS.drill_complete, { sessionId, questionIndex }),
    recordActivity(userId),
  ])
  const clusterB = updateStreak(userId).then((streakResult) =>
    checkAndAwardBadges(userId, {
      type: 'drill_complete',
      // Badges keyed on `currentStreak`; the score field is unused
      // for drill-completion badges. Passing 0 keeps the signature
      // intact without falsely advertising a "0 score" achievement.
      score: 0,
      currentStreak: streakResult.currentStreak,
    }),
  )

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let accumulated = ''
      const emitted = new Set<string>()

      const sse = (event: string, data: unknown) => {
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
            // Scan-buffer with the same fence-strip the non-streaming
            // path uses so a partial ```json prefix doesn't trip the
            // dim regex. (Done on a derived buffer; we keep
            // `accumulated` intact for the final parse.)
            const scanBuffer = stripFences(accumulated)
            // `matchAll` returns a RegExpStringIterator which the
            // project's tsconfig won't iterate via for-of without
            // `downlevelIteration`. Materializing via Array.from is
            // simpler than touching tsconfig, and the buffer is
            // small enough that the array allocation is negligible.
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
            // Phase 2 — Anthropic tool_use mode. Drill route doesn't
            // request a structured response_format today, so this
            // branch is unreachable in Phase 1. Kept here so the
            // contract is exhaustive on the union.
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
              controller.close()
              return
            }
            if (!isFourDimScore(scores)) {
              aiLogger.warn(
                { scoresPreview: typeof scores === 'object' ? JSON.stringify(scores).slice(0, 400) : String(scores) },
                'Drill stream: final scores failed shape validation',
              )
              sse('error', { message: 'Evaluation produced invalid scores' })
              controller.close()
              return
            }
            const newScore = Math.round(
              (scores.relevance + scores.structure + scores.specificity + scores.ownership) / 4,
            )
            // Cluster C — must persist before `complete` so the client
            // is told the attempt is durable.
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
              // Plan-agent decision: still emit `complete` with the
              // breakdown so the user sees their score, but flag
              // `persistFailed` so the UI can surface a "this attempt
              // didn't save, retry to record it" hint.
              sse('complete', {
                newScore,
                delta: newScore - (originalScore ?? 0),
                breakdown: scores,
                persistFailed: true,
              })
              controller.close()
              return
            }
            // Wait for clusters A + B to settle before closing the
            // stream. We don't block the `complete` event on them
            // (allSettled won't reject), but we DO want them to land
            // before the request lifecycle ends — otherwise the next
            // Lambda freeze could starve their fire-and-forget DB
            // writes.
            await Promise.allSettled([clusterA, clusterB])
            sse('complete', {
              newScore,
              delta: newScore - (originalScore ?? 0),
              breakdown: scores,
            })
          }
        }
      } catch (err) {
        // Either streamCompletion threw (LLM error after first byte —
        // no fallback possible) or req.signal aborted. Distinguish so
        // we don't log normal client-disconnects as errors.
        if (req.signal.aborted) {
          aiLogger.info({ userId, sessionId }, 'Drill stream: client aborted')
        } else {
          aiLogger.error({ err, userId, sessionId }, 'Drill stream: upstream error')
          sse('error', { message: 'Evaluation failed' })
        }
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disable Vercel's automatic gzip/brotli on this response —
      // SSE depends on the proxy not buffering, and compression
      // forces buffering at the edge.
      'X-Accel-Buffering': 'no',
    },
  })
}
