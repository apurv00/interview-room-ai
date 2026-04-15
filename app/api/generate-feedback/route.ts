import { NextResponse } from 'next/server'
import { completion } from '@shared/services/modelRouter'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { GenerateFeedbackSchema, FeedbackLlmSchema } from '@interview/validators/interview'
import { trackUsage } from '@shared/services/usageTracking'
import { aiLogger } from '@shared/logger'
import type { FeedbackData, AnswerEvaluation } from '@shared/types'
import { aggregateMetrics, communicationScore } from '@interview/config/speechMetrics'
import { getPressureQuestionIndex, getDomainLabel } from '@interview/config/interviewConfig'
import { getSkillSections } from '@interview/services/core/skillLoader'
import { findCompanyProfile } from '@interview/config/companyProfiles'
import { connectDB } from '@shared/db/connection'
import { User, InterviewSession } from '@shared/db/models'
import { isFeatureEnabled } from '@shared/featureFlags'
import { updateCompetencyState, updateWeaknessClusters } from '@learn/services/competencyService'
import { generateSessionSummary } from '@learn/services/sessionSummaryService'
import { generatePathwayPlan } from '@learn/services/pathwayPlanner'
import { evaluateSession } from '@interview/services/eval/evaluationEngine'
import { getUserCompetencySummary } from '@learn/services/competencyService'
import { buildHistorySummary } from '@learn/services/sessionSummaryService'
import { DATA_BOUNDARY_RULE, JSON_OUTPUT_RULE } from '@shared/services/promptSecurity'
import { recordScoreDelta } from '@shared/services/scoreTelemetry'
import { z } from 'zod'

export const dynamic = 'force-dynamic'
// Feedback generation calls Claude Sonnet with a large prompt (transcript +
// evaluations + profile context) and requests up to 4000 output tokens.
// Without this, Vercel Hobby defaults to ~10s which is too short for Sonnet.
export const maxDuration = 60

type GenerateFeedbackBody = z.infer<typeof GenerateFeedbackSchema>

function computeEngagementContext(
  speechMetrics: Record<string, unknown>[],
  evaluations: Record<string, unknown>[],
  pressureIdx: number
) {
  if (!speechMetrics.length) {
    return { perQSummary: 'No per-question speech metrics available.', pressureContext: '' }
  }

  const perQ = speechMetrics.map((m, i) => {
    const wpm = Number(m.wpm) || 0
    const fillerRate = Number(m.fillerRate) || 0
    const totalWords = Number(m.totalWords) || 0
    const durationMinutes = Number(m.durationMinutes) || 0
    return `  Q${i + 1}: WPM=${wpm}, filler_rate=${(fillerRate * 100).toFixed(1)}%, words=${totalWords}, duration=${durationMinutes.toFixed(1)}min`
  })

  const halfIdx = Math.ceil(speechMetrics.length / 2)
  const firstHalf = speechMetrics.slice(0, halfIdx)
  const secondHalf = speechMetrics.slice(halfIdx)

  const avgFillerFirst = firstHalf.reduce((s, m) => s + (Number(m.fillerRate) || 0), 0) / (firstHalf.length || 1)
  const avgFillerSecond = secondHalf.reduce((s, m) => s + (Number(m.fillerRate) || 0), 0) / (secondHalf.length || 1)
  const avgWordsFirst = firstHalf.reduce((s, m) => s + (Number(m.totalWords) || 0), 0) / (firstHalf.length || 1)
  const avgWordsSecond = secondHalf.reduce((s, m) => s + (Number(m.totalWords) || 0), 0) / (secondHalf.length || 1)

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
    const interviewType = config.interviewType || 'screening'
    const domainLabel = getDomainLabel(config.role)

    // ── Early exit: no evaluations means user ended without answering ──
    if (!evaluations || evaluations.length === 0) {
      const noDataFeedback: FeedbackData = {
        overall_score: 0,
        pass_probability: 'Low',
        confidence_level: 'Low',
        dimensions: {
          answer_quality: { score: 0, strengths: [], weaknesses: ['No answers were provided'] },
          communication: { score: 0, wpm: 0, filler_rate: 0, pause_score: 0, rambling_index: 0 },
          engagement_signals: { score: 0, engagement_score: 0, confidence_trend: 'stable', energy_consistency: 0, composure_under_pressure: 0 },
        },
        red_flags: ['Interview ended without any responses'],
        top_3_improvements: [
          'Complete the interview by answering the questions asked',
          'Practice with shorter 10-minute sessions to build confidence',
          'Use the Coach Mode for guided STAR framework practice',
        ],
      }
      if (body.sessionId) {
        InterviewSession.findByIdAndUpdate(body.sessionId, {
          feedback: noDataFeedback,
          status: 'completed',
          completedAt: new Date(),
        }).catch((err) => aiLogger.warn({ err, sessionId: body.sessionId }, 'Failed to persist no-data feedback'))
      }
      return NextResponse.json(noDataFeedback)
    }

    const aggMetrics = aggregateMetrics(speechMetrics)
    const commScore = communicationScore(aggMetrics)

    const pressureIdx = getPressureQuestionIndex(config.duration)
    const { perQSummary, pressureContext } = computeEngagementContext(speechMetrics, evaluations, pressureIdx)

    // Evaluations as structured data — passed via contextData for TOON encoding
    const evaluationData = evaluations.map(
      (e: Record<string, unknown>, i: number) => ({
        question: i + 1,
        relevance: e.relevance,
        structure: e.structure,
        specificity: e.specificity,
        ownership: e.ownership,
        ...(e.jdAlignment !== undefined && { jdAlignment: e.jdAlignment }),
        flags: Array.isArray(e.flags) ? (e.flags as string[]).join(';') : '',
      })
    )

    // Build transcript text with smart truncation: keep first 2 + last 2 Q&A
    // pairs in full, summarize the middle. The old approach (.slice(0, 4000))
    // blindly cut later questions, leaving Claude with no evidence for them.
    const transcriptLines = transcript.map(
      (e) => `${e.speaker === 'interviewer' ? 'Interviewer' : 'Candidate'}: ${e.text}`
    )
    const fullTranscript = transcriptLines.join('\n')
    let transcriptText: string
    if (fullTranscript.length <= 6000) {
      transcriptText = fullTranscript
    } else {
      // Keep first ~2000 chars (opening questions) and last ~2000 chars (final questions)
      // with a "[...N lines omitted for brevity...]" marker in between
      const head = fullTranscript.slice(0, 2500)
      const tail = fullTranscript.slice(-2500)
      const omittedLines = transcriptLines.length - (head.split('\n').length + tail.split('\n').length)
      transcriptText = `${head}\n\n[...${Math.max(0, omittedLines)} lines omitted for brevity — evaluation scores for all questions are provided in contextData...]\n\n${tail}`
    }

    let jdBlock = ''
    let jdSchemaBlock = ''
    if (config.jobDescription) {
      jdBlock = `\n\n<job_description>\n${config.jobDescription.slice(0, 2000)}\n</job_description>\n\nEvaluate how well the candidate's answers align with the JD requirements.`
      jdSchemaBlock = `,
  "jd_match_score": <integer 0-100, overall alignment with JD requirements>,
  "jd_requirement_breakdown": [
    { "requirement": "<key requirement from JD>", "matched": <true/false>, "evidence": "<brief evidence from candidate's answers or null>" }
  ]`
    }

    // ── Context assembly — all three blocks are independent, run in parallel ──
    // Before this was sequential (competency → profile → skill file), adding
    // 500-1000ms of avoidable latency from DB round-trips.

    const contextPromises = await Promise.allSettled([
      // 1. Competency + history (feature-gated)
      isFeatureEnabled('personalization_engine')
        ? Promise.all([
            getUserCompetencySummary(user.id, config.role),
            buildHistorySummary(user.id, config.role),
          ])
        : Promise.resolve([null, null] as const),

      // 2. User profile
      (async () => {
        await connectDB()
        return User.findById(user.id).select(
          'interviewGoal targetCompanyType weakAreas feedbackPreference ' +
          'targetCompanies topSkills isCareerSwitcher switchingFrom practiceStats'
        ).lean()
      })(),

      // 3. Domain skill file sections
      getSkillSections(config.role, interviewType, ['scoring-emphasis', 'depth-meaning']),
    ])

    // Extract results — failures produce empty strings (same as before)
    let competencyBlock = ''
    let historyBlock = ''
    if (contextPromises[0].status === 'fulfilled') {
      const [compSummary, histSummary] = contextPromises[0].value as [Awaited<ReturnType<typeof getUserCompetencySummary>>, string | null]
      if (compSummary) {
        const weakComps = compSummary.weakAreas.slice(0, 3)
        if (weakComps.length > 0) {
          competencyBlock = `\nCandidate's historically weak competencies: ${weakComps.join(', ')}. Address these specifically in feedback.`
        }
        competencyBlock += `\nOverall readiness score: ${compSummary.overallReadiness}/100.`
      }
      if (histSummary) {
        historyBlock = `\n${histSummary}`
      }
    }

    let profileBlock = ''
    if (contextPromises[1].status === 'fulfilled') {
      const profile = contextPromises[1].value as Record<string, unknown> | null
      if (profile?.interviewGoal) {
        const goalLabels: Record<string, string> = {
          first_interview: 'preparing for their first interview',
          improve_scores: 'improving their interview scores',
          career_switch: 'switching careers',
          promotion: 'preparing for a promotion',
          general_practice: 'general interview practice',
        }
        profileBlock += `\nThe candidate's goal: ${goalLabels[profile.interviewGoal as string] || profile.interviewGoal}. Frame the top_3_improvements in a way that directly serves this goal.`
      }
      if (profile?.targetCompanyType && profile.targetCompanyType !== 'any') {
        profileBlock += `\nThey are targeting ${profile.targetCompanyType} companies. Reference what those companies typically look for in the strengths/weaknesses analysis.`
      }
      if ((profile?.targetCompanies as string[] | undefined)?.length) {
        profileBlock += `\nSpecific target companies: ${(profile!.targetCompanies as string[]).join(', ')}. Reference these companies' known interview standards where relevant.`
      }
      if ((profile?.weakAreas as string[] | undefined)?.length) {
        profileBlock += `\nThe candidate wanted to work on: ${(profile!.weakAreas as string[]).join(', ')}. In top_3_improvements, address at least one of these self-identified weak areas with a specific, actionable tip.`
      }
      if (profile?.feedbackPreference) {
        const prefGuide: Record<string, string> = {
          encouraging: 'Use an encouraging, growth-oriented tone. Lead with positives.',
          balanced: 'Use a balanced tone — equal weight to strengths and improvements.',
          tough_love: 'Be direct, critical, and specific. The candidate wants brutal honesty.',
        }
        profileBlock += `\nFeedback style preference: ${prefGuide[profile.feedbackPreference as string] || 'balanced'}`
      }
      if (profile?.isCareerSwitcher && profile?.switchingFrom) {
        profileBlock += `\nCareer switcher from ${profile.switchingFrom}. Acknowledge transferable skills and suggest how to better bridge the gap.`
      }
      const practiceKey = `${config.role}:${interviewType}`
      const stats = (profile?.practiceStats as Record<string, { totalSessions?: number; avgScore?: number; lastScore?: number }> | undefined)?.[practiceKey]
      if (stats?.totalSessions && stats.totalSessions > 1) {
        profileBlock += `\nThis is session #${stats.totalSessions + 1} for this combination. Previous avg score: ${stats.avgScore}. Compare this session's performance to their historical average and note progress or regression.`
      }
    }

    const interviewTypeContext = interviewType !== 'screening'
      ? `\nThis was a "${interviewType}" interview. Tailor feedback to the interview format — e.g. for technical interviews focus on technical depth, for case studies focus on structured thinking.`
      : ''

    let domainFeedbackContext = ''
    if (contextPromises[2].status === 'fulfilled' && contextPromises[2].value) {
      domainFeedbackContext = `\nFEEDBACK CONTEXT:\n${contextPromises[2].value}`
    }

    // Company/industry context for calibrated feedback
    let companyFeedbackContext = ''
    if (config.targetCompany) {
      const companyProfile = findCompanyProfile(config.targetCompany)
      if (companyProfile) {
        companyFeedbackContext += `\nThe candidate was preparing for ${companyProfile.name} (${companyProfile.difficultyLevel} difficulty).`
        companyFeedbackContext += ` Reference ${companyProfile.name}'s interview standards: ${companyProfile.interviewStyle}`
        companyFeedbackContext += `\nTip to include in improvements: "${companyProfile.tips}"`
        companyFeedbackContext += `\nCalibrate pass_probability to ${companyProfile.difficultyLevel} difficulty. For "Elite" companies (FAANG), a score of 75 should be "Medium" not "High". For "Standard" companies, use normal thresholds.`
      } else {
        companyFeedbackContext += `\nThe candidate was preparing for ${config.targetCompany}. Reference this company's known interview standards and culture in the feedback where relevant.`
      }
    }
    if (config.targetIndustry) {
      companyFeedbackContext += `\nThe role is in the ${config.targetIndustry} industry. Weight industry-relevant strengths and gaps accordingly.`
    }

    // Resume context for feedback specificity
    let resumeBlock = ''
    if (config.resumeText) {
      resumeBlock = `\n\n<candidate_resume>\n${config.resumeText.slice(0, 1500)}\n</candidate_resume>\nReference resume claims when giving feedback. If the candidate's answers contradict or underperform their resume claims, note this specifically.`
    }

    const systemPrompt = `${DATA_BOUNDARY_RULE}

You are an expert interview coach. Generate honest, specific, and actionable feedback for a candidate.

SPECIFICITY RULE: Reference specific questions by number (e.g., "In Q3...") and quote brief phrases from the candidate's actual answers. Never give generic feedback like "improve your structure" — instead say "In Q3, you said 'we did X' without clarifying your personal role — use 'I led/managed/designed' instead."${interviewTypeContext}${domainFeedbackContext}${companyFeedbackContext}${jdBlock}${resumeBlock}${profileBlock}${competencyBlock}${historyBlock}`

    const userPrompt = `Interview summary for ${domainLabel} (${config.experience} yrs), ${config.duration}-min ${interviewType} session.

Speech metrics:
- Avg WPM: ${aggMetrics.wpm} (ideal: 120–160)
- Filler rate: ${(aggMetrics.fillerRate * 100).toFixed(1)}% (ideal: <5%)
- Rambling index: ${aggMetrics.ramblingIndex} (ideal: <0.3)
- Communication score (pre-computed): ${commScore}

${perQSummary}${pressureContext}

<interview_transcript>
${transcriptText}
</interview_transcript>

${JSON_OUTPUT_RULE}
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
      "confidence_trend": <"increasing"|"stable"|"declining">,
      "energy_consistency": <float 0-1>,
      "composure_under_pressure": <integer 0-100>
    }
  },
  "red_flags": [<array of red flag strings, may be empty>],
  "top_3_improvements": [<exactly 3 specific, actionable improvement strings>],
  "ideal_answers": [
    {
      "questionIndex": <0-based question index>,
      "strongAnswer": "<2-3 sentence outline of what a strong answer would include — not a full script, but the key points and structure>",
      "keyElements": ["<element 1 they should have included>", "<element 2>", "<element 3>"]
    }
  ],
  "drill_recommendations": [
    {
      "skillArea": "<e.g. STAR Structure, Metrics Thinking, Leadership Impact, Technical Depth>",
      "description": "<one sentence on why this drill matters based on THIS session's gaps>",
      "practiceQuestions": ["<specific practice question 1>", "<specific practice question 2>"]
    }
  ]${jdSchemaBlock}
}

For ideal_answers: Generate for the 2-3 WEAKEST-scoring questions only (not all questions). Show what good looks like without fabricating the candidate's experience — use generic strong-answer patterns.
For drill_recommendations: Generate 2-3 drills targeting the candidate's weakest dimensions. Each drill should have 2 specific practice questions they can try in their next session.

Be honest. Use ${commScore} for communication.score exactly as provided.`

    try {
      let result = await completion({
        taskSlot: 'interview.generate-feedback',
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        contextData: { evaluationScores: evaluationData },
      })

      // G.3: truncation detection + single retry with expanded budget.
      // Feedback generation uses maxTokens=6000 by default (see
      // shared/services/taskSlots.ts) — the largest ceiling in the app
      // — but long interviews with JD + resume + per-question ideals +
      // drill recs can still hit it. Truncated output parses as
      // partial JSON and the downstream `|| 0` silent defaults then
      // collapse overall_score. Retry once to 8000 tokens before
      // surfacing the partial-scoring fact to the user via confidence.
      let truncationRetried = false
      if (result.truncated) {
        truncationRetried = true
        aiLogger.warn(
          {
            taskSlot: 'interview.generate-feedback',
            model: result.model,
            outputTokens: result.outputTokens,
            evaluationCount: evaluations.length,
          },
          'generate-feedback truncated; retrying with expanded maxTokens',
        )
        result = await completion({
          taskSlot: 'interview.generate-feedback',
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
          contextData: { evaluationScores: evaluationData },
          maxTokens: 8000,
        })
      }
      const feedbackTruncated = result.truncated === true

      const raw = result.text || '{}'
      const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
      let feedback: FeedbackData
      try {
        const parsedRaw = JSON.parse(cleaned) as Record<string, unknown>
        // G.2: Zod-validate the LLM payload. Failure is non-fatal — we
        // log the drift and continue with the raw parsed object. Downstream
        // null-checks + deterministic overrides handle missing/variant
        // fields. This schema is `.passthrough()` so benign field additions
        // don't reject the whole payload.
        const parsedLlm = FeedbackLlmSchema.safeParse(parsedRaw)
        if (!parsedLlm.success) {
          aiLogger.warn(
            {
              issues: parsedLlm.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
              raw: raw.slice(0, 500),
            },
            'generate-feedback: LLM response failed Zod validation — continuing with raw object',
          )
        }
        feedback = parsedRaw as unknown as FeedbackData
      } catch {
        aiLogger.error({ raw: raw.slice(0, 500) }, 'Feedback JSON parse failed')
        // G.1 telemetry — parse failure path. Capture whatever we know so we
        // can correlate parse failures with model/prompt size.
        if (body.sessionId) {
          recordScoreDelta({
            sessionId: body.sessionId,
            userId: user.id,
            source: 'generate-feedback',
            taskSlot: 'interview.generate-feedback',
            modelUsed: result.model ?? 'unknown',
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            truncated: result.truncated,
            evaluationCount: evaluations.length,
            recordReason: 'parse-failed',
          }).catch(() => {})
        }
        throw new Error('Feedback JSON parse failed')
      }

      // G.1 telemetry — snapshot Claude's raw values BEFORE any of the
      // server-side deterministic overrides below. This is the only place
      // we can still see what the LLM actually chose; the rest of the
      // handler replaces these fields. Numbers are coerced safely — if
      // Claude returned a string or null, `claudeRawOverall` becomes
      // undefined and the delta calc skips.
      const claudeRawOverall = typeof feedback.overall_score === 'number'
        ? feedback.overall_score
        : undefined
      const claudeRawDimensions: Record<string, number> = {}
      if (typeof feedback.dimensions?.answer_quality?.score === 'number') {
        claudeRawDimensions.answer_quality = feedback.dimensions.answer_quality.score
      }
      if (typeof feedback.dimensions?.communication?.score === 'number') {
        claudeRawDimensions.communication = feedback.dimensions.communication.score
      }
      if (typeof feedback.dimensions?.engagement_signals?.score === 'number') {
        claudeRawDimensions.engagement_signals = feedback.dimensions.engagement_signals.score
      }

      // Validate required fields exist (Claude may truncate if hitting max_tokens)
      if (feedback.overall_score == null || !feedback.dimensions) {
        aiLogger.warn({ raw: raw.slice(0, 500) }, 'Incomplete feedback from Claude — applying defaults')
        feedback.overall_score = feedback.overall_score || Math.round(
          evaluations.reduce((sum: number, e: Record<string, unknown>) =>
            sum + (((e.relevance as number) || 0) + ((e.structure as number) || 0) +
                   ((e.specificity as number) || 0) + ((e.ownership as number) || 0)) / 4, 0
          ) / Math.max(evaluations.length, 1)
        )
        feedback.dimensions = feedback.dimensions || {
          answer_quality: { score: feedback.overall_score, strengths: [], weaknesses: [] },
          communication: { score: commScore, wpm: aggMetrics.wpm, filler_rate: aggMetrics.fillerRate, pause_score: aggMetrics.pauseScore, rambling_index: aggMetrics.ramblingIndex },
          engagement_signals: { score: Math.round(feedback.overall_score * 0.9), engagement_score: Math.round(feedback.overall_score * 0.85), confidence_trend: 'stable' as const, energy_consistency: 0.7, composure_under_pressure: 65 },
        }
        feedback.pass_probability = feedback.pass_probability || (feedback.overall_score >= 70 ? 'High' : feedback.overall_score >= 50 ? 'Medium' : 'Low')
        feedback.confidence_level = feedback.confidence_level || 'Medium'
        feedback.red_flags = feedback.red_flags || []
        feedback.top_3_improvements = feedback.top_3_improvements || ['Practice more structured answers']
      }

      // Enforce pre-computed communication score (Claude may deviate from the provided value)
      if (feedback.dimensions?.communication) {
        feedback.dimensions.communication.score = commScore
      }

      // BUG 2 fix: derive answer_quality from the actual per-question evaluation
      // scores instead of trusting Claude's free-form summary value, which had
      // no rubric anchors and tended to inflate to 60-75.
      // True per-question average across (relevance + structure + specificity + ownership):
      const perQAvg = evaluations.length > 0
        ? Math.round(
            evaluations.reduce((sum, e) => {
              const ev = e as unknown as Record<string, number>
              const r = Number(ev.relevance) || 0
              const s = Number(ev.structure) || 0
              const sp = Number(ev.specificity) || 0
              const o = Number(ev.ownership) || 0
              return sum + (r + s + sp + o) / 4
            }, 0) / evaluations.length
          )
        : 0

      // Override Claude's answer_quality score with the deterministic average
      if (feedback.dimensions?.answer_quality) {
        feedback.dimensions.answer_quality.score = perQAvg
      }

      // Deterministic overall score: weighted average of dimensions (40% AQ, 30% Comm, 30% Engagement)
      const aqScore = perQAvg
      const engScore = feedback.dimensions?.engagement_signals?.score ?? 0
      feedback.overall_score = Math.round(aqScore * 0.4 + commScore * 0.3 + engScore * 0.3)
      feedback.pass_probability = feedback.overall_score >= 75 ? 'High' : feedback.overall_score >= 50 ? 'Medium' : 'Low'

      // G.3: surface integrity problems to the user.
      //   - Feedback-level truncation (even after the retry in L366): mark
      //     confidence_level=Low and push a red_flag so the user understands
      //     the report is built on partial data.
      //   - Upstream eval integrity: count rows where evaluate-answer marked
      //     status=truncated/failed (set in app/api/evaluate-answer/route.ts
      //     by G.3). These came in via the request body and are visible on
      //     each evaluation object. Surface as red_flags only — the
      //     aggregation helpers in G.5 will later filter these out of
      //     perQAvg; for now we keep the existing math but make the
      //     integrity issue visible.
      const truncatedEvalCount = evaluations.filter(
        (e) => (e as { status?: string }).status === 'truncated',
      ).length
      const failedEvalCount = evaluations.filter(
        (e) => (e as { status?: string }).status === 'failed',
      ).length
      if (feedbackTruncated) {
        feedback.confidence_level = 'Low'
        feedback.red_flags = Array.isArray(feedback.red_flags) ? feedback.red_flags : []
        feedback.red_flags.push(
          'AI feedback response was truncated — the report may be incomplete; scores are approximate.',
        )
      }
      if (truncatedEvalCount > 0 || failedEvalCount > 0) {
        feedback.red_flags = Array.isArray(feedback.red_flags) ? feedback.red_flags : []
        if (truncatedEvalCount > 0) {
          feedback.red_flags.push(
            `${truncatedEvalCount} answer${truncatedEvalCount === 1 ? '' : 's'} could not be fully scored — AI evaluation was truncated.`,
          )
        }
        if (failedEvalCount > 0) {
          feedback.red_flags.push(
            `${failedEvalCount} answer${failedEvalCount === 1 ? '' : 's'} could not be scored — AI evaluation failed. Scores are approximate.`,
          )
        }
        // Down-rate confidence when ≥20% of evaluations had integrity
        // issues. Preserves Claude's 'High' when the sample is mostly
        // clean.
        const problemRatio = (truncatedEvalCount + failedEvalCount) / Math.max(evaluations.length, 1)
        if (problemRatio >= 0.2 && feedback.confidence_level !== 'Low') {
          feedback.confidence_level = 'Low'
        } else if (problemRatio > 0 && feedback.confidence_level === 'High') {
          feedback.confidence_level = 'Medium'
        }
      }

      // G.1 telemetry — record the delta between Claude's raw overall_score
      // (captured before the overrides above) and the deterministic value
      // we are about to return. Fire-and-forget; never blocks the response.
      if (body.sessionId) {
        recordScoreDelta({
          sessionId: body.sessionId,
          userId: user.id,
          source: 'generate-feedback',
          taskSlot: 'interview.generate-feedback',
          modelUsed: result.model ?? 'unknown',
          claudeOverallScore: claudeRawOverall,
          deterministicOverallScore: feedback.overall_score,
          claudeDimensions: claudeRawDimensions,
          deterministicDimensions: {
            answer_quality: aqScore,
            communication: commScore,
            engagement_signals: engScore,
          },
          evaluationCount: evaluations.length,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          truncated: result.truncated,
          recordReason: claudeRawOverall === undefined ? 'claude-missing-overall' : 'ok',
        }).catch(() => {})
      }

      // Persist feedback to session document server-side so it survives page
      // reloads without relying on the client PATCH call (which can fail due
      // to Zod validation mismatches or network issues).
      if (body.sessionId) {
        try {
          await InterviewSession.findByIdAndUpdate(body.sessionId, {
            feedback,
            status: 'completed',
            completedAt: new Date(),
          })
        } catch (err) {
          aiLogger.warn({ err, sessionId: body.sessionId }, 'Failed to persist feedback to session')
        }
      }

      trackUsage({
        user,
        type: 'api_call_feedback',
        sessionId: body.sessionId,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        modelUsed: result.model,
        durationMs: Date.now() - startTime,
        success: true,
      }).catch((err) => aiLogger.warn({ err }, 'Usage tracking failed'))

      // Post-feedback processing: update competency state, session summary, weakness clusters, and pathway plan
      // All fire-and-forget to not block the response
      if (body.sessionId) {
        const sessionId = body.sessionId
        const typedEvaluations = evaluations as unknown as AnswerEvaluation[]

        // Update competency state
        updateCompetencyState({
          userId: user.id,
          sessionId,
          domain: config.role,
          evaluations: typedEvaluations,
        }).catch((err) => aiLogger.warn({ err }, 'Competency state update failed'))

        // Generate session summary
        generateSessionSummary({
          userId: user.id,
          sessionId,
          domain: config.role,
          interviewType,
          experience: config.experience,
          evaluations: typedEvaluations,
          speechMetrics,
          feedback,
          transcript,
          durationMinutes: config.duration,
        }).catch((err) => aiLogger.warn({ err }, 'Session summary generation failed'))

        // Update weakness clusters from flags
        const weaknessInputs = typedEvaluations
          .filter(e => (e.flags?.length ?? 0) > 0)
          .flatMap(e => (e.flags ?? []).map(flag => ({
            name: flag.toLowerCase().replace(/\s+/g, '_'),
            description: flag,
            linkedCompetencies: inferLinkedCompetencies(flag),
            questionIndex: e.questionIndex,
            observation: `Q${e.questionIndex + 1}: ${flag}`,
          })))
        if (weaknessInputs.length > 0) {
          updateWeaknessClusters({
            userId: user.id,
            sessionId,
            weaknesses: weaknessInputs,
          }).catch((err) => aiLogger.warn({ err }, 'Weakness cluster update failed'))
        }

        // Generate session-level evaluation and pathway plan
        evaluateSession({
          domain: config.role,
          interviewType,
          seniorityBand: config.experience,
          evaluations: typedEvaluations,
        }).then(sessionEval => {
          generatePathwayPlan({
            userId: user.id,
            sessionId,
            domain: config.role,
            interviewType,
            experience: config.experience,
            feedback,
            sessionEvaluation: sessionEval,
          }).catch((err) => aiLogger.warn({ err }, 'Pathway plan generation failed'))
        }).catch((err) => aiLogger.warn({ err }, 'Session evaluation failed'))
      }

      return NextResponse.json(feedback)
    } catch (err) {
      aiLogger.error({ err }, 'Claude API error in generate-feedback')

      trackUsage({
        user,
        type: 'api_call_feedback',
        sessionId: body.sessionId,
        inputTokens: 0,
        outputTokens: 0,
        modelUsed: 'interview.generate-feedback',
        durationMs: Date.now() - startTime,
        success: false,
        errorMessage: err instanceof Error ? err.message : 'Unknown error',
      }).catch((err) => aiLogger.warn({ err }, 'Usage tracking failed'))

      // Compute a rough score from evaluations if available, otherwise use minimal defaults
      const hasEvals = evaluations && evaluations.length > 0
      const roughScore = hasEvals
        ? Math.round((evaluations as any[]).reduce((sum: number, e: any) =>
            sum + ((Number(e.relevance) || 0) + (Number(e.structure) || 0) + (Number(e.specificity) || 0) + (Number(e.ownership) || 0)) / 4, 0) / evaluations.length)
        : 0

      const fallbackCommScore = commScore || 0
      const fallbackEngScore = Math.round(roughScore * 0.9)
      const fallbackOverall = Math.round(roughScore * 0.4 + fallbackCommScore * 0.3 + fallbackEngScore * 0.3)

      const fallback: FeedbackData = {
        overall_score: fallbackOverall,
        pass_probability: fallbackOverall >= 75 ? 'High' : fallbackOverall >= 50 ? 'Medium' : 'Low',
        confidence_level: 'Low',
        dimensions: {
          answer_quality: { score: roughScore, strengths: [], weaknesses: ['Feedback generation encountered an error — scores are approximate'] },
          communication: { score: fallbackCommScore, wpm: aggMetrics.wpm, filler_rate: aggMetrics.fillerRate, pause_score: aggMetrics.pauseScore, rambling_index: aggMetrics.ramblingIndex },
          engagement_signals: { score: fallbackEngScore, engagement_score: fallbackEngScore, confidence_trend: 'stable', energy_consistency: 0.5, composure_under_pressure: Math.round(roughScore * 0.85) },
        },
        red_flags: hasEvals ? [] : ['No responses recorded'],
        top_3_improvements: [
          'Use the STAR framework explicitly for every behavioral question',
          'Include specific metrics and outcomes to strengthen specificity',
          'Reduce filler words — pause instead of using "um" or "like"',
        ],
      }
      if (body.sessionId) {
        InterviewSession.findByIdAndUpdate(body.sessionId, {
          feedback: fallback,
          status: 'completed',
          completedAt: new Date(),
        }).catch((err) => aiLogger.warn({ err, sessionId: body.sessionId }, 'Failed to persist fallback feedback'))

        // G.1 telemetry — the outer-catch path has no Claude value, but
        // capturing the deterministic fallback still gives us visibility
        // into how often this path is hit in production.
        recordScoreDelta({
          sessionId: body.sessionId,
          userId: user.id,
          source: 'generate-feedback',
          taskSlot: 'interview.generate-feedback',
          modelUsed: 'interview.generate-feedback',
          deterministicOverallScore: fallback.overall_score,
          deterministicDimensions: {
            answer_quality: roughScore,
            communication: fallbackCommScore,
            engagement_signals: fallbackEngScore,
          },
          evaluationCount: evaluations?.length ?? 0,
          recordReason: 'outer-catch',
        }).catch(() => {})
      }
      return NextResponse.json(fallback)
    }
  },
})

function inferLinkedCompetencies(flag: string): string[] {
  const flagLower = flag.toLowerCase()
  const links: string[] = []

  if (flagLower.includes('metric') || flagLower.includes('number') || flagLower.includes('measur')) {
    links.push('specificity', 'metrics_thinking')
  }
  if (flagLower.includes('vague') || flagLower.includes('generic') || flagLower.includes('unspecific')) {
    links.push('specificity')
  }
  if (flagLower.includes('blame') || flagLower.includes('responsibility') || flagLower.includes('credit')) {
    links.push('ownership')
  }
  if (flagLower.includes('structure') || flagLower.includes('star') || flagLower.includes('rambling')) {
    links.push('structure')
  }
  if (flagLower.includes('irrelevant') || flagLower.includes('off-topic') || flagLower.includes('tangent')) {
    links.push('relevance')
  }
  if (flagLower.includes('inconsisten') || flagLower.includes('contradict')) {
    links.push('self_awareness', 'structure')
  }

  return links.length > 0 ? links : ['general']
}
