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
import { z } from 'zod'
import { completion } from '@shared/services/modelRouter'
import { DATA_BOUNDARY_RULE } from '@shared/services/promptSecurity'

export const dynamic = 'force-dynamic'

type GenerateQuestionBody = z.infer<typeof GenerateQuestionSchema>

export const POST = composeApiRoute<GenerateQuestionBody>({
  schema: GenerateQuestionSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 15, keyPrefix: 'rl:gen-q' },

  async handler(req, { user, body }) {
    const { config, questionIndex, previousQA, performanceSignal, lastThreadSummary, completedThreads } = body
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

    // Build context from JD and resume — wrapped in XML tags to prevent prompt injection
    let contextBlock = ''
    if (config.jobDescription) {
      contextBlock += `\n\n<job_description>\n${config.jobDescription.slice(0, 2500)}\n</job_description>\nUse the job description above to ask targeted questions that probe the candidate's fit for the specific requirements listed.`
    }
    if (config.resumeText) {
      contextBlock += `\n\n<candidate_resume>\n${config.resumeText.slice(0, 2500)}\n</candidate_resume>\nProbe specific experiences, projects, and claims from the resume above. Ask for concrete details.`
    }
    if (config.jobDescription && config.resumeText) {
      contextBlock += `\n\nCross-reference the resume against the JD requirements. Identify gaps or areas where the candidate's experience may not fully match, and explore those.`
    }

    // Fetch domain and depth config from DB (with fallback)
    let domainContext = ''
    let depthStrategy = ''
    let domainLabel = getDomainLabel(config.role)

    try {
      await connectDB()

      const [domainDoc, depthDoc] = await Promise.all([
        InterviewDomain.findOne({ slug: config.role, isActive: true }).lean(),
        InterviewDepth.findOne({ slug: interviewType, isActive: true }).lean(),
      ])

      if (domainDoc) {
        domainLabel = domainDoc.label
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
      const profile = await User.findById(user.id).select(
        'currentTitle currentIndustry isCareerSwitcher switchingFrom targetCompanyType weakAreas ' +
        'topSkills educationLevel yearsInCurrentRole communicationStyle ' +
        'targetCompanies practiceStats interviewGoal'
      ).lean()
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
      threadContext = `\n\nTOPICS ALREADY COVERED:\n${summaries}\n\nDo NOT repeat these topics.${diversityNote} You MAY occasionally reference a pattern across topics when a genuine link exists. Use cross-references sparingly.`
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
    const dynamicSystemPrompt = `${difficultyBlock}${transitionBlock}${threadContext}${recallContext}`

    // F5: Curveball injection — ~15% chance after Q3, once per session
    // Uses a hash of sessionId to ensure deterministic "once per session" behavior
    const sessionSeed = (body.sessionId || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0)
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

      return NextResponse.json({
        question:
          'Tell me about a challenge you faced in your most recent role and how you overcame it.',
      })
    }
  },
})
