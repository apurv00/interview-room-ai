import { NextResponse } from 'next/server'
import { completionStream } from '@shared/services/modelRouter'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { EvaluateAnswerSchema } from '@interview/validators/interview'
import { trackUsage } from '@shared/services/usageTracking'
import { aiLogger } from '@shared/logger'
import { DATA_BOUNDARY_RULE, JSON_OUTPUT_RULE } from '@shared/services/promptSecurity'
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

    // Build resume context for cross-reference verification
    let resumeContext = ''
    if (config.resumeText) {
      resumeContext = `\n\n<candidate_resume>\n${config.resumeText.slice(0, 1500)}\n</candidate_resume>\nCross-reference the candidate's answer with their resume claims. Flag inconsistencies in the flags array (e.g., "Resume claims team lead but answer suggests IC role").`
    }

    const evalCriteriaBlock = evalCriteria ? `\n\nEVALUATION FOCUS: ${evalCriteria}` : ''

    // Cross-answer consistency: surface prior claims so the LLM can flag contradictions
    // Uses LLM-extracted key claims from previous answers (not raw truncated text)
    let consistencyContext = ''
    if (body.previousAnswerSummaries?.length) {
      consistencyContext = `\n\nPREVIOUS ANSWERS — KEY CLAIMS (check for consistency):
${body.previousAnswerSummaries.map((s, i) => `Q${i+1} ("${s.question.slice(0, 60)}"): ${s.keyClaimsFromAnswer}`).join('\n')}

If the candidate's current answer contradicts any prior claims (e.g., different role, conflicting timelines, inconsistent team sizes), flag it in the flags array as "Contradiction: [specific inconsistency]" and consider a "challenge" probe to surface it.`
    }

    const systemPrompt = `${DATA_BOUNDARY_RULE}

You are an expert interview coach evaluating candidates for ${domainLabel} roles at the ${config.experience} experience level. Interview type: ${interviewType}. You score objectively and fairly.${evalCriteriaBlock}${companyContext}${jdContext}${resumeContext}${profileContext}${consistencyContext}`

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

    // Funnel probe sequencing (P7): guide probe type based on depth
    // depth 0 (first probe) → expand (broad), depth 1 → clarify/quantify (specific),
    // depth 2+ → challenge (deep). The LLM can override if context demands it.
    let probeDepthContext = ''
    if (probeDepth != null && probeDepth > 0) {
      const funnelGuidance: Record<number, string> = {
        1: 'This is probe depth 1. PREFERRED probe type: "clarify" or "quantify" — drill into specifics (numbers, names, timelines, concrete details). Avoid broad "expand" probes at this depth.',
        2: 'This is probe depth 2. PREFERRED probe type: "challenge" — test assumptions, ask "what would you do differently?", or surface trade-offs. Only recommend further probing if genuinely new insight is possible.',
      }
      probeDepthContext = `\n${funnelGuidance[probeDepth] || `This is probe depth ${probeDepth}. Strongly prefer to move on — only probe if critical information is missing.`}`
    } else if (probeDepth === 0 || probeDepth == null) {
      probeDepthContext = '\nIf probing, PREFERRED probe type for first probe: "expand" — ask the candidate to tell you more, elaborate, or walk you through their thought process.'
    }

    const userPrompt = `Evaluate this interview answer:

Question: "${question}"

<candidate_answer>
${answer}
</candidate_answer>

Score on these dimensions (integer 0–100):
${dimensionPrompt}${jdAlignmentDimension}

Also determine:
- flags: array of red-flag strings (e.g. "Blame-shifting", "No measurable impact", "Contradiction: [detail]"). Empty array if none.
- keyAssertions: extract 2-3 factual claims from this answer that can be verified against future answers (e.g. "Led a team of 8", "Increased revenue by 30%", "Worked at Company X for 3 years"). These are used for cross-answer consistency tracking.
- isNonsensical: true ONLY if the answer is clearly a joke, gibberish, completely absurd, or has absolutely nothing to do with an interview context. A weak or vague answer is NOT nonsensical. Reserve this for genuinely absurd responses.

Think-aloud detection: If the answer reads like the candidate is thinking out loud (exploratory language like "so maybe...", "I guess...", hedging, self-corrections, no clear conclusion) rather than giving a final answer, set shouldProbe to true with probeType "clarify" and ask them to synthesize their thinking into a clear answer (e.g. "Those are interesting threads, can you pull them together into a clear recommendation?").

Determine probing decision:
- probeDecision.shouldProbe: true if the answer would benefit from probing — answer is vague, too short (<30 words), surface-level, evasive, missing key info, or exceptionally interesting and worth exploring deeper
- probeDecision.probeType: one of "clarify" (ambiguous terms or unclear details), "challenge" (logical gaps or untested assumptions), "expand" (promising answer worth exploring deeper), or "quantify" (lacks measurable impact or metrics)
- probeDecision.probeQuestion: a natural, conversational follow-up probe (one sentence). Frame as curious exploration, not interrogation.
- probeDecision.probingRationale: brief reason for the probing decision (for coaching context)
- probeDecision.isPivot: true ONLY if the candidate clearly changed the subject or gave an answer about a completely different topic than what was asked. A partially relevant or weak answer is NOT a pivot — a pivot is when the answer has essentially nothing to do with the question asked. If isPivot is true, probeQuestion should re-anchor to the original question (e.g. "I appreciate that context, but I'd love to hear specifically about [original topic]. Can you walk me through that?").${probeDepthContext}

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

${JSON_OUTPUT_RULE}
{
${dimensionSchema}${jdAlignmentSchema},
  "flags": string[],
  "keyAssertions": string[],
  "isNonsensical": boolean,
  "probeDecision": {
    "shouldProbe": boolean,
    "probeType": "clarify" | "challenge" | "expand" | "quantify" | null,
    "probeQuestion": string | null,
    "probingRationale": string | null,
    "isPivot": boolean
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
        // LLM-extracted key assertions for cross-answer consistency tracking (C2)
        ...(scores.keyAssertions?.length && { keyAssertions: scores.keyAssertions }),
        // E7: nonsensical/joke answer detection
        ...(scores.isNonsensical && { isNonsensical: true }),
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
