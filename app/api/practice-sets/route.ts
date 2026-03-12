import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/authOptions'
import { connectDB } from '@/lib/db/connection'
import { User, InterviewDomain, InterviewDepth, InterviewSession } from '@/lib/db/models'
import { FALLBACK_DOMAINS, FALLBACK_DEPTHS } from '@/lib/db/seed'

export const dynamic = 'force-dynamic'

interface PracticeSetItem {
  id: string
  domain: string
  domainLabel: string
  domainIcon: string
  interviewType: string
  interviewTypeLabel: string
  interviewTypeIcon: string
  difficulty: 'beginner' | 'intermediate' | 'advanced'
  estimatedMinutes: number
  focus: string
  description: string
  personalizedTip?: string
  practiceCount: number
  lastScore?: number
  avgScore?: number
  status: 'not_started' | 'in_progress' | 'mastered'
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await connectDB()

  const [user, domainsRaw, depthsRaw, recentSessions] = await Promise.all([
    User.findById(session.user.id).select(
      'targetRole experienceLevel currentIndustry isCareerSwitcher switchingFrom ' +
      'targetCompanyType interviewGoal weakAreas preferredDomains preferredInterviewTypes ' +
      'topSkills communicationStyle practiceStats'
    ).lean(),
    InterviewDomain.find({ isActive: true }).sort({ sortOrder: 1 }).lean().catch(() => null),
    InterviewDepth.find({ isActive: true }).sort({ sortOrder: 1 }).lean().catch(() => null),
    InterviewSession.find({
      userId: session.user.id,
      status: 'completed',
    }).sort({ createdAt: -1 }).limit(20).select('config feedback').lean().catch(() => []),
  ])

  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const domains = domainsRaw || FALLBACK_DOMAINS.map(d => ({
    ...d, _id: d.slug, isActive: true, isBuiltIn: true, sortOrder: 0,
    sampleQuestions: [], evaluationEmphasis: [], systemPromptContext: d.systemPromptContext || '',
    createdAt: new Date(), updatedAt: new Date(),
  }))

  const depths = depthsRaw || FALLBACK_DEPTHS.map(d => ({
    ...d, _id: d.slug, isActive: true, isBuiltIn: true, sortOrder: 0,
    createdAt: new Date(), updatedAt: new Date(),
  }))

  // Build personalized practice sets
  const practiceSets: PracticeSetItem[] = []
  const practiceStats = user.practiceStats || new Map()

  // Priority domains: user's preferred + target role + domains from recent sessions
  const priorityDomains = new Set<string>()
  if (user.targetRole) priorityDomains.add(user.targetRole)
  if (user.preferredDomains?.length) {
    user.preferredDomains.forEach(d => priorityDomains.add(d))
  }
  recentSessions.forEach(s => {
    if (s.config?.role) priorityDomains.add(s.config.role)
  })

  // If no preferences, use first 3 domains
  if (priorityDomains.size === 0) {
    domains.slice(0, 3).forEach(d => priorityDomains.add(d.slug))
  }

  // Priority depths
  const priorityDepths = new Set<string>()
  if (user.preferredInterviewTypes?.length) {
    user.preferredInterviewTypes.forEach(d => priorityDepths.add(d))
  }
  if (priorityDepths.size === 0) {
    priorityDepths.add('hr-screening')
    priorityDepths.add('behavioral')
    priorityDepths.add('technical')
  }

  const weakAreaTips: Record<string, string> = {
    star_structure: 'Focus on structuring answers with Situation, Task, Action, Result.',
    specificity: 'Include specific metrics, numbers, and concrete examples.',
    conciseness: 'Keep answers under 2 minutes. Lead with the key point.',
    confidence: 'Use decisive language. Avoid hedging words like "maybe" or "I think".',
    technical_depth: 'Prepare to explain technical decisions and tradeoffs clearly.',
    storytelling: 'Create a narrative arc: challenge → action → impact.',
  }

  // Map experience level to difficulty
  const baseDifficulty = user.experienceLevel === '7+'
    ? 'advanced' : user.experienceLevel === '3-6' ? 'intermediate' : 'beginner'

  for (const domainSlug of Array.from(priorityDomains)) {
    const domain = domains.find(d => d.slug === domainSlug)
    if (!domain) continue

    for (const depthSlug of Array.from(priorityDepths)) {
      const depth = depths.find(d => d.slug === depthSlug)
      if (!depth) continue

      // Check applicability
      if (depth.applicableDomains?.length && !depth.applicableDomains.includes(domainSlug)) {
        continue
      }

      const key = `${domainSlug}:${depthSlug}`
      const stats = (practiceStats as unknown as Record<string, { totalSessions?: number; avgScore?: number; lastScore?: number }>)?.[key]
      const practiceCount = stats?.totalSessions || 0
      const avgScore = stats?.avgScore
      const lastScore = stats?.lastScore

      // Determine status
      let status: 'not_started' | 'in_progress' | 'mastered' = 'not_started'
      if (practiceCount > 0 && (avgScore || 0) >= 80) status = 'mastered'
      else if (practiceCount > 0) status = 'in_progress'

      // Adjust difficulty based on practice history
      let difficulty = baseDifficulty as 'beginner' | 'intermediate' | 'advanced'
      if (avgScore && avgScore >= 80 && difficulty !== 'advanced') {
        difficulty = difficulty === 'beginner' ? 'intermediate' : 'advanced'
      }

      // Build personalized tip
      let personalizedTip: string | undefined
      if (user.weakAreas?.length) {
        const relevantWeak = user.weakAreas[0]
        personalizedTip = weakAreaTips[relevantWeak]
      }
      if (user.isCareerSwitcher && user.switchingFrom) {
        personalizedTip = `As a career switcher from ${user.switchingFrom}, focus on transferable skills and learning agility.`
      }
      if (user.targetCompanyType && user.targetCompanyType !== 'any') {
        const companyContext: Record<string, string> = {
          faang: 'FAANG interviews emphasize structured problem-solving and scale.',
          startup: 'Startup interviews focus on adaptability and wearing multiple hats.',
          consulting: 'Consulting interviews value framework thinking and client skills.',
          enterprise: 'Enterprise interviews focus on process, stakeholder management.',
          midsize: 'Mid-size company interviews balance technical depth with culture fit.',
        }
        personalizedTip = companyContext[user.targetCompanyType] || personalizedTip
      }

      const focusAreas: string[] = []
      if (user.weakAreas?.length) {
        focusAreas.push(...user.weakAreas.slice(0, 2).map(a => a.replace(/_/g, ' ')))
      }

      practiceSets.push({
        id: key,
        domain: domainSlug,
        domainLabel: domain.label,
        domainIcon: domain.icon,
        interviewType: depthSlug,
        interviewTypeLabel: depth.label,
        interviewTypeIcon: depth.icon,
        difficulty,
        estimatedMinutes: difficulty === 'beginner' ? 10 : difficulty === 'intermediate' ? 20 : 30,
        focus: focusAreas.length > 0 ? focusAreas.join(', ') : depth.description.split('—')[0].trim(),
        description: `${domain.label} ${depth.label} practice${personalizedTip ? ` — ${personalizedTip}` : ''}`,
        personalizedTip,
        practiceCount,
        lastScore,
        avgScore,
        status,
      })
    }
  }

  // Sort: not_started first, then in_progress, then mastered. Within each group, sort by relevance.
  const statusOrder = { not_started: 0, in_progress: 1, mastered: 2 }
  practiceSets.sort((a, b) => {
    const statusDiff = statusOrder[a.status] - statusOrder[b.status]
    if (statusDiff !== 0) return statusDiff
    // Prioritize target role
    if (a.domain === user?.targetRole && b.domain !== user?.targetRole) return -1
    if (b.domain === user?.targetRole && a.domain !== user?.targetRole) return 1
    return 0
  })

  return NextResponse.json({
    practiceSets,
    profile: {
      targetRole: user.targetRole,
      experienceLevel: user.experienceLevel,
      weakAreas: user.weakAreas || [],
      interviewGoal: user.interviewGoal,
      isCareerSwitcher: user.isCareerSwitcher,
    },
  })
}
