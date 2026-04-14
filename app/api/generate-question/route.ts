import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { GenerateQuestionSchema } from '@interview/validators/interview'
import { trackUsage } from '@shared/services/usageTracking'
import { aiLogger } from '@shared/logger'
import { getPressureQuestionIndex, getQuestionCount, getDomainLabel } from '@interview/config/interviewConfig'
import { getSkillSections, selectSkillQuestions } from '@interview/services/core/skillLoader'
import { findCompanyProfile, buildCompanyPromptContext } from '@interview/config/companyProfiles'
import { connectDB } from '@shared/db/connection'
import { User, InterviewDomain, InterviewDepth } from '@shared/db/models'
import { FALLBACK_DOMAINS, FALLBACK_DEPTHS } from '@shared/db/seed'
import { isFeatureEnabled } from '@shared/featureFlags'
import { generateSessionBrief, briefToPromptContext } from '@interview/services/persona/personalizationEngine'
import { getQuestionBankContext } from '@interview/services/persona/retrievalService'
import { getOrLoadJDContext, getOrLoadResumeContext } from '@interview/services/persona/documentContextCache'
import { getOrLoadSessionConfig } from '@interview/services/core/sessionConfigCache'
import { z } from 'zod'
import { completion } from '@shared/services/modelRouter'
import { DATA_BOUNDARY_RULE } from '@shared/services/promptSecurity'
import { resolveFlow, buildFlowPromptContext } from '@interview/flow'
import type { ResolvedFlow } from '@interview/flow'

export const dynamic = 'force-dynamic'

type GenerateQuestionBody = z.infer<typeof GenerateQuestionSchema>

export const POST = composeApiRoute<GenerateQuestionBody>({
  schema: GenerateQuestionSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 15, keyPrefix: 'rl:gen-q' },

  async handler(req, { user, body }) {
    const { config, questionIndex, previousQA, performanceSignal, lastThreadSummary, completedThreads, sessionId } = body
    const startTime = Date.now()
    const interviewType = config.interviewType || 'behavioral'

    const totalQuestions = getQuestionCount(config.duration)
    const isLastQuestion = questionIndex === totalQuestions - 1

    // TN3: Progressive pressure escalation for strong candidates
    // Instead of a single binary "pressure question", escalate gradually:
    //  - 'normal': default tone
    //  - 'elevated': after Q3 for strong performers — skeptical probes, devil's advocate
    //  - 'high': after Q6 for strong performers — direct challenges, ethical dilemmas
    let pressureLevel: 'normal' | 'elevated' | 'high' = 'normal'
    if (performanceSignal === 'strong' && questionIndex >= 6) {
      pressureLevel = 'high'
    } else if (performanceSignal === 'strong' && questionIndex >= 3) {
      pressureLevel = 'elevated'
    }

    // previousQA is now passed via contextData for TOON encoding

    // Note: qaContext contains user-provided answers which are wrapped
    // in <prior_conversation> tags in the prompt to prevent injection

    // Build context from JD and resume — wrapped in XML tags to prevent prompt injection.
    // Prefers the Document Intelligence Layer (importance-ranked structured context)
    // when available; falls back to raw .slice() so legacy sessions and parse
    // failures still produce a valid prompt.
    let contextBlock = ''
    if (config.jobDescription) {
      const jdCtx = sessionId ? await getOrLoadJDContext(sessionId, config.jobDescription) : null
      contextBlock += jdCtx
        ? `\n\n<job_description_analysis>\n${jdCtx}\n</job_description_analysis>\nPRIORITY: The job description above defines the requirements this interview MUST assess. At least 60% of your questions should directly probe must-have requirements from the JD. Ask about specific skills, experiences, and qualifications listed in the JD. Use the resume to find evidence for or against JD requirements — not as the primary source of question topics.`
        : `\n\n<job_description>\n${config.jobDescription.slice(0, 2500)}\n</job_description>\nPRIORITY: The job description above defines the requirements this interview MUST assess. At least 60% of your questions should directly probe skills, qualifications, and responsibilities listed in the JD. Use the candidate's resume as evidence for or against JD requirements — not as the primary source of topics.`
    }
    // Track employer names from structured resume for employer-rotation prompt (Issue #5)
    let employerNames: string[] = []
    if (config.resumeText) {
      const resumeCtx = sessionId ? await getOrLoadResumeContext(sessionId, config.resumeText, config.role) : null
      contextBlock += resumeCtx
        ? `\n\n<candidate_resume_analysis>\n${resumeCtx}\n</candidate_resume_analysis>\nProbe the highlighted experiences. Ask for concrete details and metrics.`
        : `\n\n<candidate_resume>\n${config.resumeText.slice(0, 2500)}\n</candidate_resume>\nProbe specific experiences, projects, and claims from the resume above. Ask for concrete details.`

      // Extract employer companies from the structured resume context string.
      // The format is "Title @ Company (dates)" per buildParsedResumeContext.
      // This avoids a duplicate Mongo query — getOrLoadResumeContext already
      // hit the DB for parsedResume; we parse the output instead.
      if (resumeCtx) {
        // matchAll returns an iterator — use a while loop to avoid
        // downlevelIteration issues with the TS target.
        const companyRe = /^\s+-\s+.+?\s+@\s+(.+?)(?:\s+\(|$)/gm
        let companyMatch: RegExpExecArray | null
        while ((companyMatch = companyRe.exec(resumeCtx)) !== null) {
          if (companyMatch[1]) employerNames.push(companyMatch[1].trim())
        }
      }
    }
    if (config.jobDescription && config.resumeText) {
      contextBlock += `\n\nCROSS-REFERENCE STRATEGY: Map the candidate's resume experiences to JD requirements. Prioritize probing gaps — areas where the JD requires something the resume doesn't clearly demonstrate. When the resume DOES match a JD requirement, ask for specific evidence, metrics, and depth. Your questions should systematically cover JD requirements, using the resume as a lens to assess fit.`
    }

    // Pre-fetch session config (domain, depth, user profile) from Redis cache.
    // Falls through to per-query Mongo fetches below when sessionId is absent
    // or a cache field is null.
    const sessionCfg = sessionId
      ? await getOrLoadSessionConfig(sessionId, {
          role: config.role,
          interviewType,
          userId: user.id,
          experience: config.experience,
        }).catch(() => null)
      : null

    // Fetch domain and depth config — cache-first, Mongo fallback
    let domainContext = ''
    let depthStrategy = ''
    let domainLabel = getDomainLabel(config.role)

    try {
      await connectDB()

      const [domainDoc, depthDoc] = await Promise.all([
        sessionCfg?.domain != null
          ? Promise.resolve(sessionCfg.domain)
          : InterviewDomain.findOne({ slug: config.role, isActive: true }).lean(),
        sessionCfg?.depth != null
          ? Promise.resolve(sessionCfg.depth)
          : InterviewDepth.findOne({ slug: interviewType, isActive: true }).lean(),
      ]) as [
        { label?: string; systemPromptContext?: string } | null,
        { questionStrategy?: string } | null,
      ]

      if (domainDoc) {
        domainLabel = domainDoc.label ?? domainLabel
        domainContext = domainDoc.systemPromptContext ? `\n\nDOMAIN CONTEXT: ${domainDoc.systemPromptContext}` : ''
      } else {
        const fallback = FALLBACK_DOMAINS.find(d => d.slug === config.role)
        if (fallback) {
          domainLabel = fallback.label
          domainContext = fallback.systemPromptContext ? `\n\nDOMAIN CONTEXT: ${fallback.systemPromptContext}` : ''
        }
      }

      if (depthDoc) {

        depthStrategy = depthDoc.questionStrategy ? `\n\nQUESTION STRATEGY: ${depthDoc.questionStrategy}` : ''
      } else {
        const fallback = FALLBACK_DEPTHS.find(d => d.slug === interviewType)
        if (fallback) {

          depthStrategy = fallback.questionStrategy ? `\n\nQUESTION STRATEGY: ${fallback.questionStrategy}` : ''
        }
      }
    } catch {
      const fallbackDomain = FALLBACK_DOMAINS.find(d => d.slug === config.role)
      const fallbackDepth = FALLBACK_DEPTHS.find(d => d.slug === interviewType)
      if (fallbackDomain) {
        domainLabel = fallbackDomain.label
        domainContext = fallbackDomain.systemPromptContext ? `\n\nDOMAIN CONTEXT: ${fallbackDomain.systemPromptContext}` : ''
      }
      if (fallbackDepth) {

        depthStrategy = fallbackDepth.questionStrategy ? `\n\nQUESTION STRATEGY: ${fallbackDepth.questionStrategy}` : ''
      }
    }

    // Inject domain:depth skill file context (replaces fragmented TS overrides)
    try {
      const skillContext = await getSkillSections(config.role, interviewType, [
        'question-strategy', 'depth-meaning', 'anti-patterns', 'experience-calibration',
      ])
      if (skillContext) {
        depthStrategy = '\n\n' + skillContext
      }

      // Experience-aware question inspiration from skill file (randomized per session)
      if (questionIndex <= 3) {
        const inspiration = await selectSkillQuestions(config.role, interviewType, config.experience)
        if (inspiration) {
          depthStrategy += `\n\nQUESTION INSPIRATION (adapt to context, don't copy verbatim):\n${inspiration}`
        }
      }
    } catch { /* skill file unavailable — continue with DB depth strategy */ }

    // ── Flow Template Resolution ──────────────────────────────────────────
    // Research-backed topic sequencing: resolves a structured flow plan for
    // this domain × depth × experience combination. When available, injects
    // per-slot guidance into the system prompt so the AI follows a specific
    // topic playbook instead of relying solely on the generic diversity nudge.
    let resolvedFlow: ResolvedFlow | null = null
    let flowPromptBlock = ''
    if (isFeatureEnabled('interview_flow_templates')) {
      try {
        resolvedFlow = resolveFlow({
          domain: config.role,
          depth: interviewType,
          experience: config.experience,
          duration: config.duration,
        })
        if (resolvedFlow) {
          // Current slot index = number of completed threads (each thread = one slot)
          const currentSlotIndex = completedThreads?.length ?? 0
          const flowCtx = buildFlowPromptContext({
            flow: resolvedFlow,
            currentSlotIndex,
            completedThreads: completedThreads ?? [],
            performanceSignal: performanceSignal || 'calibrating',
          })
          flowPromptBlock = flowCtx.promptBlock ? `\n\n${flowCtx.promptBlock}` : ''
        }
      } catch (err) {
        aiLogger.debug({ err }, 'Flow template resolution failed — continuing without flow')
      }
    }

    // Build company/industry context block
    let companyBlock = ''
    if (config.targetCompany) {
      const companyProfile = findCompanyProfile(config.targetCompany)
      if (companyProfile) {
        companyBlock += buildCompanyPromptContext(companyProfile)
      } else {
        companyBlock += `\nThe candidate is preparing for an interview at ${config.targetCompany}.`
        companyBlock += ` Adapt question style, difficulty calibration, and cultural expectations to match this company's known interview approach and values.`
      }
    }
    if (config.targetIndustry) {
      companyBlock += `\nThe role is in the ${config.targetIndustry} industry. Use industry-relevant scenarios, terminology, and domain examples.`
    }

    // Build profile context from onboarding data + extended profile
    let profileBlock = ''
    try {
      await connectDB()
      // Use cached user profile when available; fall back to Mongo.
      const profile = (sessionCfg?.userProfile != null
        ? sessionCfg.userProfile
        : await User.findById(user.id).select(
            'currentTitle currentIndustry isCareerSwitcher switchingFrom targetCompanyType weakAreas ' +
            'topSkills educationLevel yearsInCurrentRole communicationStyle ' +
            'targetCompanies practiceStats interviewGoal',
          ).lean()) as {
        currentTitle?: string
        currentIndustry?: string
        isCareerSwitcher?: boolean
        switchingFrom?: string
        targetCompanyType?: string
        weakAreas?: string[]
        topSkills?: string[]
        educationLevel?: string
        yearsInCurrentRole?: number
        communicationStyle?: string
        targetCompanies?: string[]
        practiceStats?: Record<string, { totalSessions?: number; avgScore?: number; weakDimensions?: string[] }>
        interviewGoal?: string
      } | null
      if (profile?.currentTitle) {
        profileBlock += `\nThe candidate's current title is: ${profile.currentTitle}.`
      }
      if (profile?.currentIndustry) {
        profileBlock += ` They work in the ${profile.currentIndustry} industry.`
      }
      if (profile?.yearsInCurrentRole) {
        profileBlock += ` They have been in their current role for ${profile.yearsInCurrentRole} years.`
      }
      if (profile?.isCareerSwitcher && profile?.switchingFrom) {
        profileBlock += `\nIMPORTANT: This candidate is making a career transition from ${profile.switchingFrom} to ${config.role}. Focus on transferable skills and probe how their background applies to the new role.`
      }
      if (profile?.targetCompanyType && profile.targetCompanyType !== 'any') {
        profileBlock += `\nThey are targeting ${profile.targetCompanyType} companies — calibrate question depth and formality accordingly.`
      }
      if (profile?.targetCompanies?.length) {
        profileBlock += `\nSpecific target companies: ${profile.targetCompanies.join(', ')}. Tailor questions to the culture and interview style of these companies.`
      }
      if (profile?.weakAreas?.length) {
        profileBlock += `\nThe candidate wants to improve: ${profile.weakAreas.join(', ')}. Naturally weave in questions that test these areas.`
      }
      if (profile?.topSkills?.length) {
        profileBlock += `\nCandidate's top skills: ${profile.topSkills.join(', ')}. Probe these to validate depth.`
      }
      if (profile?.communicationStyle) {
        const styleGuide: Record<string, string> = {
          concise: 'The candidate prefers concise communication — ask focused, direct questions.',
          detailed: 'The candidate is detail-oriented — feel free to ask multi-part questions.',
          storyteller: 'The candidate is a storyteller — ask open-ended questions that invite narratives.',
        }
        profileBlock += `\n${styleGuide[profile.communicationStyle] || ''}`
      }
      // Check practice history for this domain+type combo
      const practiceKey = `${config.role}:${interviewType}`
      const stats = (profile?.practiceStats as Record<string, { totalSessions?: number; avgScore?: number; weakDimensions?: string[] }> | undefined)?.[practiceKey]
      if (stats?.totalSessions && stats.totalSessions > 0) {
        profileBlock += `\nThis candidate has done ${stats.totalSessions} practice sessions for this combination (avg score: ${stats.avgScore || 'N/A'}).`
        if (stats.weakDimensions?.length) {
          profileBlock += ` Weak dimensions: ${stats.weakDimensions.join(', ')}. Test these specifically.`
        }
        profileBlock += ` Avoid repeating common questions — challenge with novel scenarios.`
      }
      if (profile?.interviewGoal) {
        const goalContext: Record<string, string> = {
          first_interview: 'First-time interview preparer — start foundational, build complexity.',
          improve_scores: 'Actively improving — push with progressively harder questions.',
          career_switch: 'Career switcher — ask about adaptability and transferable skills.',
          promotion: 'Promotion prep — focus on leadership and strategic thinking.',
          general_practice: 'General practice — vary question types for breadth.',
        }
        profileBlock += `\n${goalContext[profile.interviewGoal] || ''}`
      }
    } catch { /* profile fetch failed — continue without it */ }

    // Personalization Engine: generate session brief for enhanced context
    let personalizationBlock = ''
    let ragBlock = ''
    if (isFeatureEnabled('personalization_engine') && questionIndex <= 1) {
      try {
        const brief = await generateSessionBrief({
          userId: user.id,
          domain: config.role,
          interviewType,
          experience: config.experience,
          jobDescription: config.jobDescription,
          resumeText: config.resumeText,
        })
        personalizationBlock = `\n\n${briefToPromptContext(brief)}`
      } catch { /* personalization failed — continue without it */ }
    }

    // RAG: question bank context for inspiration
    if (isFeatureEnabled('question_bank_rag') && questionIndex <= 1) {
      try {
        ragBlock = await getQuestionBankContext({
          domain: config.role,
          interviewType,
          difficulty: config.experience === '7+' ? 'hard' : config.experience === '3-6' ? 'medium' : 'easy',
        })
        if (ragBlock) ragBlock = `\n\n${ragBlock}`
      } catch { /* RAG failed — continue without it */ }
    }

    // Build base prompt — interview-type-aware with format-specific instructions
    const typeLabels: Record<string, string> = {
      screening: 'HR screening interview',
      behavioral: 'behavioral deep-dive interview',
      technical: 'technical interview',
      'case-study': 'case study session',
    }
    const roleLabels: Record<string, string> = {
      screening: 'senior recruiter',
      behavioral: 'senior hiring manager focused on behavioral assessment',
      technical: 'technical interview lead',
      'case-study': 'strategy and case assessment lead',
    }
    // Type-specific format instructions ensure fundamentally different question styles
    const typeInstructions: Record<string, string> = {
      screening: 'Ask about motivation, culture fit, career trajectory, and basic competencies. Mix behavioral (STAR) and situational questions.',
      behavioral: 'Ask exclusively about PAST experiences using behavioral prompts ("Tell me about a time when...", "Describe a situation where..."). Every question must probe a real event the candidate lived through. Never ask hypothetical scenarios.',
      technical: 'Ask domain-specific technical questions that test depth of knowledge, problem-solving approach, and system thinking. Include trade-off analysis.',
      'case-study': 'Present a realistic SCENARIO or business problem for the candidate to solve. Frame it as a case: "Imagine you are the PM for X. How would you approach Y?" Guide them through framework → analysis → recommendation. Never ask about past experiences — every question must be a forward-looking scenario.',
    }
    const basePrompt = `You are Alex Chen, a ${roleLabels[interviewType] || 'senior interviewer'}. You are conducting a ${config.duration}-minute ${typeLabels[interviewType] || interviewType + ' interview'} for a ${domainLabel} role (${config.experience} years experience).

QUESTION FORMAT: ${typeInstructions[interviewType] || 'Ask one focused question at a time.'}`

    const defaultStrategy = ''

    // Dynamic transition phrases (reference previous topic when available)
    let transitionBlock = ''
    if (lastThreadSummary && questionIndex > 0) {
      transitionBlock = `\n\nTRANSITION: The candidate just finished discussing "${lastThreadSummary.topicQuestion}".
Start your next question with a brief, natural reference to something from their previous answer (1 sentence max), then bridge to your new question. The transition + question should feel like one continuous thought.
Example: "Your approach to stakeholder alignment was really thoughtful. I'd like to explore a different kind of challenge — tell me about a time you had to make a difficult decision with incomplete information."
Do NOT use generic transitions like "Great, next question..." or "Moving on...". Reference something SPECIFIC from the previous answer.`
    }

    // Thread-aware context (avoid repeating topics, enable cross-references)
    let threadContext = ''
    if (completedThreads?.length) {
      const summaries = completedThreads.map((t, i) =>
        `Topic ${i + 1}: "${t.topicQuestion}" (avg score: ${t.avgScore}, probes: ${t.probeCount})`
      ).join('\n')
      // Detect topic diversity — nudge the interviewer to explore uncovered areas
      const topicCount = completedThreads.length
      const diversityNote = topicCount >= 3
        ? `\nIMPORTANT: You have already covered ${topicCount} topics. Ensure your next question explores a DIFFERENT competency area (e.g., if past questions focused on leadership and stakeholder management, now ask about technical depth, failure handling, data-driven decisions, or innovation). Variety across competencies is critical for a thorough assessment.`
        : ''
      const jdCoverageNote = config.jobDescription
        ? `\n\nJD COVERAGE CHECK: Review the JD requirements above. Identify which requirements have NOT yet been assessed by the topics already covered. Your next question MUST target an uncovered JD requirement.`
        : ''
      threadContext = `\n\nTOPICS ALREADY COVERED:\n${summaries}\n\nDo NOT repeat these topics.${diversityNote}${jdCoverageNote} You MAY occasionally reference a pattern across topics when a genuine link exists. Use cross-references sparingly.`

      // Employer rotation — prevent fixating on a single company (Issue #5).
      // When we have structured employer names, instruct the AI to distribute
      // questions across the candidate's work history.
      if (employerNames.length > 1) {
        // Best-effort: check which companies appear in already-covered topics
        const coveredCompanies = completedThreads
          .map(t => {
            // Check explicit company field first, fall back to text matching
            if (t.company) return t.company
            const lower = (t.topicQuestion + ' ' + t.summary).toLowerCase()
            return employerNames.find(c => lower.includes(c.toLowerCase()))
          })
          .filter(Boolean) as string[]
        const uniqueCovered = Array.from(new Set(coveredCompanies))
        const uncovered = employerNames.filter(
          c => !uniqueCovered.some(uc => uc.toLowerCase() === c.toLowerCase())
        )

        if (uncovered.length > 0) {
          threadContext += `\n\nEMPLOYER DIVERSITY: The candidate has worked at: ${employerNames.join(', ')}. Previous questions covered: ${uniqueCovered.join(', ') || 'none specifically'}. You MUST ask about a DIFFERENT employer next. Focus your next question on the candidate's experience at ${uncovered.slice(0, 2).join(' or ')}. Do NOT ask another question about ${uniqueCovered[uniqueCovered.length - 1] || employerNames[0]}.`
        } else {
          threadContext += `\n\nEMPLOYER DIVERSITY: The candidate has worked at: ${employerNames.join(', ')}. Distribute questions across different employers — do not ask more than ${Math.ceil(totalQuestions / employerNames.length)} questions about the same company.`
        }
      }
    }

    // ── Explicit answer recall (C1) — cross-reference earlier answers ──
    // Real interviewers remember what candidates said and build on it.
    // Extract key points from recent threads so the LLM can reference them naturally.
    let recallContext = ''
    if (completedThreads?.length && completedThreads.length >= 2) {
      const recallPoints = completedThreads.slice(-4).map((t, i) =>
        `Q${i + 1}: "${t.topicQuestion.slice(0, 80)}" → Key takeaway: "${t.summary.slice(0, 120)}"`
      ).join('\n')
      recallContext = `\n\nCANDIDATE'S PREVIOUS ANSWERS (use for continuity and cross-referencing):
${recallPoints}

When relevant, reference what the candidate said earlier with natural transitions like:
- "You mentioned [X] earlier — building on that..."
- "Coming back to what you said about [Y]..."
- "That connects to something you shared earlier about [Z]..."
Do this only when a genuine link exists (roughly 1 in 3 questions). Do NOT force cross-references.`
    }

    // Progressive difficulty guidance based on candidate performance
    const difficultyGuidance: Record<string, string> = {
      calibrating: '',
      struggling: '\nCANDIDATE PERFORMANCE: The candidate is finding this challenging. Use more structured questions with clearer framing. Don\'t reduce quality expectations, but make questions more approachable.',
      on_track: '\nCANDIDATE PERFORMANCE: The candidate is performing at expected level. Maintain current difficulty.',
      strong: '\nCANDIDATE PERFORMANCE: The candidate is performing well. Increase difficulty: ask about edge cases, ethical dilemmas, cross-functional conflicts, or "what would you do differently" scenarios. Challenge their thinking.',
    }
    const difficultyBlock = difficultyGuidance[performanceSignal || 'calibrating'] || ''

    // Interviewer persona from skill file
    let personaBlock = ''
    try {
      const personaContent = await getSkillSections(config.role, interviewType, ['interviewer-persona'])
      if (personaContent) personaBlock = `\n\nINTERVIEWER PERSONA: ${personaContent}`
    } catch { /* skill file unavailable — continue without persona */ }

    // Split system prompt into static (cacheable) and dynamic (per-turn) parts.
    // The static part is byte-identical across turns in the same interview,
    // allowing Anthropic's prompt caching to reuse the KV-cache and cut TTFT.
    const staticSystemPrompt = `${basePrompt}

Your interview style is warm but professional. You ask ONE focused question at a time. Questions should feel conversational and natural — not robotic or overly formal.${depthStrategy || defaultStrategy}${domainContext}${personaBlock}${companyBlock}${contextBlock}${profileBlock}${personalizationBlock}${ragBlock}

${DATA_BOUNDARY_RULE}`

    // Dynamic context changes every turn — not cached
    const dynamicSystemPrompt = `${difficultyBlock}${transitionBlock}${threadContext}${recallContext}${flowPromptBlock}`

    // F5: Curveball injection — once per session after Q3
    // Uses a hash of session-unique data for deterministic slot selection.
    // Falls back to config-based seed when sessionId is unavailable (client doesn't always pass it).
    const seedSource = body.sessionId || `${config.role}:${config.duration}:${config.experience}:${user.id}`
    const sessionSeed = seedSource.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
    const curveballEligible = questionIndex >= 3 && !isLastQuestion && pressureLevel === 'normal'
    const curveballSlot = (sessionSeed % 7) + 3 // deterministic slot between Q3-Q9
    const isCurveball = curveballEligible && questionIndex === curveballSlot

    // TN3: Progressive pressure instructions
    const pressureInstructions: Record<string, string> = {
      normal: '',
      elevated: '⚠️ PRESSURE LEVEL: ELEVATED. The candidate is performing well. Ask a skeptical or devil\'s advocate question that tests their reasoning under pressure. Challenge an assumption from their previous answer, or present a "what if" scenario that complicates their approach. Stay professional but push them.',
      high: '⚠️ PRESSURE LEVEL: HIGH. The candidate is excelling. Ask a direct challenge: an ethical dilemma, a cross-functional conflict scenario, a "convince me you\'re wrong" question, or a question that forces them to defend a difficult trade-off. Be respectful but don\'t go easy.',
    }

    const userPrompt = `Generate question ${questionIndex + 1} of ${totalQuestions}.
${pressureInstructions[pressureLevel]}
${isCurveball ? '🎯 CURVEBALL: Ask an unexpected question that tests composure and adaptability. Examples: a left-field hypothetical ("If you had unlimited budget but only 2 weeks..."), a deliberately ambiguous scenario, or a question that forces creative thinking outside the candidate\'s comfort zone. Keep it relevant to the domain but surprising in angle.' : ''}
${isLastQuestion ? 'This is the FINAL substantive question before wrap-up — make it memorable and forward-looking.' : ''}

Return ONLY the question text. No preamble, no numbering, no quotation marks. Just the question.`

    // Build contextData — previousQA is a uniform array that grows each turn
    // (biggest TOON savings target). completedThreads is also uniform.
    const contextData: Record<string, unknown> = {}
    if (previousQA.length > 0) {
      contextData.priorConversation = previousQA.map((e) => ({
        speaker: e.speaker === 'interviewer' ? 'Interviewer' : 'Candidate',
        text: e.text,
      }))
    }
    if (completedThreads?.length) {
      contextData.completedThreads = completedThreads.map((t, i) => ({
        topic: i + 1,
        question: t.topicQuestion,
        avgScore: t.avgScore,
        probes: t.probeCount,
        ...(t.company ? { company: t.company } : {}),
      }))
    }

    try {
      const fullSystem = dynamicSystemPrompt.trim()
        ? `${staticSystemPrompt}\n\n${dynamicSystemPrompt}`
        : staticSystemPrompt

      const result = await completion({
        taskSlot: 'interview.generate-question',
        system: fullSystem,
        messages: [{ role: 'user', content: userPrompt }],
        contextData,
      })

      trackUsage({
        user,
        type: 'api_call_question',
        sessionId: body.sessionId,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        modelUsed: result.model,
        durationMs: Date.now() - startTime,
        success: true,
      }).catch((err) => aiLogger.warn({ err }, 'Usage tracking failed'))

      return NextResponse.json({ question: result.text })
    } catch (err) {
      aiLogger.error({ err }, 'LLM API error in generate-question')

      trackUsage({
        user,
        type: 'api_call_question',
        sessionId: body.sessionId,
        inputTokens: 0,
        outputTokens: 0,
        modelUsed: 'unknown',
        durationMs: Date.now() - startTime,
        success: false,
        errorMessage: err instanceof Error ? err.message : 'Unknown error',
      }).catch((err) => aiLogger.warn({ err }, 'Usage tracking failed'))

      return NextResponse.json(
        {
          question:
            'Tell me about a challenge you faced in your most recent role and how you overcame it.',
          isFallback: true,
          error: 'question_generation_failed',
        },
        { status: 503 },
      )
    }
  },
})
