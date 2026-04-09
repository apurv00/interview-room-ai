import { NextResponse } from 'next/server'
import { completionStream } from '@shared/services/modelRouter'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { EvaluateAnswerSchema } from '@interview/validators/interview'
import { trackUsage } from '@shared/services/usageTracking'
import { aiLogger } from '@shared/logger'
import { DATA_BOUNDARY_RULE } from '@shared/services/promptSecurity'
import { getDomainLabel } from '@interview/config/interviewConfig'
import { getSkillSections } from '@interview/services/core/skillLoader'
import { findCompanyProfile } from '@interview/config/companyProfiles'
import { connectDB } from '@shared/db/connection'
import { User, InterviewDepth } from '@shared/db/models'
import { FALLBACK_DEPTHS } from '@shared/db/seed'
import { isFeatureEnabled } from '@shared/featureFlags'
import { getScoringDimensions, buildRubricPromptSection } from '@interview/services/eval/evaluationEngine'
import type { AnswerEvaluation } from '@shared/types'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

type EvaluateAnswerBody = z.infer<typeof EvaluateAnswerSchema>

export const POST = composeApiRoute<EvaluateAnswerBody>({
  schema: EvaluateAnswerSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 15, keyPrefix: 'rl:eval' },

  async handler(req, { user, body }) {
    const { config, question, answer, questionIndex, probeDepth } = body
    const startTime = Date.now()
    const interviewType = config.interviewType || 'behavioral'
    const domainLabel = getDomainLabel(config.role)

    // ── Early exit: empty or near-empty answer → score 0 ──
    const trimmedAnswer = (answer || '').trim()
    if (trimmedAnswer.length < 5) {
      return NextResponse.json({
        questionIndex,
        question,
        answer: trimmedAnswer,
        relevance: 0,
        structure: 0,
        specificity: 0,
        ownership: 0,
        needsFollowUp: false,
        flags: ['No substantive answer provided'],
        probeDecision: { shouldProbe: false },
        pushback: null,
      })
    }

    // Fetch depth-specific evaluation criteria
    let evalCriteria = ''
    let scoringDims: { name: string; label: string; weight: number }[] = []

    try {
      await connectDB()
      const depthDoc = await InterviewDepth.findOne({ slug: interviewType, isActive: true }).lean()
      if (depthDoc) {
        evalCriteria = depthDoc.evaluationCriteria || ''
        scoringDims = depthDoc.scoringDimensions || []
      }
    } catch { /* continue with defaults */ }

    if (!scoringDims.length) {
      const fallback = FALLBACK_DEPTHS.find(d => d.slug === interviewType)
      if (fallback) {
        evalCriteria = fallback.evaluationCriteria || ''
        scoringDims = fallback.scoringDimensions || []
      }
    }

    // Default to standard HR screening dimensions
    if (!scoringDims.length) {
      scoringDims = [
        { name: 'relevance', label: 'Relevance', weight: 0.25 },
        { name: 'structure', label: 'STAR Structure', weight: 0.25 },
        { name: 'specificity', label: 'Specificity', weight: 0.25 },
        { name: 'ownership', label: 'Ownership', weight: 0.25 },
      ]
    }

    // Try rubric-enhanced dimensions from evaluation engine
    if (isFeatureEnabled('rubric_registry')) {
      try {
        const rubricDims = await getScoringDimensions(config.role, interviewType, config.experience)
        if (rubricDims.length > 0) {
          scoringDims = rubricDims.map(d => ({ name: d.name, label: d.label, weight: d.weight }))
        }
      } catch { /* continue with existing dims */ }
    }

    // Build JD context if available — wrapped in XML tags to prevent prompt injection
    let jdContext = ''
    if (config.jobDescription) {
      jdContext = `\n\n<job_description>\n${config.jobDescription.slice(0, 2000)}\n</job_description>\n\nUse the job description above to evaluate how well the answer aligns with the role's requirements.`
    }

    // Build profile context
    let profileContext = ''
    try {
      await connectDB()
      const profile = await User.findById(user.id).select(
        'isCareerSwitcher switchingFrom interviewGoal weakAreas feedbackPreference ' +
        'targetCompanyType topSkills communicationStyle practiceStats'
      ).lean()
      if (profile?.isCareerSwitcher && profile?.switchingFrom) {
        profileContext += `\nThis candidate is transitioning from ${profile.switchingFrom} — weight transferable skills and learning agility more heavily when scoring.`
      }
      if (profile?.interviewGoal === 'first_interview') {
        profileContext += `\nThis is the candidate's first interview preparation — be encouraging in follow-up framing while still being honest about scores.`
      }
      if (profile?.weakAreas?.length) {
        profileContext += `\nThe candidate wants to improve: ${profile.weakAreas.join(', ')}. Flag related issues more explicitly in the flags array.`
      }
      if (profile?.feedbackPreference) {
        const prefGuide: Record<string, string> = {
          encouraging: 'Frame follow-ups encouragingly. Acknowledge strengths before noting gaps.',
          balanced: 'Provide balanced feedback — acknowledge both strengths and areas for improvement.',
          tough_love: 'Be direct and critical. The candidate wants honest, unfiltered feedback.',
        }
        profileContext += `\n${prefGuide[profile.feedbackPreference] || ''}`
      }
      if (profile?.targetCompanyType && profile.targetCompanyType !== 'any') {
        profileContext += `\nCalibrate scoring to ${profile.targetCompanyType} company standards.`
      }
      // Check practice history for adaptive scoring
      const practiceKey = `${config.role}:${interviewType}`
      const stats = (profile?.practiceStats as Record<string, { totalSessions?: number; avgScore?: number }> | undefined)?.[practiceKey]
      if (stats?.totalSessions && stats.totalSessions >= 3) {
        profileContext += `\nExperienced practitioner (${stats.totalSessions} sessions, avg ${stats.avgScore}). Raise the bar — score more critically.`
      }
    } catch { /* continue without profile */ }

    // Inject evaluation-relevant sections from skill file
    try {
      const evalSkillContent = await getSkillSections(config.role, interviewType, [
        'scoring-emphasis', 'red-flags', 'experience-calibration',
      ])
      if (evalSkillContent) {
        evalCriteria = evalSkillContent + (evalCriteria ? `\n${evalCriteria}` : '')
      }
    } catch { /* skill file unavailable — continue with DB eval criteria */ }

    // Build company/industry context for evaluation calibration
    let companyContext = ''
    if (config.targetCompany) {
      const companyProfile = findCompanyProfile(config.targetCompany)
      if (companyProfile) {
        companyContext += `\nThe candidate is preparing for ${companyProfile.name} (${companyProfile.difficultyLevel} difficulty). Calibrate scoring to ${companyProfile.name}'s interview standards. Key values: ${companyProfile.culturalValues.slice(0, 3).join(', ')}.`
      } else {
        companyContext += `\nThe candidate is preparing for ${config.targetCompany}. Calibrate scoring expectations to this company's known standards.`
      }
    }
    if (config.targetIndustry) {
      companyContext += `\nThe role is in the ${config.targetIndustry} industry. Weight industry-relevant knowledge and terminology appropriately.`
    }

    const evalCriteriaBlock = evalCriteria ? `\n\nEVALUATION FOCUS: ${evalCriteria}` : ''

    const systemPrompt = `${DATA_BOUNDARY_RULE}

You are an expert interview coach evaluating candidates for ${domainLabel} roles at the ${config.experience} experience level. Interview type: ${interviewType}. You score objectively and fairly.${evalCriteriaBlock}${companyContext}${jdContext}${profileContext}`

    // Build dynamic scoring dimensions
    const dimensionPrompt = scoringDims.map(d =>
      `- ${d.name}: ${d.label} (integer 0-100)`
    ).join('\n')

    const dimensionSchema = scoringDims.map(d =>
      `  "${d.name}": number`
    ).join(',\n')

    const jdAlignmentDimension = config.jobDescription
      ? `\n- jdAlignment: How well does this answer demonstrate skills/experience relevant to the job description requirements? (integer 0-100)`
      : ''

    const jdAlignmentSchema = config.jobDescription
      ? `,\n  "jdAlignment": number`
      : ''

    const probeDepthContext = probeDepth != null && probeDepth > 0
      ? `\nThis is probe depth ${probeDepth} on the same topic. Only recommend further probing if genuinely new information can be uncovered. After 2+ probes on the same topic, strongly prefer to move on.`
      : ''

    const userPrompt = `Evaluate this interview answer:

Question: "${question}"

<candidate_answer>
${answer}
</candidate_answer>

Score on these dimensions (integer 0–100):
${dimensionPrompt}${jdAlignmentDimension}

Also determine:
- flags: array of red-flag strings (e.g. "Blame-shifting", "No measurable impact", "Inconsistency detected"). Empty array if none.

Determine probing decision:
- probeDecision.shouldProbe: true if the answer would benefit from probing — answer is vague, too short (<30 words), surface-level, evasive, missing key info, or exceptionally interesting and worth exploring deeper
- probeDecision.probeType: one of "clarify" (ambiguous terms or unclear details), "challenge" (logical gaps or untested assumptions), "expand" (promising answer worth exploring deeper), or "quantify" (lacks measurable impact or metrics)
- probeDecision.probeQuestion: a natural, conversational follow-up probe (one sentence). Frame as curious exploration, not interrogation.
- probeDecision.probingRationale: brief reason for the probing decision (for coaching context)${probeDepthContext}

Determine pushback:
- If ANY scoring dimension is below 50, generate a pushback response. Pick the lowest-scoring dimension.
- pushback.line: A professional, in-character challenge from the interviewer (1-2 sentences max). Examples:
  * Low specificity: "That's helpful context — could you walk me through a specific instance with concrete numbers?"
  * Low ownership: "I'd love to understand your personal contribution — what was your specific role?"
  * Low structure: "There's a lot there — could you walk me through the situation, what you did, and what happened?"
  * Low relevance: "Interesting — how does that connect to what I was asking about?"
- pushback.targetDimension: The dimension name that triggered the pushback
- pushback.tone: "curious" (genuinely want more), "probing" (gently questioning claims), or "encouraging" (supportive redirect)
- If all dimensions are >= 50, set pushback to null.

Respond with ONLY valid JSON matching this schema:
{
${dimensionSchema}${jdAlignmentSchema},
  "flags": string[],
  "probeDecision": {
    "shouldProbe": boolean,
    "probeType": "clarify" | "challenge" | "expand" | "quantify" | null,
    "probeQuestion": string | null,
    "probingRationale": string | null
  },
  "pushback": {
    "line": string,
    "targetDimension": string,
    "tone": "curious" | "probing" | "encouraging"
  } | null
}`

    try {
      const result = await completionStream({
        taskSlot: 'interview.evaluate-answer',
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      })

      const raw = result.text || '{}'
      const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
      const scores = JSON.parse(cleaned)

      // Map depth-specific dimensions back to standard eval format
      // Always include relevance/structure/specificity/ownership for backward compat
      const probeDecision = scores.probeDecision ?? { shouldProbe: false }
      const evaluation: AnswerEvaluation = {
        questionIndex,
        question,
        answer,
        relevance: scores.relevance ?? scores[scoringDims[0]?.name] ?? 50,
        structure: scores.structure ?? scores[scoringDims[1]?.name] ?? 50,
        specificity: scores.specificity ?? scores[scoringDims[2]?.name] ?? 50,
        ownership: scores.ownership ?? scores[scoringDims[3]?.name] ?? 50,
        ...(scores.jdAlignment !== undefined && { jdAlignment: scores.jdAlignment }),
        // Backward compat: populate needsFollowUp/followUpQuestion from probeDecision
        needsFollowUp: probeDecision.shouldProbe ?? false,
        followUpQuestion: probeDecision.probeQuestion ?? undefined,
        flags: scores.flags ?? [],
        probeDecision,
        ...(scores.pushback && { pushback: scores.pushback }),
      }

      trackUsage({
        user,
        type: 'api_call_evaluate',
        sessionId: body.sessionId,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        modelUsed: result.model,
        durationMs: Date.now() - startTime,
        success: true,
      }).catch((err) => aiLogger.warn({ err }, 'Usage tracking failed'))

      return NextResponse.json(evaluation)
    } catch (err) {
      aiLogger.error({ err }, 'LLM API error in evaluate-answer')

      trackUsage({
        user,
        type: 'api_call_evaluate',
        sessionId: body.sessionId,
        inputTokens: 0,
        outputTokens: 0,
        modelUsed: 'unknown',
        durationMs: Date.now() - startTime,
        success: false,
        errorMessage: err instanceof Error ? err.message : 'Unknown error',
      }).catch((err) => aiLogger.warn({ err }, 'Usage tracking failed'))

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
