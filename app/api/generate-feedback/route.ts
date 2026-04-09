import { NextResponse } from 'next/server'
import { completion } from '@shared/services/modelRouter'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { GenerateFeedbackSchema } from '@interview/validators/interview'
import { trackUsage } from '@shared/services/usageTracking'
import { aiLogger } from '@shared/logger'
import type { FeedbackData, AnswerEvaluation } from '@shared/types'
import { aggregateMetrics, communicationScore } from '@interview/config/speechMetrics'
import { getPressureQuestionIndex, getDomainLabel } from '@interview/config/interviewConfig'
import { getSkillSections } from '@interview/services/core/skillLoader'
import { findCompanyProfile } from '@interview/config/companyProfiles'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models'
import { isFeatureEnabled } from '@shared/featureFlags'
import { updateCompetencyState, updateWeaknessClusters } from '@learn/services/competencyService'
import { generateSessionSummary } from '@learn/services/sessionSummaryService'
import { generatePathwayPlan } from '@learn/services/pathwayPlanner'
import { evaluateSession } from '@interview/services/eval/evaluationEngine'
import { getUserCompetencySummary } from '@learn/services/competencyService'
import { buildHistorySummary } from '@learn/services/sessionSummaryService'
import { DATA_BOUNDARY_RULE } from '@shared/services/promptSecurity'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

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

    const transcriptText = transcript
      .map((e) => `${e.speaker === 'interviewer' ? 'Interviewer' : 'Candidate'}: ${e.text}`)
      .join('\n')

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

    // Inject competency and history context for enhanced feedback
    let competencyBlock = ''
    let historyBlock = ''
    if (isFeatureEnabled('personalization_engine')) {
      try {
        const [compSummary, histSummary] = await Promise.all([
          getUserCompetencySummary(user.id, config.role),
          buildHistorySummary(user.id, config.role),
        ])
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
      } catch { /* continue without enhanced context */ }
    }

    let profileBlock = ''
    try {
      await connectDB()
      const profile = await User.findById(user.id).select(
        'interviewGoal targetCompanyType weakAreas feedbackPreference ' +
        'targetCompanies topSkills isCareerSwitcher switchingFrom practiceStats'
      ).lean()
      if (profile?.interviewGoal) {
        const goalLabels: Record<string, string> = {
          first_interview: 'preparing for their first interview',
          improve_scores: 'improving their interview scores',
          career_switch: 'switching careers',
          promotion: 'preparing for a promotion',
          general_practice: 'general interview practice',
        }
        profileBlock += `\nThe candidate's goal: ${goalLabels[profile.interviewGoal] || profile.interviewGoal}. Frame the top_3_improvements in a way that directly serves this goal.`
      }
      if (profile?.targetCompanyType && profile.targetCompanyType !== 'any') {
        profileBlock += `\nThey are targeting ${profile.targetCompanyType} companies. Reference what those companies typically look for in the strengths/weaknesses analysis.`
      }
      if (profile?.targetCompanies?.length) {
        profileBlock += `\nSpecific target companies: ${profile.targetCompanies.join(', ')}. Reference these companies' known interview standards where relevant.`
      }
      if (profile?.weakAreas?.length) {
        profileBlock += `\nThe candidate wanted to work on: ${profile.weakAreas.join(', ')}. In top_3_improvements, address at least one of these self-identified weak areas with a specific, actionable tip.`
      }
      if (profile?.feedbackPreference) {
        const prefGuide: Record<string, string> = {
          encouraging: 'Use an encouraging, growth-oriented tone. Lead with positives.',
          balanced: 'Use a balanced tone — equal weight to strengths and improvements.',
          tough_love: 'Be direct, critical, and specific. The candidate wants brutal honesty.',
        }
        profileBlock += `\nFeedback style preference: ${prefGuide[profile.feedbackPreference] || 'balanced'}`
      }
      if (profile?.isCareerSwitcher && profile?.switchingFrom) {
        profileBlock += `\nCareer switcher from ${profile.switchingFrom}. Acknowledge transferable skills and suggest how to better bridge the gap.`
      }
      // Practice history context
      const practiceKey = `${config.role}:${interviewType}`
      const stats = (profile?.practiceStats as Record<string, { totalSessions?: number; avgScore?: number; lastScore?: number }> | undefined)?.[practiceKey]
      if (stats?.totalSessions && stats.totalSessions > 1) {
        profileBlock += `\nThis is session #${stats.totalSessions + 1} for this combination. Previous avg score: ${stats.avgScore}. Compare this session's performance to their historical average and note progress or regression.`
      }
    } catch { /* continue without profile */ }

    const interviewTypeContext = interviewType !== 'screening'
      ? `\nThis was a "${interviewType}" interview. Tailor feedback to the interview format — e.g. for technical interviews focus on technical depth, for case studies focus on structured thinking.`
      : ''

    // Domain x depth specialization for feedback from skill file
    let domainFeedbackContext = ''
    try {
      const feedbackSkillContent = await getSkillSections(config.role, interviewType, [
        'scoring-emphasis', 'depth-meaning',
      ])
      if (feedbackSkillContent) {
        domainFeedbackContext = `\nFEEDBACK CONTEXT:\n${feedbackSkillContent}`
      }
    } catch { /* skill file unavailable — continue without it */ }

    // Company/industry context for calibrated feedback
    let companyFeedbackContext = ''
    if (config.targetCompany) {
      const companyProfile = findCompanyProfile(config.targetCompany)
      if (companyProfile) {
        companyFeedbackContext += `\nThe candidate was preparing for ${companyProfile.name} (${companyProfile.difficultyLevel} difficulty).`
        companyFeedbackContext += ` Reference ${companyProfile.name}'s interview standards: ${companyProfile.interviewStyle}`
        companyFeedbackContext += `\nTip to include in improvements: "${companyProfile.tips}"`
      } else {
        companyFeedbackContext += `\nThe candidate was preparing for ${config.targetCompany}. Reference this company's known interview standards and culture in the feedback where relevant.`
      }
    }
    if (config.targetIndustry) {
      companyFeedbackContext += `\nThe role is in the ${config.targetIndustry} industry. Weight industry-relevant strengths and gaps accordingly.`
    }

    const systemPrompt = `${DATA_BOUNDARY_RULE}

You are an expert interview coach. Generate honest, specific, and actionable feedback for a candidate.${interviewTypeContext}${domainFeedbackContext}${companyFeedbackContext}${jdBlock}${profileBlock}${competencyBlock}${historyBlock}`

    const userPrompt = `Interview summary for ${domainLabel} (${config.experience} yrs), ${config.duration}-min ${interviewType} session.

Speech metrics:
- Avg WPM: ${aggMetrics.wpm} (ideal: 120–160)
- Filler rate: ${(aggMetrics.fillerRate * 100).toFixed(1)}% (ideal: <5%)
- Rambling index: ${aggMetrics.ramblingIndex} (ideal: <0.3)
- Communication score (pre-computed): ${commScore}

${perQSummary}${pressureContext}

<interview_transcript>
${transcriptText.slice(0, 2000)}
</interview_transcript>

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
      "confidence_trend": <"increasing"|"stable"|"declining">,
      "energy_consistency": <float 0-1>,
      "composure_under_pressure": <integer 0-100>
    }
  },
  "red_flags": [<array of red flag strings, may be empty>],
  "top_3_improvements": [<exactly 3 specific, actionable improvement strings>]${jdSchemaBlock}
}

Be honest. Use ${commScore} for communication.score exactly as provided.`

    try {
      const result = await completion({
        taskSlot: 'interview.generate-feedback',
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        contextData: { evaluationScores: evaluationData },
      })

      const raw = result.text || '{}'
      const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
      let feedback: FeedbackData
      try {
        feedback = JSON.parse(cleaned)
      } catch {
        aiLogger.error({ raw: raw.slice(0, 500) }, 'Feedback JSON parse failed')
        throw new Error('Feedback JSON parse failed')
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

      // Deterministic overall score: weighted average of dimensions (40% AQ, 30% Comm, 30% Engagement)
      const aqScore = feedback.dimensions?.answer_quality?.score ?? 0
      const engScore = feedback.dimensions?.engagement_signals?.score ?? 0
      feedback.overall_score = Math.round(aqScore * 0.4 + commScore * 0.3 + engScore * 0.3)
      feedback.pass_probability = feedback.overall_score >= 75 ? 'High' : feedback.overall_score >= 50 ? 'Medium' : 'Low'

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
          .filter(e => e.flags?.length > 0)
          .flatMap(e => e.flags.map(flag => ({
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
