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
import { updatePracticeStats, deriveStrongWeakDimensions } from '@learn/services/practiceStatsService'
import { updateMasteryBatch } from '@learn/services/masteryTracker'
import { advanceUniversalPlan } from '@learn/services/pathwayPlanner'
import { registerPathwayBadgeWiring } from '@learn/services/pathwayBadgeWiring'
import { evaluateSession } from '@interview/services/eval/evaluationEngine'
import { getUserCompetencySummary } from '@learn/services/competencyService'
import { buildHistorySummary } from '@learn/services/sessionSummaryService'
import { DATA_BOUNDARY_RULE, JSON_OUTPUT_RULE } from '@shared/services/promptSecurity'
import { recordScoreDelta } from '@shared/services/scoreTelemetry'
import { acquireFeedbackLock, releaseFeedbackLock } from '@shared/services/feedbackLock'
import { computeBlendedOverallScore, resolveBlendWeights } from '@interview/services/eval/overallScore'
import { computePerQAverage, computeAnswerQualityAggregate } from '@interview/services/eval/perQAggregation'
import { computeCompletionAdjustment } from '@interview/services/eval/completionAdjustment'
import { compactTranscript } from '@interview/services/eval/transcriptCompactor'
import { computeEngagementContext } from '@interview/services/eval/engagementContext'
import { getQuestionCount } from '@interview/config/interviewConfig'
import type { Duration } from '@shared/types'
import { z } from 'zod'

registerPathwayBadgeWiring()

export const dynamic = 'force-dynamic'
// Feedback generation calls Claude Sonnet with a large prompt (transcript +
// evaluations + profile context) and requests up to 4000 output tokens.
// Without this, Vercel Hobby defaults to ~10s which is too short for Sonnet.
export const maxDuration = 60

type GenerateFeedbackBody = z.infer<typeof GenerateFeedbackSchema>

// `computeEngagementContext` used to live here as an inline helper.
// It moved to `modules/interview/services/eval/engagementContext.ts`
// on 2026-04-24 because Next.js App Router route files only permit
// HTTP method handlers + route-config exports — a named helper export
// triggers `"computeEngagementContext" is not a valid Route export
// field` during `next build`. Codex P0 + Vercel deploy on PR #319.
// `tsc --noEmit` does NOT catch this; the validation runs only inside
// the Next.js builder. Tests still import from the module path.

export const POST = composeApiRoute<GenerateFeedbackBody>({
  schema: GenerateFeedbackSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 5, keyPrefix: 'rl:feedback' },

  async handler(req, { user, body }) {
    const { config, transcript, evaluations, speechMetrics } = body
    const startTime = Date.now()
    const interviewType = config.interviewType || 'screening'
    const domainLabel = getDomainLabel(config.role)

    // G.6 Phase A — Idempotency lock. The client fires this endpoint
    // twice for the same session: once fire-and-forget from
    // useInterview.ts:889 on interview end, and once from
    // app/feedback/[sessionId]/page.tsx:453 if the first call isn't
    // visible within 8s. Since Sonnet feedback gen is routinely
    // 8-20s, both run in parallel, double the LLM bill, race on
    // InterviewSession.feedback, and double-fire every post-feedback
    // side effect (competency, pathway, summary, weakness clusters,
    // XP). The lock is only sessionId-scoped — the no-sessionId path
    // (rare: local-only fallback) falls through unlocked.
    let feedbackLock: Awaited<ReturnType<typeof acquireFeedbackLock>> | null = null
    if (body.sessionId) {
      feedbackLock = await acquireFeedbackLock(body.sessionId)
      if (feedbackLock === null) {
        aiLogger.info(
          { sessionId: body.sessionId, userId: user.id },
          'generate-feedback: duplicate request short-circuited by idempotency lock',
        )
        return NextResponse.json(
          {
            status: 'in_progress',
            message: 'Feedback generation already in progress for this session — poll session.feedback.',
          },
          { status: 202 },
        )
      }
      if (!feedbackLock.acquired) {
        aiLogger.error(
          { sessionId: body.sessionId, userId: user.id },
          'generate-feedback: Redis unavailable — refusing to proceed without idempotency guarantee',
        )
        return NextResponse.json(
          {
            error: 'Service temporarily unavailable — please retry in a few seconds.',
          },
          { status: 503 },
        )
      }
    }

    // G.6 Phase A — try/finally wrapper so the lock is released on
    // every exit path (early-exit, happy path, outer catch). The
    // try/catch nested below continues to handle LLM errors as today.
    try {
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

    // G.10 — completion-shape inputs + short-form guard.
    // Derive plannedQuestionCount and answeredCount from whatever the
    // caller supplied (client-populated by G.7 in useInterview) with
    // safe fallbacks: evaluations.length for answered count, and
    // getQuestionCount(config.duration) for planned count. Legacy
    // sessions (pre-G.7) hit the fallbacks; they still get sensible
    // numbers and the flag-gated adjustment stays a no-op until
    // scoring_v2_completion flips on.
    const g10PlannedCount =
      typeof body.plannedQuestionCount === 'number' && body.plannedQuestionCount > 0
        ? body.plannedQuestionCount
        : (() => {
            try { return getQuestionCount(config.duration as Duration) } catch { return 0 }
          })()
    const g10AnsweredCount =
      typeof body.answeredCount === 'number' && body.answeredCount >= 0
        ? body.answeredCount
        : evaluations.length
    const g10EndReason = body.endReason ?? 'normal'
    const g10Adjustment = computeCompletionAdjustment({
      plannedQuestionCount: g10PlannedCount,
      answeredCount: g10AnsweredCount,
      endReason: g10EndReason,
    })

    // Short-form guard: refuse to emit a scored report for <3 answers.
    // Flag-gated so turning the completion policy on is a single flip
    // in config. The resulting feedback object mirrors noDataFeedback
    // above but uses the G.10 red_flag copy so the user understands
    // WHY the score is withheld.
    // G.10 short-form guard (always-on post-G.15): refuse to score
    // <3 answers regardless of flag state. Pre-G.15 was gated on
    // `scoring_v2_completion`; flag definition stays in
    // featureFlags.ts as dead-reference until G.15c.
    if (g10Adjustment.shouldReturnShortForm) {
      const shortFormFeedback: FeedbackData = {
        // overall_score 0 here matches the noDataFeedback shape so
        // downstream display doesn't need special handling for the
        // short-form branch. The red_flag copy is the real user
        // signal.
        overall_score: 0,
        pass_probability: 'Low',
        confidence_level: 'Low',
        dimensions: {
          answer_quality: {
            score: 0,
            strengths: [],
            weaknesses: [`Answered ${g10AnsweredCount} of ${g10PlannedCount} planned — not enough to score.`],
          },
          communication: { score: 0, wpm: 0, filler_rate: 0, pause_score: 0, rambling_index: 0 },
          engagement_signals: { score: 0, engagement_score: 0, confidence_trend: 'stable', energy_consistency: 0, composure_under_pressure: 0 },
        },
        red_flags: g10Adjustment.redFlags,
        top_3_improvements: [
          'Complete the full interview to receive a scored report.',
          'Practice with a shorter 10-minute session first to build stamina.',
          'Use the Coach Mode if the pacing feels fast — it slows the questions.',
        ],
      }
      if (body.sessionId) {
        InterviewSession.findByIdAndUpdate(body.sessionId, {
          feedback: shortFormFeedback,
          status: 'completed',
          completedAt: new Date(),
        }).catch((err) => aiLogger.warn({ err, sessionId: body.sessionId }, 'Failed to persist short-form feedback'))
      }
      aiLogger.info(
        {
          sessionId: body.sessionId,
          userId: user.id,
          answeredCount: g10AnsweredCount,
          plannedQuestionCount: g10PlannedCount,
          endReason: g10EndReason,
        },
        'G.10 short-form guard: refusing to score interview with <3 answers',
      )
      return NextResponse.json(shortFormFeedback)
    }

    // F-4: concurrent-writer short-circuit. The Redis lock fails open
    // on connection errors (feedbackLock.ts:83-87), which lets both the
    // finishInterview pre-gen + the feedback page's fallback call run
    // the full Claude + side-effect pipeline in parallel — 2× LLM bill,
    // double-fired XP, competency, pathway. Read session.feedback once
    // right before the expensive work. If another caller already landed
    // a result in the DB, reuse it; skip the duplicate Claude call and
    // all side effects. The try/catch keeps this check non-fatal: a
    // transient DB blip or a mock with no findOne falls through to
    // the original pipeline (same behavior as pre-F-4).
    //
    // SECURITY: sessionId is client-supplied and not formatted-checked
    // before this point, so the lookup MUST be owner-scoped. A bare
    // findById would turn this endpoint into a cross-account feedback
    // oracle — any authenticated user who learned another user's
    // sessionId could fetch that user's overall_score, dimensions,
    // red_flags, etc. Scoping on { _id, userId: user.id } ensures a
    // mismatched owner gets null (same as "no cached feedback"),
    // falling through to the normal generation path. The indexed
    // { userId: 1, ... } compounds on InterviewSession keep this
    // O(log n) — no measurable latency delta vs findById.
    if (body.sessionId) {
      try {
        await connectDB()
        const existing = (await InterviewSession.findOne({
          _id: body.sessionId,
          userId: user.id,
        })
          .select('feedback')
          .lean()) as { feedback?: FeedbackData } | null
        // Codex P1 on PR #311: when the persisted feedback is a degraded
        // fallback (outer-catch path), the UI shows a Retry button that
        // re-POSTs to this route. Pre-fix, this preflight short-circuit
        // returned the SAME degraded payload the user is trying to escape
        // — retry was a no-op. Treat any truthy `degraded` as "no valid
        // feedback yet" so regeneration proceeds. The feedbackLock
        // acquired above still prevents concurrent writers from racing
        // to the LLM.
        //
        // Codex P2 follow-up on PR #311: use `Boolean(...)` rather than
        // strict-equality `=== true`. The UI at feedback page.tsx:996
        // does a truthy check (`{feedback.degraded && ...}`), so if a
        // non-boolean value ever survives persistence (e.g.
        // `"true"` via a future legacy payload or a schema-drift edge
        // case), server + UI MUST agree on what counts as degraded.
        // Without normalisation the UI would show the retry banner
        // (truthy), but the server would hit the cache-return branch
        // (strict `!== true`), and retry becomes a no-op again — the
        // exact regression this P2 guards against.
        const isDegraded = Boolean(existing?.feedback?.degraded)
        if (existing?.feedback && !isDegraded) {
          aiLogger.info(
            { sessionId: body.sessionId, userId: user.id, redisLockAcquired: feedbackLock?.acquired ?? null },
            'generate-feedback: concurrent writer already produced feedback; returning cached (F-4)',
          )
          return NextResponse.json(existing.feedback)
        }
        if (isDegraded) {
          aiLogger.info(
            { sessionId: body.sessionId, userId: user.id, rawDegraded: existing?.feedback?.degraded },
            'generate-feedback: persisted feedback is degraded; bypassing cache to allow user-triggered retry (Codex P1 on #311)',
          )
        }
      } catch (err) {
        aiLogger.warn(
          { err, sessionId: body.sessionId },
          'generate-feedback: pre-flight session read failed, proceeding without concurrent-writer check (F-4)',
        )
      }
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

    // Build transcript text. G.13 (always-on post-G.15): always use
    // the per-question-summary builder so Claude sees coverage of
    // ALL questions, with full detail for the 2 weakest. Pre-G.15
    // was flag-gated on `compact_transcript`; the head/tail slice
    // fallback is gone for good. When compactor returns empty
    // (zero evaluations or empty transcript), fall back to the
    // raw joined transcript so the downstream prompt still has a
    // block to anchor on.
    const transcriptLines = transcript.map(
      (e) => `${e.speaker === 'interviewer' ? 'Interviewer' : 'Candidate'}: ${e.text}`
    )
    const fullTranscript = transcriptLines.join('\n')
    const compacted = compactTranscript({
      transcript,
      evaluations: evaluations as unknown as import('@shared/types').AnswerEvaluation[],
    })
    const transcriptText: string = compacted.text || fullTranscript
    if (compacted.budgetHit) {
      aiLogger.info(
        {
          sessionId: body.sessionId,
          summarizedCount: compacted.summarizedCount,
          fullDetailIndices: compacted.fullDetailIndices,
        },
        'G.13 compact-transcript hit budget — full detail partially omitted',
      )
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
        // Server owns the `degraded` flag. The LLM schema uses
        // `.passthrough()`, so a hallucinated or prompt-injected
        // `"degraded": true` in Claude's JSON would otherwise survive
        // into this object and trip the `!feedback.degraded` gates
        // below (suppressing persist + side effects on an otherwise
        // healthy response) and the cache-bypass at :331 (forcing a
        // regeneration). Strip any incoming value here; only the
        // server's inner-fallback (route.ts:710) and outer-catch
        // (route.ts:1220) paths set it legitimately. Codex P2 on #317.
        delete (feedback as { degraded?: unknown }).degraded
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
        // G.4: reuse the failed-row-aware helper here too.
        const preQ = computePerQAverage(evaluations as unknown as Array<Record<string, unknown>>)
        // G.5: `??` — a legit 0 (no-answer session) must not be
        // stomped to preQ.average. `||` did exactly that.
        feedback.overall_score = feedback.overall_score ?? preQ.average
        feedback.dimensions = feedback.dimensions || {
          answer_quality: { score: feedback.overall_score, strengths: [], weaknesses: [] },
          communication: { score: commScore, wpm: aggMetrics.wpm, filler_rate: aggMetrics.fillerRate, pause_score: aggMetrics.pauseScore, rambling_index: aggMetrics.ramblingIndex },
          engagement_signals: { score: Math.round(feedback.overall_score * 0.9), engagement_score: Math.round(feedback.overall_score * 0.85), confidence_trend: 'stable' as const, energy_consistency: 0.7, composure_under_pressure: 65 },
        }
        feedback.pass_probability = feedback.pass_probability || (feedback.overall_score >= 70 ? 'High' : feedback.overall_score >= 50 ? 'Medium' : 'Low')
        // Fabricated-dimensions contract — match the outer-catch path at
        // :1201 (PR #311 `3e425cc`). Before this fix the inner fallback
        // shipped literal constants (composure_under_pressure: 65,
        // energy_consistency: 0.7) and multiplier-derived engagement
        // scores with confidence_level='Medium' and no `degraded` flag,
        // so downstream readers (dashboard last-score tile, history
        // pass-badge, peer-comparison $avg) couldn't distinguish it from
        // real feedback. Forcing the same Low-confidence + degraded
        // invariant the outer-catch uses gates those readers (they
        // already short-circuit on `feedback.degraded`) and fires the
        // page-level retry banner for the user.
        feedback.confidence_level = 'Low'
        feedback.degraded = true
        feedback.red_flags = Array.isArray(feedback.red_flags) ? feedback.red_flags : []
        if (!feedback.red_flags.some((f) => typeof f === 'string' && f.includes('approximate'))) {
          feedback.red_flags.push('AI feedback response was incomplete — some dimension scores are approximate.')
        }
        feedback.top_3_improvements = feedback.top_3_improvements || ['Practice more structured answers']
      }

      // Enforce pre-computed communication score (Claude may deviate from the provided value)
      if (feedback.dimensions?.communication) {
        feedback.dimensions.communication.score = commScore
      }

      // BUG 2 fix: derive answer_quality from the actual per-question evaluation
      // scores instead of trusting Claude's free-form summary value, which had
      // no rubric anchors and tended to inflate to 60-75.
      // G.4: delegate to a status-aware helper so status='failed' rows
      // (whose 60/55/55/60 shape is a placeholder, not real scores)
      // are excluded from the aggregate.
      // G.9 (always-on post-G.15): use the dimension-aware weighted
      // aggregate as the displayed answer_quality.score so outlier
      // signal (top moments + bottom moments) survives the
      // aggregation. Pre-G.15 this was flag-gated on `scoring_v2_aq`;
      // the flag definition stays in featureFlags.ts as a dead-
      // reference until G.15c. `perQAvg` (the flat mean) is still
      // the input to the overall-score formula/blend — only the
      // user-visible AQ dimension differs here.
      const perQ = computeAnswerQualityAggregate(evaluations as unknown as Array<Record<string, unknown>>)
      const perQAvg = perQ.average
      const aqDisplayScore = perQ.weighted

      // Override Claude's answer_quality score with the deterministic value.
      if (feedback.dimensions?.answer_quality) {
        feedback.dimensions.answer_quality.score = aqDisplayScore
      }

      // Deterministic formula overall score: weighted average of
      // dimensions (40% AQ, 30% Comm, 30% Engagement). Pre-G.8 this
      // was the final user-facing number. With G.8 it's one INPUT to
      // the blend — see below.
      const aqScore = perQAvg
      const engScore = feedback.dimensions?.engagement_signals?.score ?? 0
      const formulaOverall = Math.round(aqScore * 0.4 + commScore * 0.3 + engScore * 0.3)

      // G.8: blend Claude's holistic overall_score with the
      // deterministic formula. Flag-gated so we can ramp the rollout
      // and A/B-compare against G.1 telemetry. When the flag is off,
      // `overall_score` stays exactly what pre-G.8 produced. When on,
      // Claude's value is factored in (defaulting to 0.6 weight) so
      // scores escape the compressed 55–75 band — but a safety clamp
      // engages if Claude disagrees wildly (|Δ| > 20) to prevent a
      // hallucinated extreme from dominating the user-visible number.
      // G.8 (always-on post-G.15): blend Claude's holistic
      // overall_score with the deterministic formula. Pre-G.15 this
      // was flag-gated on `scoring_v2_overall`; the flag definition
      // remains in shared/featureFlags.ts as a dead-reference until
      // G.15c cleanup but the code path is now unconditional. Safety
      // clamp engages if Claude disagrees wildly (|Δ| > 20) so a
      // hallucinated Claude value can't dominate the user-visible
      // number.
      const blend = computeBlendedOverallScore(
        claudeRawOverall,
        formulaOverall,
        resolveBlendWeights(),
      )
      feedback.overall_score = blend.blended
      const blendMode: 'agreement' | 'disagreement' | 'formula-only' = blend.mode
      feedback.pass_probability = feedback.overall_score >= 75 ? 'High' : feedback.overall_score >= 50 ? 'Medium' : 'Low'

      aiLogger.info(
        {
          sessionId: body.sessionId,
          formulaOverall,
          claudeRawOverall,
          finalOverall: feedback.overall_score,
          blendMode,
        },
        'overall_score computed',
      )

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
            // G.4: we now EXCLUDE these from perQAvg rather than
            // averaging in the 60/55/55/60 placeholder. Message
            // reflects the new behavior so users know the reported
            // answer_quality score is built only on the rows that
            // actually got scored.
            `${failedEvalCount} answer${failedEvalCount === 1 ? '' : 's'} could not be scored — AI evaluation failed and these were excluded from the answer-quality average.`,
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

      // G.12 — surface timer-truncated per-answer rows as a user-visible
      // red_flag. The evaluate-answer route (also G.12) stamps
      // 'truncated_by_timer' onto evaluation.flags when the client
      // reported the answer was cut off by the interview timer. We count
      // those here and, if any, add a single clarifying red_flag so the
      // user understands WHY structure/specificity on those questions
      // might look lower than expected (note: the route also tells
      // Claude not to penalize, so typically they don't, but the red
      // flag is still the right UX signal).
      const timerTruncatedCount = evaluations.filter(
        (e) => Array.isArray(e.flags) && e.flags.includes('truncated_by_timer'),
      ).length
      if (timerTruncatedCount > 0) {
        feedback.red_flags = Array.isArray(feedback.red_flags) ? feedback.red_flags : []
        feedback.red_flags.push(
          `${timerTruncatedCount} answer${timerTruncatedCount === 1 ? ' was' : 's were'} cut off when the timer expired — scoring does not penalize those for incompleteness.`,
        )
      }

      // G.10 — partial-completion adjustment (always-on post-G.15).
      // Runs AFTER G.8's blend computed the final overall_score AND
      // after G.3's confidence clamp, so this is the last word on both
      // fields. Pre-G.15 was flag-gated on `scoring_v2_completion`;
      // flag definition stays in featureFlags.ts as dead-reference
      // until G.15c.
      //
      //   - Apply scoreMultiplier to overall_score (full credit ≥60%
      //     completion, linear taper below).
      //   - Clamp confidence_level to 'Low' when <50% completion.
      //   - Push the end-reason red_flag so the user understands.
      //   - Recompute pass_probability from the adjusted overall_score.
      if (feedback.overall_score != null) {
        if (g10Adjustment.scoreMultiplier < 1) {
          feedback.overall_score = Math.round(feedback.overall_score * g10Adjustment.scoreMultiplier)
          feedback.pass_probability = feedback.overall_score >= 75 ? 'High' : feedback.overall_score >= 50 ? 'Medium' : 'Low'
        }
        if (g10Adjustment.clampConfidenceTo === 'Low') {
          feedback.confidence_level = 'Low'
        }
        if (g10Adjustment.redFlags.length > 0) {
          feedback.red_flags = Array.isArray(feedback.red_flags) ? feedback.red_flags : []
          for (const f of g10Adjustment.redFlags) {
            feedback.red_flags.push(f)
          }
        }
        aiLogger.info(
          {
            sessionId: body.sessionId,
            answeredCount: g10AnsweredCount,
            plannedQuestionCount: g10PlannedCount,
            completionRatio: g10Adjustment.completionRatio,
            scoreMultiplier: g10Adjustment.scoreMultiplier,
            endReason: g10EndReason,
          },
          'G.10 completion adjustment applied',
        )
      }

      // G.1 telemetry — record Claude's raw value vs the deterministic
      // formula value. G.8 NOTE: we record `formulaOverall` here (not
      // `feedback.overall_score`) so the A/B analysis keeps comparing
      // the pre-G.8 "what-the-formula-alone-would-have-returned" value
      // against Claude's raw value. The actually-shipped blended value
      // is logged separately via aiLogger above and can be reconstructed
      // from (claudeOverallScore, deterministicOverallScore, blend
      // weights) if needed. Fire-and-forget; never blocks the response.
      if (body.sessionId) {
        recordScoreDelta({
          sessionId: body.sessionId,
          userId: user.id,
          source: 'generate-feedback',
          taskSlot: 'interview.generate-feedback',
          modelUsed: result.model ?? 'unknown',
          claudeOverallScore: claudeRawOverall,
          deterministicOverallScore: formulaOverall,
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
      //
      // Degraded-guard (2026-04-24 inner-fallback extension): when the
      // inner fallback at route.ts:685 fires because Claude's JSON was
      // incomplete, `feedback.degraded` is set. Matching the outer-catch
      // contract (PR #311 fb69ef6 — "Stop persisting degraded feedback
      // fallback to Mongo"), we skip the write here too. The cache-
      // bypass branch at :331 still protects LEGACY sessions that were
      // persisted before this fix, but NEW degraded runs never land in
      // Mongo — retries just see a cache miss and re-invoke the LLM.
      if (body.sessionId && !feedback.degraded) {
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
      // All fire-and-forget to not block the response.
      //
      // F-3: each side effect is pushed to a `sideEffects` list so a
      // single aggregate log line at the end of the handler reports
      // how many of the N calls succeeded/failed. Individual `.catch`
      // handlers still emit their specific context; the aggregate is a
      // single at-a-glance line for ops ("5/5 succeeded" vs "3/5, failed:
      // [pathwayPlan, practiceStats]"), which was impossible before
      // because the per-call warns had no sessionId and couldn't be
      // correlated across a session.
      //
      // Degraded-guard (Codex P1 on #317): the side-effects in this
      // block are NON-IDEMPOTENT across retries. `advanceUniversalPlan`
      // increments `sessionsCompleted` on every invocation
      // (pathwayPlanner.ts:541); `updateCompetencyState` appends to
      // `scoreHistory` per session (competencyService.ts:90);
      // `updateMasteryBatch` bumps streak counters;
      // `updateWeaknessClusters` appends cluster observations; the
      // feedback-dependent trio (`updatePracticeStats`,
      // `generateSessionSummary`, `generatePathwayPlan`) also write or
      // LLM-call on the fabricated dimensions. Since the degraded path
      // no longer persists feedback (see :936), the user's retry hits a
      // cache miss and re-invokes this whole block — firing every
      // non-idempotent write a SECOND time for the same interview.
      // Skip the whole block on degraded; retries get exactly one
      // successful run of side effects. Matches the outer-catch
      // contract (PR #311 fb69ef6), which bypasses this block entirely
      // by throwing before reaching it.
      //
      // `trackUsage` (billing, :946) and `recordScoreDelta` (G.1
      // telemetry, :908) are intentionally OUTSIDE this guard — both
      // need to fire on every attempt including degraded ones.
      if (body.sessionId && !feedback.degraded) {
        const sessionId = body.sessionId
        const typedEvaluations = evaluations as unknown as AnswerEvaluation[]

        const sideEffects: Array<{ name: string; promise: Promise<unknown> }> = []
        const fireAndTrack = (
          name: string,
          promise: Promise<unknown>,
          errLabel: string,
        ) => {
          sideEffects.push({ name, promise })
          // Attach the per-call warn separately so the raw promise
          // retains its rejected state for allSettled below.
          promise.catch((err) =>
            aiLogger.warn({ err, sessionId, userId: user.id, sideEffect: name }, errLabel),
          )
        }

        // G.14: flag-gated practiceStats write. When
        // xp_from_feedback=true, this is the authoritative path —
        // /api/learn/stats no-ops for duplicate writes (see
        // app/api/learn/stats/route.ts). We use the deterministic
        // `feedback.overall_score` (post-G.8 blend, post-G.10
        // completion multiplier) so XP matches the number the user
        // sees on their feedback page. Fire-and-forget; never blocks
        // the response.
        // G.14 (always-on post-G.15): server-side XP write is now
        // unconditional. The legacy /api/learn/stats endpoint
        // permanently no-ops in the same chunk so dual-write
        // double-counting can't happen.
        if (typeof feedback.overall_score === 'number') {
          const { strongDimensions, weakDimensions } = deriveStrongWeakDimensions(
            evaluations as unknown as Array<Record<string, unknown>>,
          )
          fireAndTrack(
            'practiceStats',
            updatePracticeStats({
              userId: user.id,
              domain: config.role,
              interviewType,
              score: feedback.overall_score,
              strongDimensions,
              weakDimensions,
            }),
            'G.14 practiceStats write failed',
          )
        }

        // Update competency state
        fireAndTrack(
          'competency',
          updateCompetencyState({
            userId: user.id,
            sessionId,
            domain: config.role,
            evaluations: typedEvaluations,
          }),
          'Competency state update failed',
        )

        // Generate session summary
        fireAndTrack(
          'sessionSummary',
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
          }),
          'Session summary generation failed',
        )

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
          fireAndTrack(
            'weaknessClusters',
            updateWeaknessClusters({
              userId: user.id,
              sessionId,
              weaknesses: weaknessInputs,
            }),
            'Weakness cluster update failed',
          )
        }

        // Generate session-level evaluation and pathway plan.
        // Chain both into a single tracked side effect so the aggregate
        // count reflects "pathway ready" as one unit — a failed
        // evaluateSession still flows through as a single rejection
        // attributed to `pathwayPlan`.
        fireAndTrack(
          'pathwayPlan',
          evaluateSession({
            domain: config.role,
            interviewType,
            seniorityBand: config.experience,
            evaluations: typedEvaluations,
          }).then(sessionEval =>
            generatePathwayPlan({
              userId: user.id,
              sessionId,
              domain: config.role,
              interviewType,
              experience: config.experience,
              feedback,
              sessionEvaluation: sessionEval,
            }),
          ),
          'Pathway plan (via session evaluation) failed',
        )

        // Mastery tracking: compute per-dimension averages from evaluations
        // and update the consecutive-at-target streak for each competency.
        const MASTERY_DIMS = ['relevance', 'structure', 'specificity', 'ownership'] as const
        const realEvals = typedEvaluations.filter((e) => (e as { status?: string }).status !== 'failed')
        if (realEvals.length > 0) {
          const dimScores: Record<string, number> = {}
          for (const dim of MASTERY_DIMS) {
            const avg = realEvals.reduce(
              (sum, e) => sum + (Number((e as unknown as Record<string, unknown>)[dim]) || 0),
              0,
            ) / realEvals.length
            dimScores[dim] = Math.round(avg)
          }
          fireAndTrack(
            'masteryTracking',
            Promise.resolve().then(() => updateMasteryBatch(user.id, dimScores, config.role)),
            'Mastery tracking batch update failed',
          )
        }

        // Advance universal plan: bump sessionsCompleted, detect phase graduation
        fireAndTrack(
          'universalPlanAdvance',
          Promise.resolve().then(() => advanceUniversalPlan(user.id)),
          'Universal plan advancement failed',
        )

        // F-3 aggregate summary: runs after the response is returned
        // (the `return` below fires first). Uses Promise.allSettled so
        // one failing side effect doesn't poison the others. One log
        // line per interview with the exact count + names of failures
        // gives ops a tractable signal; the individual warns above
        // provide root cause.
        Promise.allSettled(sideEffects.map(s => s.promise)).then((results) => {
          const failed = results
            .map((r, i) => ({
              name: sideEffects[i].name,
              reason:
                r.status === 'rejected'
                  ? r.reason instanceof Error
                    ? r.reason.message
                    : String(r.reason)
                  : null,
            }))
            .filter((r) => r.reason !== null)
          aiLogger.info(
            {
              sessionId,
              userId: user.id,
              totalSideEffects: sideEffects.length,
              succeeded: sideEffects.length - failed.length,
              failedCount: failed.length,
              ...(failed.length > 0 && { failed }),
            },
            'generate-feedback: post-feedback side effects settled',
          )
        })
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

      // Compute a rough score from evaluations if available, otherwise use minimal defaults.
      // G.4: use the shared failed-row-aware helper so the outer catch
      // path doesn't re-introduce the fabricated-fallback averaging bug
      // that the main path now avoids.
      const hasEvals = evaluations && evaluations.length > 0
      const roughScore = hasEvals
        ? computePerQAverage(evaluations as unknown as Array<Record<string, unknown>>).average
        : 0

      const fallbackCommScore = commScore || 0
      const fallbackEngScore = Math.round(roughScore * 0.9)
      const fallbackOverall = Math.round(roughScore * 0.4 + fallbackCommScore * 0.3 + fallbackEngScore * 0.3)

      // 2026-04-22 follow-up on P0 (option B): the outer-catch synthetic
      // score is returned to the in-flight client but is NEVER persisted
      // to `InterviewSession.feedback`. The `degraded: true` flag on the
      // response lets the feedback page render a banner + Retry CTA for
      // this request only.
      //
      // The first iteration of the P0 fix (PR #311) DID persist the
      // fallback with `degraded: true` and relied on every reader to
      // gate on the flag. A gitNexus-backed audit (see
      // `.claude/audit/current/impact-app_api_generate-feedback_route.ts.md`)
      // identified ~10 reader sites — dashboard "last score" tile,
      // history pass-badge, score-trend chart, recruiter scorecard,
      // pathway planner LLM prompt, session summary LLM prompt, GDPR
      // data export, peer-comparison `$avg` aggregation, print/PDF
      // builder, shareable-link renderer — and none of them gated on
      // `degraded`. Persisting the synthetic payload leaked a fabricated
      // 30/100 with "use the STAR framework" hardcoded advice into all
      // of those surfaces without the banner, and corrupted the
      // peer-cohort baseline for every other user via the `$avg`
      // aggregation.
      //
      // By not persisting, downstream readers see `feedback === undefined`
      // and hit their existing no-feedback code paths ("not generated
      // yet"). A reload/retry re-enters this route; on success a real
      // feedback lands in Mongo, on re-failure nothing lands. Session
      // status is already stamped `'completed'` at interview end by
      // `useInterview.ts` so we don't strand the session by skipping the
      // status write here.
      //
      // The cache-bypass-on-degraded branch earlier in this handler
      // (Codex P1 on #311) is KEPT because production sessions persisted
      // before this change may still carry `feedback.degraded === true`
      // in Mongo; their user-triggered retries must still escape the
      // cache hit.
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
        degraded: true,
      }
      if (body.sessionId) {
        // G.1 telemetry — still captured so production visibility into
        // how often the outer-catch path fires is preserved. Telemetry
        // lives in its own collection, not on `InterviewSession.feedback`.
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
    } finally {
      // G.6 Phase A — always release so a concurrent retry isn't
      // blocked for the full TTL. The release is a no-op when we
      // didn't actually acquire (Redis error / no sessionId).
      if (feedbackLock) {
        await releaseFeedbackLock(feedbackLock)
      }
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
