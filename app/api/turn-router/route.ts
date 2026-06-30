import { NextResponse } from 'next/server'
import { completion } from '@shared/services/modelRouter'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { trackUsage } from '@shared/services/usageTracking'
import { TurnRouterLlmSchema } from '@interview/validators/interview'
import { getSkillSections } from '@interview/services/core/skillLoader'
import { aiLogger } from '@shared/logger'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const TurnRouterSchema = z.object({
  question: z.string().min(1).max(2000),
  answer: z.string().min(0).max(10000),
  probeDepth: z.number().int().min(0).max(10).default(0),
  questionIndex: z.number().int().min(0).default(0),
  interviewType: z.string().max(50).default('behavioral'),
  // Domain slug — lets the router pull the per-domain×depth persona + question strategy so probes
  // are framework-aware (optional: older clients omit it → generic probe behaviour, unchanged).
  role: z.string().max(100).optional(),
  interruptContext: z.object({
    interruptSpeech: z.string().max(500),
    interruptedUtterance: z.string().max(2000),
    spokenPortion: z.string().max(2000),
  }).optional(),
})

type TurnRouterBody = z.infer<typeof TurnRouterSchema>

// ─── Turn Router ─────────────────────────────────────────────────────────────
//
// Fast conversational routing — the sole purpose is to decide "probe or advance"
// and supply a probe question sentence if probing. Runs in <400ms on Haiku.
//
// Payload is intentionally minimal: no JD, no resume, no profile, no scoring.
// Full evaluation still runs concurrently in the background via evaluate-answer.

const SYSTEM_PROMPT = `You are an expert interview turn router. Given a question and the candidate's answer, decide the next conversational move.

Decision rules:
- "probe" when: answer <25 words, vague/surface-level, no concrete example, evasive, pivot to unrelated topic, or the answer is nonsense/joke
- "advance" when: answer is substantive, specific, and addresses the question adequately

Additional signals to detect:
- isNonsensical: true only for jokes, gibberish, or intentionally absurd responses (not for short/weak answers)
- isPivot: true only when the answer is completely unrelated to the question topic

Style guidance:
- "curious": gentle open-ended probe ("Can you tell me more about X?")
- "probing": direct challenge for weak/vague answers ("What specifically did you do, and what was the measurable outcome?")
- "encouraging": supportive probe when candidate seems to struggle ("That's a start — can you walk me through a specific example?")
- "neutral": standard clarifying follow-up

If probing: write a natural follow-up question (max 18 words, conversational tone, no jargon).
Probe a concrete claim or missing detail from the candidate's answer; do not rephrase or re-ask the original interview question.
When an INTERVIEWER PERSONA & PROBE STRATEGY block is provided below, make the probe reflect it — push on the specific framework, mechanism, derivation, or concept-distinction it calls for, rather than a generic "tell me more" / "give an example". Stay on the subject the candidate's answer is about.
If isPivot: the probeQuestion should gently re-anchor to the original topic.
If the candidate is asking you to clarify a term or scope in the interview question, make probeQuestion a brief rephrase of the original question instead of evaluating it as an answer.

Return valid JSON only — no markdown, no explanation:
{"nextAction":"probe"|"advance","probeQuestion":"...","style":"curious"|"probing"|"encouraging"|"neutral","isNonsensical":false,"isPivot":false}`

export const POST = composeApiRoute<TurnRouterBody>({
  schema: TurnRouterSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 60, keyPrefix: 'rl:turn-router' },

  async handler(_req, { user, body }) {
    const { question, answer, probeDepth, questionIndex, interviewType, role, interruptContext } = body
    const startTime = Date.now()

    // Empty/very short answer → immediate probe without LLM call
    const trimmedAnswer = (answer || '').trim()
    if (trimmedAnswer.length < 8 && !interruptContext) {
      return NextResponse.json({
        nextAction: 'probe',
        probeQuestion: "Take your time — can you walk me through your thinking on that?",
        style: 'encouraging',
        isNonsensical: false,
        isPivot: false,
      })
    }

    // Probe grounding: pull the interviewer persona + question strategy for this domain×depth so the
    // follow-up probes in the round's voice and pushes on the right frameworks/mechanisms (e.g.
    // "derive CLV", "positioning vs differentiation") rather than a generic "give an example".
    // Skipped when role is absent (older clients) → unchanged generic behaviour. Adds one cached
    // skill-file read; probe-start latency tuning is tracked as a separate follow-up.
    let probeGrounding = ''
    if (role) {
      try {
        const skill = await getSkillSections(role, interviewType, ['interviewer-persona', 'question-strategy'])
        if (skill) {
          probeGrounding = `\n\nINTERVIEWER PERSONA & PROBE STRATEGY for this round (probe in this voice; push on the framework/mechanism/derivation/distinction it describes):\n${skill}`
        }
      } catch { /* skill file unavailable — fall back to generic probe */ }
    }

    let userPrompt = `Interview type: ${interviewType}
Probe depth: ${probeDepth} (${probeDepth >= 2 ? 'deep — only probe if truly critical' : probeDepth === 1 ? 'mid — prefer specific clarification' : 'first probe — prefer broad expansion'})
Question index: ${questionIndex}

Question: ${question}

Candidate answer: ${trimmedAnswer}${probeGrounding}`

    // When the candidate interrupted AI speech, add context so the model
    // can decide how to handle the interruption.
    if (interruptContext) {
      userPrompt += `

CANDIDATE INTERRUPTED while you were speaking.
You were saying: "${interruptContext.interruptedUtterance}"
The candidate said: "${interruptContext.interruptSpeech}"

Decide interruptResolution:
- "finish_then_address": your remaining words matter — finish thought, then address their point
- "abort_and_pivot": drop your speech, respond directly to what they said
- "acknowledge_defer": say "Good point — let me finish this thought and we'll circle back"
- "absorbed": the interruption is noise/irrelevant — continue where you left off

Add "interruptResolution" to your JSON response.`
    }

    try {
      const result = await completion({
        taskSlot: 'interview.turn-router',
        messages: [{ role: 'user', content: userPrompt }],
        system: SYSTEM_PROMPT,
        temperature: 0,
      })

      const durationMs = Date.now() - startTime

      void trackUsage({
        user,
        type: 'api_call_question',
        inputTokens: result.inputTokens ?? 0,
        outputTokens: result.outputTokens ?? 0,
        modelUsed: result.model ?? 'gpt-5.4-mini',
        durationMs,
        success: true,
      })

      // Parse — strip markdown fences if model adds them
      const raw = result.text.trim().replace(/^```json?\s*/i, '').replace(/\s*```$/, '')
      // G.2: parse then Zod-validate. Parse failure falls through to the
      // outer catch (fail-open advance). Zod failure is non-fatal — we log
      // the drift and continue with the raw parsed object. The existing
      // `?? 'advance'` / `?? 'neutral'` fallbacks below handle missing or
      // unexpected field values.
      const parsedRaw = JSON.parse(raw) as Record<string, unknown>
      const parsedLlm = TurnRouterLlmSchema.safeParse(parsedRaw)
      if (!parsedLlm.success) {
        aiLogger.warn(
          {
            issues: parsedLlm.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
            raw: raw.slice(0, 300),
          },
          'turn-router: LLM response failed Zod validation — continuing with raw object',
        )
      }
      const parsed = parsedRaw as {
        nextAction?: 'probe' | 'advance'
        probeQuestion?: string
        style?: 'curious' | 'probing' | 'encouraging' | 'neutral'
        isNonsensical?: boolean
        isPivot?: boolean
        interruptResolution?: 'finish_then_address' | 'abort_and_pivot' | 'acknowledge_defer' | 'absorbed'
      }

      return NextResponse.json({
        nextAction: parsed.nextAction ?? 'advance',
        probeQuestion: parsed.probeQuestion ?? undefined,
        style: parsed.style ?? 'neutral',
        isNonsensical: parsed.isNonsensical === true,
        isPivot: parsed.isPivot === true,
        ...(interruptContext && {
          interruptResolution: parsed.interruptResolution ?? 'abort_and_pivot',
        }),
      })
    } catch (err) {
      void trackUsage({
        user,
        type: 'api_call_question',
        inputTokens: 0,
        outputTokens: 0,
        modelUsed: 'gpt-5.4-mini',
        durationMs: Date.now() - startTime,
        success: false,
        errorMessage: err instanceof Error ? err.message : 'unknown',
      })

      // Fail-open: advance on any error so the conversation doesn't break
      return NextResponse.json({
        nextAction: 'advance',
        probeQuestion: undefined,
        style: 'neutral',
        isNonsensical: false,
        isPivot: false,
      })
    }
  },
})
