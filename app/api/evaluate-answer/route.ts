import { NextResponse } from 'next/server'
import { completionStream } from '@shared/services/modelRouter'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { EvaluateAnswerSchema, EvaluateAnswerLlmSchema } from '@interview/validators/interview'
import { trackUsage } from '@shared/services/usageTracking'
import { aiLogger } from '@shared/logger'
import { DATA_BOUNDARY_RULE, JSON_OUTPUT_RULE } from '@shared/services/promptSecurity'
import { getDomainLabel } from '@interview/config/interviewConfig'
import { getSkillSections } from '@interview/services/core/skillLoader'
import { findCompanyProfile } from '@interview/config/companyProfiles'
import { connectDB, connectDBIfNeeded } from '@shared/db/connection'
import { User, InterviewDepth } from '@shared/db/models'
import { FALLBACK_DEPTHS } from '@shared/db/seed'
import { isFeatureEnabled } from '@shared/featureFlags'
import { getScoringDimensions, buildRubricPromptSection } from '@interview/services/eval/evaluationEngine'
import { getOrLoadJDContext, getOrLoadResumeContext } from '@interview/services/persona/documentContextCache'
import { getOrLoadSessionConfig } from '@interview/services/core/sessionConfigCache'
import type { AnswerEvaluation } from '@shared/types'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

type EvaluateAnswerBody = z.infer<typeof EvaluateAnswerSchema>

export const POST = composeApiRoute<EvaluateAnswerBody>({
  schema: EvaluateAnswerSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 15, keyPrefix: 'rl:eval' },

  async handler(req, { user, body }) {
    const { config, question, answer, questionIndex, probeDepth, sessionId, wasTruncatedByTimer } = body
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
        primaryGap: 'relevance',
        primaryStrength: 'relevance',
        probeDecision: { shouldProbe: false },
      } as AnswerEvaluation)
    }

    // Pre-fetch session config (depth, rubric, user profile) from Redis cache.
    const sessionCfg = sessionId
      ? await getOrLoadSessionConfig(sessionId, {
          role: config.role,
          interviewType,
          userId: user.id,
          experience: config.experience,
        }).catch(() => null)
      : null

    // Fetch depth-specific evaluation criteria — cache-first, Mongo fallback
    let evalCriteria = ''
    let scoringDims: { name: string; label: string; weight: number }[] = []

    try {
      // PR C Phase 1: skip connectDB when session cache populated the depth
      // — InterviewDepth.findOne below is the only Mongo read in this block.
      await connectDBIfNeeded(
        sessionCfg?.depth == null,
        'evaluate-answer:depth',
        sessionCfg == null ? 'sessionCfg-null' : 'depth-null',
      )
      const depthDoc = (sessionCfg?.depth != null
        ? sessionCfg.depth
        : await InterviewDepth.findOne({ slug: interviewType, isActive: true }).lean()) as {
        evaluationCriteria?: string
        scoringDimensions?: { name: string; label: string; weight: number }[]
      } | null
      if (depthDoc) {
        evalCriteria = depthDoc.evaluationCriteria || ''
        scoringDims = depthDoc.scoringDimensions || []
      } else {
        // Observability: same rationale as generate-question — silent fallback
        // on a missing/inactive CMS depth doc hides admin misconfiguration.
        // warn-level so it's distinguishable from the catch-level error below.
        aiLogger.warn(
          { slug: interviewType, source: 'InterviewDepth.findOne', fallback: 'FALLBACK_DEPTHS' },
          'CMS depth not found — using seeded fallback',
        )
      }
    } catch (err) {
      aiLogger.error(
        { err, interviewType, fallback: 'FALLBACK_DEPTHS' },
        'CMS depth fetch threw — using seeded fallback',
      )
    }

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

    // Try rubric-enhanced dimensions from evaluation engine.
    // Pass the cached rubric (if available) to avoid a redundant DB fetch.
    if (isFeatureEnabled('rubric_registry')) {
      try {
        const preloadedRubric = sessionCfg !== null
          ? (sessionCfg.rubric as { dimensions?: import('@shared/db/models').RubricDimension[] } | null)
          : undefined
        const rubricDims = await getScoringDimensions(config.role, interviewType, config.experience, preloadedRubric)
        if (rubricDims.length > 0) {
          scoringDims = rubricDims.map(d => ({ name: d.name, label: d.label, weight: d.weight }))
        }
      } catch { /* continue with existing dims */ }
    }

    // ── Context assembly — 4 independent fetches run in parallel ──
    // Previously sequential: JD → profile → skill file → resume, adding
    // 400-1200ms of avoidable latency from DB/cache round-trips. Each
    // fetch is independent; failures produce empty strings (same as before).
    const [jdResult, profileResult, skillResult, resumeResult] = await Promise.allSettled([
      // 1. JD context
      config.jobDescription && sessionId
        ? getOrLoadJDContext(sessionId, config.jobDescription)
        : Promise.resolve(null),
      // 2. User profile (cache-first from session config)
      (async () => {
        if (sessionCfg?.userProfile != null) return sessionCfg.userProfile
        await connectDB()
        return User.findById(user.id).select(
          'isCareerSwitcher switchingFrom interviewGoal weakAreas feedbackPreference ' +
          'targetCompanyType topSkills communicationStyle practiceStats',
        ).lean()
      })(),
      // 3. Skill file sections
      getSkillSections(config.role, interviewType, [
        'scoring-emphasis', 'red-flags', 'experience-calibration',
      ]).catch(() => null),
      // 4. Resume context
      config.resumeText && sessionId
        ? getOrLoadResumeContext(sessionId, config.resumeText, config.role)
        : Promise.resolve(null),
    ])

    // Build JD context
    let jdContext = ''
    if (config.jobDescription) {
      const jdCtx = jdResult.status === 'fulfilled' ? jdResult.value : null
      jdContext = jdCtx
        ? `\n\n<job_description_analysis>\n${jdCtx}\n</job_description_analysis>\n\nUse the structured analysis above to evaluate how well the answer aligns with the role's must-have requirements.`
        : `\n\n<job_description>\n${config.jobDescription.slice(0, 2000)}\n</job_description>\n\nUse the job description above to evaluate how well the answer aligns with the role's requirements.`
    }

    // Build profile context
    let profileContext = ''
    if (profileResult.status === 'fulfilled' && profileResult.value) {
      const profile = profileResult.value as Record<string, unknown>
      if (profile.isCareerSwitcher && profile.switchingFrom) {
        profileContext += `\nThis candidate is transitioning from ${profile.switchingFrom} — weight transferable skills and learning agility more heavily when scoring.`
      }
      if (profile.interviewGoal === 'first_interview') {
        profileContext += `\nThis is the candidate's first interview preparation — be encouraging in follow-up framing while still being honest about scores.`
      }
      if ((profile.weakAreas as string[] | undefined)?.length) {
        profileContext += `\nThe candidate wants to improve: ${(profile.weakAreas as string[]).join(', ')}. Flag related issues more explicitly in the flags array.`
      }
      if (profile.feedbackPreference) {
        const prefGuide: Record<string, string> = {
          encouraging: 'Frame follow-ups encouragingly. Acknowledge strengths before noting gaps.',
          balanced: 'Provide balanced feedback — acknowledge both strengths and areas for improvement.',
          tough_love: 'Be direct and critical. The candidate wants honest, unfiltered feedback.',
        }
        profileContext += `\n${prefGuide[profile.feedbackPreference as string] || ''}`
      }
      if (profile.targetCompanyType && profile.targetCompanyType !== 'any') {
        profileContext += `\nCalibrate scoring to ${profile.targetCompanyType} company standards.`
      }
      const practiceKey = `${config.role}:${interviewType}`
      const stats = (profile.practiceStats as Record<string, { totalSessions?: number; avgScore?: number }> | undefined)?.[practiceKey]
      if (stats?.totalSessions && stats.totalSessions >= 3) {
        profileContext += `\nExperienced practitioner (${stats.totalSessions} sessions, avg ${stats.avgScore}). Raise the bar — score more critically.`
      }
    }

    // Inject skill file sections
    if (skillResult.status === 'fulfilled' && skillResult.value) {
      evalCriteria = skillResult.value + (evalCriteria ? `\n${evalCriteria}` : '')
    }

    // Build company/industry context (synchronous — in-memory lookup)
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

    // Build resume context
    let resumeContext = ''
    if (config.resumeText) {
      const resumeCtx = resumeResult.status === 'fulfilled' ? resumeResult.value : null
      resumeContext = resumeCtx
        ? `\n\n<candidate_resume_analysis>\n${resumeCtx}\n</candidate_resume_analysis>\nCross-reference the candidate's answer with their resume claims above. Flag inconsistencies in the flags array (e.g., "Resume claims team lead but answer suggests IC role").`
        : `\n\n<candidate_resume>\n${config.resumeText.slice(0, 1500)}\n</candidate_resume>\nCross-reference the candidate's answer with their resume claims. Flag inconsistencies in the flags array (e.g., "Resume claims team lead but answer suggests IC role").`
    }

    const evalCriteriaBlock = evalCriteria ? `\n\nEVALUATION FOCUS: ${evalCriteria}` : ''

    // Cross-answer consistency: surface prior answer summaries so the LLM can detect contradictions
    let consistencyContext = ''
    if (body.previousAnswerSummaries?.length) {
      consistencyContext = `\n\nPREVIOUS ANSWERS (check for consistency):
${body.previousAnswerSummaries.map((s, i) => `Q${i+1} ("${s.question.slice(0, 60)}"): ${s.answerSummary}`).join('\n')}

If the current answer contradicts any prior claim (different role, conflicting timeline, inconsistent team size), set probeType to "challenge" and set probeTarget to the specific contradiction.`
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
      ? `\n- jdAlignment: How well does this answer demonstrate skills/experience relevant to the job description requirements? (integer 0-100) — When a job description is provided, this is the MOST IMPORTANT dimension. Weight it heavily.`
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

    // G.11 — scoring guide block. The legacy copy anchored Claude to a
    // 41-80 band and gated 81+ on "every dimension" being strong, which
    // at P(strong)~0.6 per dim makes top scores statistically
    // unreachable (~13%). The new copy preserves the 5 bands but
    // removes the 41-80 anchor, removes the "every dimension" gate,
    // and gives an explicit calibration example for the 85-92 range.
    // Flag-gated so we can A/B it against the legacy prompt before
    // full rollout.
    // G.11 (always-on post-G.15): the calibrated scoring guide is the
    // only path. Pre-G.15 was flag-gated on `scoring_v2_ceiling`;
    // flag definition stays in featureFlags.ts as dead-reference
    // until G.15c. The 41-80 anchor and the "every dimension" gate
    // that compressed scores into a 40-point band are gone for good.
    const scoringGuide = `SCORING GUIDE — calibrate to the answer in front of you; do not anchor to the middle.
- 0–20  : Off-topic, fabricated, or a non-answer.
- 21–40 : Weak. Missing key elements, no specifics, no ownership.
- 41–60 : Adequate but generic. Lacks depth, structure, or concrete detail.
- 61–80 : Good. Clear structure, specific examples, visible personal contribution.
- 81–100: Excellent. STAR-structured, quantified outcomes, clear ownership, strong relevance.

Score distribution is expected to SPREAD across all five bands across a session — do not cluster answers in 55–75. 81–100 is reachable when 3 of 4 dimensions are excellent AND no dimension is below 60. An answer with STAR structure, quantified outcomes, clear ownership, and strong relevance should score 85–92 even if specificity is only "good." Reserve 0–20 for off-topic, fabricated, or non-answers.`

    const userPrompt = `Evaluate this interview answer:

Question: "${question}"

<candidate_answer>
${answer}
</candidate_answer>

Score on these dimensions (integer 0–100):
${dimensionPrompt}${jdAlignmentDimension}

${scoringGuide}

Also determine:
- primaryGap: the dimension name with the lowest score (one of the dimension names above)
- primaryStrength: the dimension name with the highest score
- answerSummary: one concise sentence capturing the key factual claim(s) in this answer (e.g. "Led a cross-functional team of 8 to reduce churn by 20% at Company X"). Used for consistency tracking.

Probing decision:
- shouldProbe: true if the answer is vague, too short (<30 words), surface-level, evasive, missing key info, think-aloud rambling, or exceptionally interesting and worth exploring deeper
- probeType: "clarify" (ambiguous/unclear), "challenge" (logical gaps or untested assumptions), "expand" (worth exploring deeper), or "quantify" (lacks metrics/impact)
- probeTarget: a short phrase (3–8 words) naming what to probe — the specific gap, claim, or topic to follow up on (e.g. "the team's specific contribution", "the 20% improvement claim", "what you did after the pivot"). This is used to construct the follow-up question.
- isPivot: true ONLY if the answer has essentially nothing to do with the question asked (not just weak or partial).${probeDepthContext}${wasTruncatedByTimer ? `

NOTE: This answer was cut off when the interview timer expired — the candidate did NOT choose to stop. Score what was actually said on its own merits; do NOT penalize structure, specificity, or completeness for the parts the candidate didn't get to finish. Use primaryGap / shouldProbe based on content quality only.` : ''}

${JSON_OUTPUT_RULE}
{
${dimensionSchema}${jdAlignmentSchema},
  "primaryGap": string,
  "primaryStrength": string,
  "answerSummary": string,
  "shouldProbe": boolean,
  "probeType": "clarify" | "challenge" | "expand" | "quantify" | null,
  "probeTarget": string | null,
  "isPivot": boolean
}`

    try {
      let result = await completionStream({
        taskSlot: 'interview.evaluate-answer',
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      })

      // G.3: truncation detection + single retry with expanded budget.
      // The default maxTokens for this slot is 250 (see taskSlots.ts) which
      // is tight for rubrics with many dimensions or long probeTarget
      // phrases. Truncated payloads parse as partial JSON and silently
      // trip the `?? 50` fallbacks below — that's how we end up with
      // fabricated midrange scores. Pattern mirrors
      // app/api/generate-question/route.ts:575. The outer try/catch
      // still backstops any exception.
      let truncationRetried = false
      if (result.truncated) {
        truncationRetried = true
        aiLogger.warn(
          {
            taskSlot: 'interview.evaluate-answer',
            questionIndex,
            model: result.model,
            outputTokens: result.outputTokens,
          },
          'evaluate-answer truncated; retrying with expanded maxTokens',
        )
        const retry = await completionStream({
          taskSlot: 'interview.evaluate-answer',
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
          maxTokens: 500,
        })
        result = retry
      }

      const raw = result.text || '{}'
      const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
      // G.2: parse first, then Zod-validate. A parse failure is structurally
      // fatal (fall through to outer catch). A Zod failure is non-fatal —
      // log the issues and continue with the raw parsed object using the
      // existing per-field ?? fallbacks. This keeps us permissive in the
      // face of prompt drift while still catching structural corruption.
      // `scores` stays loose (any) to match the pre-G.2 behavior for the
      // downstream spread/indexing logic — the schema adds the safety
      // layer without narrowing the type surface.
      let scores: any /* eslint-disable-line */
      try {
        scores = JSON.parse(cleaned)
      } catch (parseErr) {
        aiLogger.error(
          { err: parseErr, raw: raw.slice(0, 500) },
          'evaluate-answer: JSON.parse failed',
        )
        throw parseErr
      }
      const parsedLlm = EvaluateAnswerLlmSchema.safeParse(scores)
      if (!parsedLlm.success) {
        aiLogger.warn(
          {
            issues: parsedLlm.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
            raw: raw.slice(0, 500),
          },
          'evaluate-answer: LLM response failed Zod validation — continuing with raw object',
        )
      }

      // G.3: mark the evaluation status so generate-feedback aggregation
      // can skip/flag truncated rows rather than trusting fabricated
      // midrange numbers. `truncated` means the retry also ran out of
      // tokens — the dims below were extracted from partial JSON and
      // should not be trusted as ground truth.
      const evalStatus: 'ok' | 'truncated' = result.truncated ? 'truncated' : 'ok'
      if (evalStatus === 'truncated') {
        aiLogger.warn(
          {
            taskSlot: 'interview.evaluate-answer',
            questionIndex,
            retry: truncationRetried,
            outputTokens: result.outputTokens,
          },
          'evaluate-answer truncated on retry; marking evaluation status=truncated',
        )
      }

      const evaluation: AnswerEvaluation = {
        questionIndex,
        question,
        answer,
        relevance: scores.relevance ?? scores[scoringDims[0]?.name] ?? 50,
        structure: scores.structure ?? scores[scoringDims[1]?.name] ?? 50,
        specificity: scores.specificity ?? scores[scoringDims[2]?.name] ?? 50,
        ownership: scores.ownership ?? scores[scoringDims[3]?.name] ?? 50,
        ...(scores.jdAlignment !== undefined && { jdAlignment: scores.jdAlignment }),
        ...(scores.primaryGap && { primaryGap: scores.primaryGap }),
        ...(scores.primaryStrength && { primaryStrength: scores.primaryStrength }),
        ...(scores.answerSummary && { answerSummary: scores.answerSummary }),
        status: evalStatus,
        // G.12: stamp the flag so generate-feedback's aggregation can
        // surface "X answers were cut off by the timer" in the red_flags
        // summary. Preserved alongside any content-quality flags Claude
        // emitted.
        ...(wasTruncatedByTimer && {
          flags: [...(Array.isArray(scores.flags) ? scores.flags as string[] : []), 'truncated_by_timer'],
        }),
        probeDecision: {
          shouldProbe: scores.shouldProbe ?? false,
          probeType: scores.probeType ?? null,
          probeTarget: scores.probeTarget ?? null,
          isPivot: scores.isPivot === true,
        },
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

      // G.3: mark this evaluation as failed so generate-feedback can
      // skip it in aggregation rather than trusting the placeholder
      // 60/55/55/60 values. Those numbers exist only to keep the
      // response shape backward-compatible for legacy clients that
      // might not understand `status` — the status field is the
      // authoritative signal.
      return NextResponse.json({
        questionIndex,
        question,
        answer,
        relevance: 60,
        structure: 55,
        specificity: 55,
        ownership: 60,
        status: 'failed',
        probeDecision: { shouldProbe: false },
      } as AnswerEvaluation)
    }
  },
})
