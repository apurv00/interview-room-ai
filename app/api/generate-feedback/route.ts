import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { composeApiRoute } from '@/lib/middleware/composeApiRoute'
import { GenerateFeedbackSchema } from '@/lib/validators/interview'
import { trackUsage } from '@/lib/services/usageTracking'
import { aiLogger } from '@/lib/logger'
import type { FeedbackData } from '@/lib/types'
import { aggregateMetrics, communicationScore } from '@/lib/speechMetrics'
import { PRESSURE_QUESTION_INDEX } from '@/lib/interviewConfig'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const client = new Anthropic()

type GenerateFeedbackBody = z.infer<typeof GenerateFeedbackSchema>

/**
 * Pre-compute engagement-related speech analytics per question.
 */
function computeEngagementContext(
  speechMetrics: Record<string, unknown>[],
  evaluations: Record<string, unknown>[],
  pressureIdx: number
) {
  if (!speechMetrics.length) {
    return {
      perQSummary: 'No per-question speech metrics available.',
      pressureContext: '',
    }
  }

  const perQ = speechMetrics.map((m, i) => {
    const wpm = Number(m.wpm) || 0
    const fillerRate = Number(m.fillerRate) || 0
    const totalWords = Number(m.totalWords) || 0
    const durationMinutes = Number(m.durationMinutes) || 0
    return `  Q${i + 1}: WPM=${wpm}, filler_rate=${(fillerRate * 100).toFixed(1)}%, words=${totalWords}, duration=${durationMinutes.toFixed(1)}min`
  })

  // First half vs second half trends
  const halfIdx = Math.ceil(speechMetrics.length / 2)
  const firstHalf = speechMetrics.slice(0, halfIdx)
  const secondHalf = speechMetrics.slice(halfIdx)

  const avgFillerFirst = firstHalf.reduce((s, m) => s + (Number(m.fillerRate) || 0), 0) / (firstHalf.length || 1)
  const avgFillerSecond = secondHalf.reduce((s, m) => s + (Number(m.fillerRate) || 0), 0) / (secondHalf.length || 1)
  const avgWordsFirst = firstHalf.reduce((s, m) => s + (Number(m.totalWords) || 0), 0) / (firstHalf.length || 1)
  const avgWordsSecond = secondHalf.reduce((s, m) => s + (Number(m.totalWords) || 0), 0) / (secondHalf.length || 1)

  // Pressure question performance
  let pressureContext = ''
  if (pressureIdx < evaluations.length) {
    const pEval = evaluations[pressureIdx]
    const pMetrics = speechMetrics[pressureIdx]
    if (pEval && pMetrics) {
      const avgNormalScore = evaluations
        .filter((_, i) => i !== pressureIdx)
        .reduce((s, e) => {
          const rel = Number(e.relevance) || 0
          const str = Number(e.structure) || 0
          const spc = Number(e.specificity) || 0
          const own = Number(e.ownership) || 0
          return s + (rel + str + spc + own) / 4
        }, 0) / (Math.max(1, evaluations.length - 1))
      const pressureScore = ((Number(pEval.relevance) || 0) + (Number(pEval.structure) || 0) + (Number(pEval.specificity) || 0) + (Number(pEval.ownership) || 0)) / 4
      pressureContext = `\nPressure question (Q${pressureIdx + 1}) avg score: ${pressureScore.toFixed(0)} vs normal avg: ${avgNormalScore.toFixed(0)}`
    }
  }

  return {
    perQSummary: `Per-question speech patterns:\n${perQ.join('\n')}\n\nTrends (first-half → second-half):\n  Filler rate: ${(avgFillerFirst * 100).toFixed(1)}% → ${(avgFillerSecond * 100).toFixed(1)}%\n  Avg answer length: ${avgWordsFirst.toFixed(0)} → ${avgWordsSecond.toFixed(0)} words`,
    pressureContext,
  }
}

export const POST = composeApiRoute<GenerateFeedbackBody>({
  schema: GenerateFeedbackSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 5, keyPrefix: 'rl:feedback' },

  async handler(req, { user, body }) {
    const { config, transcript, evaluations, speechMetrics } = body
    const startTime = Date.now()

    // Pre-compute communication metrics
    const aggMetrics = aggregateMetrics(speechMetrics)
    const commScore = communicationScore(aggMetrics)

    // Pre-compute engagement context
    const pressureIdx = PRESSURE_QUESTION_INDEX[config.duration] ?? 0
    const { perQSummary, pressureContext } = computeEngagementContext(speechMetrics, evaluations, pressureIdx)

    const evalSummary = evaluations
      .map(
        (e: Record<string, unknown>, i: number) =>
          `Q${i + 1}: "${String(e.question || '').slice(0, 80)}..." → relevance:${e.relevance} structure:${e.structure} specificity:${e.specificity} ownership:${e.ownership}${e.jdAlignment !== undefined ? ` jdAlignment:${e.jdAlignment}` : ''} flags:[${Array.isArray(e.flags) ? e.flags.join(', ') : ''}]`
      )
      .join('\n')

    const transcriptText = transcript
      .map((e) => `${e.speaker === 'interviewer' ? 'Interviewer' : 'Candidate'}: ${e.text}`)
      .join('\n')

    // Build JD context if available
    let jdBlock = ''
    let jdSchemaBlock = ''
    if (config.jobDescription) {
      jdBlock = `\n\nJOB DESCRIPTION (excerpt):\n${config.jobDescription.slice(0, 3000)}\n\nEvaluate how well the candidate's answers align with the JD requirements.`
      jdSchemaBlock = `,
  "jd_match_score": <integer 0-100, overall alignment with JD requirements>,
  "jd_requirement_breakdown": [
    { "requirement": "<key requirement from JD>", "matched": <true/false>, "evidence": "<brief evidence from candidate's answers or null>" }
  ]`
    }

    const systemPrompt = `You are an expert interview coach. Generate honest, specific, and actionable feedback for a candidate.${jdBlock}`

    const userPrompt = `Interview summary for ${config.role} (${config.experience} yrs), ${config.duration}-min session.

Per-question evaluation scores:
${evalSummary}

Speech metrics:
- Avg WPM: ${aggMetrics.wpm} (ideal: 120–160)
- Filler rate: ${(aggMetrics.fillerRate * 100).toFixed(1)}% (ideal: <5%)
- Rambling index: ${aggMetrics.ramblingIndex} (ideal: <0.3)
- Communication score (pre-computed): ${commScore}

${perQSummary}${pressureContext}

Full transcript (excerpt):
${transcriptText.slice(0, 3000)}

Generate a comprehensive feedback report as VALID JSON only (no markdown), matching this exact schema:
{
  "overall_score": <integer 0-100>,
  "pass_probability": <"High"|"Medium"|"Low">,
  "confidence_level": <"High"|"Medium"|"Low">,
  "dimensions": {
    "answer_quality": {
      "score": <integer 0-100>,
      "strengths": [<up to 3 specific strength strings>],
      "weaknesses": [<up to 3 specific weakness strings>]
    },
    "communication": {
      "score": ${commScore},
      "wpm": ${aggMetrics.wpm},
      "filler_rate": ${aggMetrics.fillerRate},
      "pause_score": ${aggMetrics.pauseScore},
      "rambling_index": ${aggMetrics.ramblingIndex}
    },
    "engagement_signals": {
      "score": <integer 0-100, overall engagement quality>,
      "engagement_score": <integer 0-100, depth and consistency of answers>,
      "confidence_trend": <"increasing"|"stable"|"declining", based on filler rate and answer length trends>,
      "energy_consistency": <float 0-1, how consistent answer quality and length was across questions>,
      "composure_under_pressure": <integer 0-100, how well the candidate handled the pressure question vs normal questions>
    }
  },
  "red_flags": [<array of red flag strings, may be empty>],
  "top_3_improvements": [<exactly 3 specific, actionable improvement strings>]${jdSchemaBlock}
}

Be honest. If overall performance was weak, reflect that in the score. Use ${commScore} for communication.score exactly as provided.
For engagement_signals, analyze the speech pattern trends provided above:
- engagement_score: Based on answer depth, word count consistency, and whether answers addressed questions fully
- confidence_trend: "increasing" if filler rate decreased over time, "declining" if it increased, "stable" otherwise
- energy_consistency: How consistent were answer lengths and quality scores across questions (1.0 = very consistent)
- composure_under_pressure: Compare pressure question performance to average (100 = handled pressure as well or better than normal questions)`

    try {
      const message = await client.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 1200,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      })

      const raw = message.content[0].type === 'text' ? message.content[0].text.trim() : '{}'
      const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
      const feedback: FeedbackData = JSON.parse(cleaned)

      trackUsage({
        user,
        type: 'api_call_feedback',
        sessionId: body.sessionId,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        modelUsed: 'claude-opus-4-6',
        durationMs: Date.now() - startTime,
        success: true,
      }).catch((err) => aiLogger.warn({ err }, 'Usage tracking failed'))

      return NextResponse.json(feedback)
    } catch (err) {
      aiLogger.error({ err }, 'Claude API error in generate-feedback')

      trackUsage({
        user,
        type: 'api_call_feedback',
        sessionId: body.sessionId,
        inputTokens: 0,
        outputTokens: 0,
        modelUsed: 'claude-opus-4-6',
        durationMs: Date.now() - startTime,
        success: false,
        errorMessage: err instanceof Error ? err.message : 'Unknown error',
      }).catch((err) => aiLogger.warn({ err }, 'Usage tracking failed'))

      // Comprehensive fallback with engagement_signals
      const fallback: FeedbackData = {
        overall_score: 65,
        pass_probability: 'Medium',
        confidence_level: 'Low',
        dimensions: {
          answer_quality: {
            score: 65,
            strengths: ['Attempted to answer all questions'],
            weaknesses: ['Limited specificity', 'STAR structure not consistently used'],
          },
          communication: {
            score: 60,
            wpm: 140,
            filler_rate: 0.08,
            pause_score: 60,
            rambling_index: 0.3,
          },
          engagement_signals: {
            score: 60,
            engagement_score: 60,
            confidence_trend: 'stable',
            energy_consistency: 0.65,
            composure_under_pressure: 55,
          },
        },
        red_flags: [],
        top_3_improvements: [
          'Use the STAR framework explicitly for every behavioral question',
          'Include specific metrics and outcomes to strengthen specificity',
          'Reduce filler words — pause instead of using "um" or "like"',
        ],
      }
      return NextResponse.json(fallback)
    }
  },
})
