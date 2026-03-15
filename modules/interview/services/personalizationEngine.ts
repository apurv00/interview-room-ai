import { connectDB } from '@shared/db/connection'
import { User, InterviewDomain, InterviewDepth, InterviewerPersona } from '@shared/db/models'
import { isFeatureEnabled } from '@shared/featureFlags'
import { getUserCompetencySummary } from '@learn/services/competencyService'
import { getUserWeaknesses } from '@learn/services/competencyService'
import { buildHistorySummary, getRecentSummaries } from '@learn/services/sessionSummaryService'
import { getCompanyContext } from './retrievalService'
import { buildParsedJDContext } from './jdParserService'
import type { IParsedJobDescription } from '@shared/db/models/SavedJobDescription'
import { logger } from '@shared/logger'

// ─── Session Brief ──────────────────────────────────────────────────────────

export interface SessionBrief {
  userId: string
  domain: string
  interviewType: string
  experience: string

  // Personalization
  sessionGoal: string
  recommendedDifficulty: 'easy' | 'medium' | 'medium_high' | 'hard'
  focusCompetencies: string[]
  avoidRepeatingTopics: string[]
  resumeAnchorPoints: string[]
  knownWeaknesses: Array<{ name: string; description: string }>
  knownStrengths: string[]
  interviewerBehavior: string

  // Persona
  personaName: string
  personaPromptFragment: string

  // Parsed JD context
  parsedJDContext: string

  // Context blocks for prompt injection
  profileContext: string
  historyContext: string
  companyContext: string
  competencyContext: string
}

interface SessionBriefInput {
  userId: string
  domain: string
  interviewType: string
  experience: string
  jobDescription?: string
  resumeText?: string
  persona?: string
  parsedJobDescription?: IParsedJobDescription
}

// ─── Generate Session Brief ─────────────────────────────────────────────────

export async function generateSessionBrief(input: SessionBriefInput): Promise<SessionBrief> {
  if (!isFeatureEnabled('personalization_engine')) {
    return createDefaultBrief(input)
  }

  try {
    await connectDB()

    const { userId, domain, interviewType, experience } = input

    // Parallel fetch all context
    const [profile, competencySummary, weaknesses, recentSummaries, historySummary, companyCtx, persona] =
      await Promise.all([
        User.findById(userId).select(
          'currentTitle currentIndustry isCareerSwitcher switchingFrom targetCompanyType ' +
          'weakAreas topSkills communicationStyle feedbackPreference targetCompanies ' +
          'practiceStats interviewGoal yearsInCurrentRole resumeText'
        ).lean(),
        getUserCompetencySummary(userId, domain),
        getUserWeaknesses(userId),
        getRecentSummaries(userId, domain, 3),
        buildHistorySummary(userId, domain),
        getCompanyContext(input),
        input.persona
          ? InterviewerPersona.findOne({ slug: input.persona, isActive: true }).lean()
          : InterviewerPersona.findOne({ isDefault: true, isActive: true }).lean(),
      ])

    // Determine session goal
    const profileRecord = profile as Record<string, unknown> | null
    const sessionGoal = determineSessionGoal(profileRecord, competencySummary, weaknesses)

    // Determine difficulty
    const recommendedDifficulty = determineDifficulty(experience, competencySummary, recentSummaries)

    // Focus competencies: weakest ones that need work
    const focusCompetencies = determineFocusCompetencies(competencySummary, weaknesses, domain)

    // Topics to avoid repeating
    const avoidRepeatingTopics = recentSummaries
      .flatMap(s => s.topicsCovered)
      .filter(Boolean)
      .slice(0, 10)

    // Resume anchor points
    const resumeAnchorPoints = extractResumeAnchors(input.resumeText || profile?.resumeText)

    // Known weaknesses
    const knownWeaknesses = weaknesses.map(w => ({ name: w.name, description: w.description }))

    // Known strengths
    const knownStrengths = competencySummary?.strongAreas || []

    // Interviewer behavior directive
    const interviewerBehavior = determineInterviewerBehavior(weaknesses, competencySummary, profileRecord)

    // Build context blocks
    const profileContext = buildProfileContext(profileRecord, input)
    const competencyContext = buildCompetencyContext(competencySummary)

    // Persona context
    const personaName = persona?.name || 'Alex Chen'
    const personaPromptFragment = persona?.systemPromptFragment || ''

    // Parsed JD context
    const parsedJDContext = input.parsedJobDescription
      ? buildParsedJDContext(input.parsedJobDescription)
      : ''

    return {
      userId,
      domain,
      interviewType,
      experience,
      sessionGoal,
      recommendedDifficulty,
      focusCompetencies,
      avoidRepeatingTopics,
      resumeAnchorPoints,
      knownWeaknesses,
      knownStrengths,
      interviewerBehavior,
      personaName,
      personaPromptFragment,
      parsedJDContext,
      profileContext,
      historyContext: historySummary,
      companyContext: companyCtx,
      competencyContext,
    }
  } catch (err) {
    logger.error({ err }, 'Failed to generate session brief')
    return createDefaultBrief(input)
  }
}

// ─── Compact Brief for Prompt ────────────────────────────────────────────────

export function briefToPromptContext(brief: SessionBrief): string {
  const sections: string[] = []

  if (brief.sessionGoal) {
    sections.push(`SESSION GOAL: ${brief.sessionGoal}`)
  }

  if (brief.focusCompetencies.length > 0) {
    sections.push(`FOCUS COMPETENCIES: ${brief.focusCompetencies.join(', ')}`)
  }

  if (brief.recommendedDifficulty) {
    sections.push(`DIFFICULTY LEVEL: ${brief.recommendedDifficulty}`)
  }

  if (brief.knownWeaknesses.length > 0) {
    sections.push(`KNOWN WEAKNESSES: ${brief.knownWeaknesses.map(w => w.name).join(', ')}. Probe these areas.`)
  }

  if (brief.knownStrengths.length > 0) {
    sections.push(`STRENGTHS: ${brief.knownStrengths.join(', ')}. Validate depth.`)
  }

  if (brief.avoidRepeatingTopics.length > 0) {
    sections.push(`AVOID REPEATING: ${brief.avoidRepeatingTopics.join(', ')}`)
  }

  if (brief.resumeAnchorPoints.length > 0) {
    sections.push(`RESUME ANCHORS: ${brief.resumeAnchorPoints.join(', ')}. Reference in follow-ups.`)
  }

  if (brief.interviewerBehavior) {
    sections.push(`INTERVIEWER BEHAVIOR: ${brief.interviewerBehavior}`)
  }

  if (brief.personaPromptFragment) {
    sections.push(`PERSONA: Your name is ${brief.personaName}. ${brief.personaPromptFragment}`)
  }

  if (brief.parsedJDContext) {
    sections.push(brief.parsedJDContext)
  }

  if (brief.profileContext) {
    sections.push(brief.profileContext)
  }

  if (brief.historyContext) {
    sections.push(brief.historyContext)
  }

  if (brief.companyContext) {
    sections.push(brief.companyContext)
  }

  if (brief.competencyContext) {
    sections.push(brief.competencyContext)
  }

  return sections.join('\n\n')
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

function createDefaultBrief(input: SessionBriefInput): SessionBrief {
  return {
    userId: input.userId,
    domain: input.domain,
    interviewType: input.interviewType,
    experience: input.experience,
    sessionGoal: 'General interview practice',
    recommendedDifficulty: 'medium',
    focusCompetencies: [],
    avoidRepeatingTopics: [],
    resumeAnchorPoints: [],
    knownWeaknesses: [],
    knownStrengths: [],
    interviewerBehavior: 'balanced',
    personaName: 'Alex Chen',
    personaPromptFragment: '',
    parsedJDContext: '',
    profileContext: '',
    historyContext: '',
    companyContext: '',
    competencyContext: '',
  }
}

function determineSessionGoal(
  profile: Record<string, unknown> | null,
  competencySummary: Awaited<ReturnType<typeof getUserCompetencySummary>>,
  weaknesses: Awaited<ReturnType<typeof getUserWeaknesses>>
): string {
  if (!profile) return 'General interview practice'

  const goal = profile.interviewGoal as string | undefined

  if (competencySummary?.weakAreas?.length) {
    return `Improve ${competencySummary.weakAreas.slice(0, 2).join(' and ')}`
  }

  if (weaknesses.length > 0) {
    const critical = weaknesses.filter(w => w.severity === 'critical')
    if (critical.length > 0) {
      return `Address critical weakness: ${critical[0].name.replace(/_/g, ' ')}`
    }
  }

  const goalLabels: Record<string, string> = {
    first_interview: 'Build confidence for first interview',
    improve_scores: 'Push scores higher with harder challenges',
    career_switch: 'Bridge career transition gaps',
    promotion: 'Demonstrate leadership and strategic thinking',
    general_practice: 'Broad practice across competencies',
  }

  return goalLabels[goal || ''] || 'General interview practice'
}

function determineDifficulty(
  experience: string,
  competencySummary: Awaited<ReturnType<typeof getUserCompetencySummary>>,
  recentSummaries: Array<{ overallScore: number }>
): 'easy' | 'medium' | 'medium_high' | 'hard' {
  if (!isFeatureEnabled('adaptive_difficulty')) {
    return experience === '7+' ? 'medium_high' : 'medium'
  }

  // Base difficulty from experience
  let baseDifficulty = experience === '0-2' ? 1 : experience === '3-6' ? 2 : 3

  // Adjust based on recent performance
  if (recentSummaries.length >= 2) {
    const avgScore = recentSummaries.reduce((s, r) => s + r.overallScore, 0) / recentSummaries.length
    if (avgScore >= 80) baseDifficulty += 1
    else if (avgScore >= 70) baseDifficulty += 0.5
    else if (avgScore < 50) baseDifficulty -= 1
  }

  // Adjust based on overall readiness
  if (competencySummary?.overallReadiness) {
    if (competencySummary.overallReadiness >= 75) baseDifficulty += 0.5
    else if (competencySummary.overallReadiness < 40) baseDifficulty -= 0.5
  }

  // Map to difficulty level
  if (baseDifficulty <= 1) return 'easy'
  if (baseDifficulty <= 2) return 'medium'
  if (baseDifficulty <= 3) return 'medium_high'
  return 'hard'
}

function determineFocusCompetencies(
  competencySummary: Awaited<ReturnType<typeof getUserCompetencySummary>>,
  weaknesses: Awaited<ReturnType<typeof getUserWeaknesses>>,
  domain: string
): string[] {
  const focus: string[] = []

  // Weakest competencies first
  if (competencySummary?.weakAreas) {
    focus.push(...competencySummary.weakAreas.slice(0, 3))
  }

  // Weakness-linked competencies
  for (const w of weaknesses) {
    for (const c of w.linkedCompetencies) {
      if (!focus.includes(c)) focus.push(c)
    }
    if (focus.length >= 5) break
  }

  return focus.slice(0, 5)
}

function determineInterviewerBehavior(
  weaknesses: Awaited<ReturnType<typeof getUserWeaknesses>>,
  competencySummary: Awaited<ReturnType<typeof getUserCompetencySummary>>,
  profile: Record<string, unknown> | null
): string {
  const behaviors: string[] = []

  // Based on weaknesses
  const hasSpecificityIssue = weaknesses.some(w =>
    w.name.includes('generic') || w.name.includes('vague') || w.linkedCompetencies.includes('specificity')
  )
  if (hasSpecificityIssue) behaviors.push('probe_for_specificity')

  const hasStructureIssue = weaknesses.some(w =>
    w.linkedCompetencies.includes('structure')
  )
  if (hasStructureIssue) behaviors.push('prompt_for_structure')

  // Based on readiness
  if (competencySummary?.overallReadiness && competencySummary.overallReadiness < 40) {
    behaviors.push('supportive')
  } else if (competencySummary?.overallReadiness && competencySummary.overallReadiness >= 70) {
    behaviors.push('challenging')
  }

  // Based on user preference
  const feedbackPref = profile?.feedbackPreference as string | undefined
  if (feedbackPref === 'tough_love') behaviors.push('direct_and_challenging')
  if (feedbackPref === 'encouraging') behaviors.push('warm_and_supportive')

  return behaviors.join(', ') || 'balanced'
}

function buildProfileContext(
  profile: Record<string, unknown> | null,
  input: SessionBriefInput
): string {
  if (!profile) return ''

  const parts: string[] = []

  if (profile.currentTitle) {
    parts.push(`Current role: ${profile.currentTitle}${profile.currentIndustry ? ` in ${profile.currentIndustry}` : ''}`)
  }

  if (profile.isCareerSwitcher && profile.switchingFrom) {
    parts.push(`Career switcher from ${profile.switchingFrom} — weight transferable skills`)
  }

  if (profile.targetCompanyType && profile.targetCompanyType !== 'any') {
    parts.push(`Targeting ${profile.targetCompanyType} companies`)
  }

  const targetCompanies = profile.targetCompanies as string[] | undefined
  if (targetCompanies?.length) {
    parts.push(`Target companies: ${targetCompanies.join(', ')}`)
  }

  const topSkills = profile.topSkills as string[] | undefined
  if (topSkills?.length) {
    parts.push(`Top skills: ${topSkills.join(', ')}`)
  }

  if (profile.communicationStyle) {
    const styleMap: Record<string, string> = {
      concise: 'Prefers concise communication — ask focused questions',
      detailed: 'Detail-oriented — multi-part questions welcome',
      storyteller: 'Storyteller — ask open-ended questions',
    }
    parts.push(styleMap[profile.communicationStyle as string] || '')
  }

  return parts.filter(Boolean).length > 0 ? `PROFILE:\n${parts.join('\n')}` : ''
}

function buildCompetencyContext(
  summary: Awaited<ReturnType<typeof getUserCompetencySummary>>
): string {
  if (!summary || summary.competencies.length === 0) return ''

  const top5 = summary.competencies.slice(0, 5)
  const lines = top5.map(c => {
    const trendIcon = c.trend === 'improving' ? '↑' : c.trend === 'declining' ? '↓' : '→'
    return `  ${c.name}: ${c.score}/100 ${trendIcon}`
  })

  return `COMPETENCY STATE:\n${lines.join('\n')}\nOverall readiness: ${summary.overallReadiness}/100`
}

function extractResumeAnchors(resumeText?: string): string[] {
  if (!resumeText) return []

  const anchors: string[] = []
  const text = resumeText.slice(0, 3000)

  // Look for project names, company names, key achievements
  const patterns = [
    /(?:led|built|launched|designed|managed|developed|created|implemented)\s+(.{10,60}?)(?:\.|,|;|\n)/gi,
    /(?:at|for)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)/g,
  ]

  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(text)) !== null && anchors.length < 5) {
      const anchor = match[1].trim()
      if (anchor.length >= 5 && anchor.length <= 60) {
        anchors.push(anchor)
      }
    }
  }

  return Array.from(new Set(anchors)).slice(0, 5)
}
