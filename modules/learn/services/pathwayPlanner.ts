import mongoose from 'mongoose'
import { completion } from '@shared/services/modelRouter'
import { JSON_OUTPUT_RULE } from '@shared/services/promptSecurity'
import { connectDB } from '@shared/db/connection'
import { PathwayPlan, User } from '@shared/db/models'
import type { IPathwayPlan, PracticeTask, Milestone } from '@shared/db/models'
import type { FeedbackData } from '@shared/types'
import { getUserCompetencySummary, getUserWeaknesses } from './competencyService'
import { getRecentSummaries } from './sessionSummaryService'
import type { SessionEvaluationSummary } from '@interview'
import { isFeatureEnabled } from '@shared/featureFlags'
import { logger } from '@shared/logger'

// ─── Generate Pathway Plan ──────────────────────────────────────────────────

interface GeneratePathwayInput {
  userId: string
  sessionId: string
  domain: string
  interviewType: string
  experience: string
  feedback: FeedbackData
  sessionEvaluation?: SessionEvaluationSummary
}

export async function generatePathwayPlan(input: GeneratePathwayInput): Promise<IPathwayPlan | null> {
  if (!isFeatureEnabled('pathway_planner')) return null

  try {
    await connectDB()

    const { userId, sessionId, domain, interviewType, experience, feedback, sessionEvaluation } = input

    // Gather context
    const [profile, competencySummary, weaknesses, recentSummaries] = await Promise.all([
      User.findById(userId).select('interviewGoal targetRole targetCompanyType weakAreas').lean(),
      getUserCompetencySummary(userId, domain),
      getUserWeaknesses(userId, 5),
      getRecentSummaries(userId, domain, 5),
    ])

    // Calculate readiness
    const readinessScore = calculateReadiness(feedback, competencySummary, recentSummaries)
    const readinessLevel = scoreToReadinessLevel(readinessScore)

    // Identify blocking weaknesses
    const topBlockingWeaknesses = identifyBlockingWeaknesses(
      competencySummary, weaknesses, feedback, sessionEvaluation
    )

    // Strengths to preserve
    const strengthsToPreserve = competencySummary?.strongAreas?.slice(0, 3) ||
      feedback.dimensions?.answer_quality?.strengths?.slice(0, 3) || []

    // Next session recommendation
    const nextSession = recommendNextSession(
      domain, interviewType, experience, feedback, competencySummary, weaknesses
    )

    // Generate practice tasks
    const practiceTasks = generatePracticeTasks(topBlockingWeaknesses, domain, feedback)

    // Build milestones
    const milestones = buildMilestones(competencySummary, readinessScore)

    // Build difficulty progression
    const difficultyProgression = buildDifficultyProgression(readinessScore)

    // AI-enhanced improvement plan
    const aiPlan = await generateAIPlan(input, competencySummary, weaknesses, profile as Record<string, unknown> | null)

    // Merge AI suggestions into practice tasks
    if (aiPlan?.suggestedTasks) {
      for (const task of aiPlan.suggestedTasks) {
        practiceTasks.push({
          taskId: `ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          type: task.type || 'homework',
          title: task.title,
          description: task.description,
          targetCompetency: task.targetCompetency || 'general',
          difficulty: task.difficulty || 'medium',
          estimatedMinutes: task.estimatedMinutes || 15,
          completed: false,
        })
      }
    }

    // Upsert the pathway plan (one active plan per user)
    const plan = await PathwayPlan.findOneAndUpdate(
      { userId: new mongoose.Types.ObjectId(userId) },
      {
        userId: new mongoose.Types.ObjectId(userId),
        readinessLevel,
        readinessScore,
        topBlockingWeaknesses,
        strengthsToPreserve,
        nextSessionRecommendation: nextSession,
        practiceTasks: practiceTasks.slice(0, 10),
        milestones,
        difficultyProgression,
        generatedFromSessionId: new mongoose.Types.ObjectId(sessionId),
        generatedAt: new Date(),
        userGoal: (profile?.interviewGoal as string) || '',
        targetRole: (profile?.targetRole as string) || domain,
      },
      { upsert: true, new: true }
    )

    return plan
  } catch (err) {
    logger.error({ err }, 'Failed to generate pathway plan')
    return null
  }
}

// ─── Get Current Pathway ────────────────────────────────────────────────────

export async function getCurrentPathway(userId: string): Promise<IPathwayPlan | null> {
  if (!isFeatureEnabled('pathway_planner')) return null

  try {
    await connectDB()
    return await PathwayPlan.findOne({
      userId: new mongoose.Types.ObjectId(userId),
    }).sort({ generatedAt: -1 }).lean() as IPathwayPlan | null
  } catch (err) {
    logger.error({ err }, 'Failed to get pathway')
    return null
  }
}

// ─── Mark Task Complete ─────────────────────────────────────────────────────

export async function markTaskComplete(userId: string, taskId: string): Promise<boolean> {
  try {
    await connectDB()
    const result = await PathwayPlan.updateOne(
      {
        userId: new mongoose.Types.ObjectId(userId),
        'practiceTasks.taskId': taskId,
      },
      {
        $set: {
          'practiceTasks.$.completed': true,
          'practiceTasks.$.completedAt': new Date(),
        },
      }
    )
    return result.modifiedCount > 0
  } catch (err) {
    logger.error({ err }, 'Failed to mark task complete')
    return false
  }
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

function calculateReadiness(
  feedback: FeedbackData,
  competencySummary: Awaited<ReturnType<typeof getUserCompetencySummary>>,
  recentSummaries: Array<{ overallScore: number }>
): number {
  let score = feedback.overall_score || 50

  // Factor in competency readiness
  if (competencySummary?.overallReadiness) {
    score = Math.round(score * 0.6 + competencySummary.overallReadiness * 0.4)
  }

  // Factor in trend (improving = bonus, declining = penalty)
  if (recentSummaries.length >= 3) {
    const recent = recentSummaries.slice(0, 2).reduce((s, r) => s + r.overallScore, 0) / 2
    const older = recentSummaries.slice(2, 4).reduce((s, r) => s + r.overallScore, 0) / Math.max(1, recentSummaries.slice(2, 4).length)
    if (recent > older + 5) score = Math.min(100, score + 5) // improving bonus
    if (recent < older - 5) score = Math.max(0, score - 5)  // declining penalty
  }

  return Math.round(Math.max(0, Math.min(100, score)))
}

function scoreToReadinessLevel(score: number): IPathwayPlan['readinessLevel'] {
  if (score >= 85) return 'strong'
  if (score >= 70) return 'ready'
  if (score >= 55) return 'approaching'
  if (score >= 35) return 'developing'
  return 'not_ready'
}

function identifyBlockingWeaknesses(
  competencySummary: Awaited<ReturnType<typeof getUserCompetencySummary>>,
  weaknesses: Awaited<ReturnType<typeof getUserWeaknesses>>,
  feedback: FeedbackData,
  sessionEvaluation?: SessionEvaluationSummary
): IPathwayPlan['topBlockingWeaknesses'] {
  const blockers: IPathwayPlan['topBlockingWeaknesses'] = []

  // From competency scores
  if (competencySummary?.competencies) {
    const weak = competencySummary.competencies
      .filter(c => c.score < 60 && c.confidence >= 0.2)
      .sort((a, b) => a.score - b.score)
      .slice(0, 3)

    for (const c of weak) {
      blockers.push({
        competency: c.name,
        currentScore: c.score,
        targetScore: 70,
        reason: `Score ${c.score}/100, trending ${c.trend}`,
      })
    }
  }

  // From weakness clusters
  for (const w of weaknesses.filter(w => w.severity !== 'minor').slice(0, 2)) {
    if (!blockers.find(b => b.competency === w.name)) {
      blockers.push({
        competency: w.name,
        currentScore: 0,
        targetScore: 70,
        reason: `Recurring weakness (${w.recurrenceCount}x): ${w.description}`,
      })
    }
  }

  // From session evaluation
  if (sessionEvaluation?.topWeaknesses) {
    for (const w of sessionEvaluation.topWeaknesses.slice(0, 2)) {
      if (!blockers.find(b => b.competency === w)) {
        blockers.push({
          competency: w,
          currentScore: sessionEvaluation.dimensionAverages[w] || 50,
          targetScore: 70,
          reason: `Weak in current session`,
        })
      }
    }
  }

  return blockers.slice(0, 3)
}

function recommendNextSession(
  domain: string,
  currentInterviewType: string,
  experience: string,
  feedback: FeedbackData,
  competencySummary: Awaited<ReturnType<typeof getUserCompetencySummary>>,
  weaknesses: Awaited<ReturnType<typeof getUserWeaknesses>>
): IPathwayPlan['nextSessionRecommendation'] {
  // Determine focus competencies
  const focusCompetencies = competencySummary?.weakAreas?.slice(0, 3) ||
    weaknesses.map(w => w.linkedCompetencies[0]).filter(Boolean).slice(0, 3)

  // Determine difficulty
  let difficulty: 'easy' | 'medium' | 'medium_high' | 'hard' = 'medium'
  if (feedback.overall_score >= 80) difficulty = 'medium_high'
  else if (feedback.overall_score >= 70) difficulty = 'medium'
  else if (feedback.overall_score < 50) difficulty = 'easy'

  // Determine interview type (suggest same or related)
  let nextType = currentInterviewType
  let reason = `Continue practicing ${currentInterviewType} to build consistency`

  if (feedback.overall_score >= 80 && currentInterviewType === 'screening') {
    nextType = 'behavioral'
    reason = 'Strong HR screening performance — move to deeper behavioral probing'
  } else if (feedback.overall_score >= 85 && currentInterviewType === 'behavioral') {
    nextType = 'technical'
    reason = 'Excellent behavioral skills — challenge with technical depth'
  }

  return {
    domain,
    interviewType: nextType,
    focusCompetencies,
    difficulty,
    reason,
  }
}

function generatePracticeTasks(
  blockers: IPathwayPlan['topBlockingWeaknesses'],
  domain: string,
  feedback: FeedbackData
): PracticeTask[] {
  const tasks: PracticeTask[] = []

  for (const blocker of blockers) {
    tasks.push({
      taskId: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'drill',
      title: `Practice ${blocker.competency.replace(/_/g, ' ')}`,
      description: `Focus drill: Prepare 3 stories that demonstrate strong ${blocker.competency.replace(/_/g, ' ')}. Include specific metrics and outcomes.`,
      targetCompetency: blocker.competency,
      difficulty: 'medium',
      estimatedMinutes: 15,
      completed: false,
    })
  }

  // Add communication task if needed
  if (feedback.dimensions?.communication?.filler_rate > 0.08) {
    tasks.push({
      taskId: `task_comm_${Date.now()}`,
      type: 'drill',
      title: 'Reduce filler words',
      description: 'Record yourself answering 3 practice questions. Count filler words. Target: <5% filler rate.',
      targetCompetency: 'communication',
      difficulty: 'easy',
      estimatedMinutes: 20,
      completed: false,
    })
  }

  // Add a review task
  tasks.push({
    taskId: `task_review_${Date.now()}`,
    type: 'review',
    title: 'Review session feedback',
    description: 'Re-read your session feedback and write down 3 key takeaways.',
    targetCompetency: 'self_awareness',
    difficulty: 'easy',
    estimatedMinutes: 10,
    completed: false,
  })

  return tasks.slice(0, 8)
}

function buildMilestones(
  competencySummary: Awaited<ReturnType<typeof getUserCompetencySummary>>,
  readinessScore: number
): Milestone[] {
  const milestones: Milestone[] = [
    {
      name: 'Foundation',
      description: 'Score 50+ on all core competencies',
      targetScore: 50,
      currentScore: readinessScore,
      achieved: readinessScore >= 50,
      achievedAt: readinessScore >= 50 ? new Date() : undefined,
    },
    {
      name: 'Competent',
      description: 'Score 65+ overall with no critical weaknesses',
      targetScore: 65,
      currentScore: readinessScore,
      achieved: readinessScore >= 65,
      achievedAt: readinessScore >= 65 ? new Date() : undefined,
    },
    {
      name: 'Interview Ready',
      description: 'Score 75+ with "approaching" or better readiness',
      targetScore: 75,
      currentScore: readinessScore,
      achieved: readinessScore >= 75,
      achievedAt: readinessScore >= 75 ? new Date() : undefined,
    },
    {
      name: 'Strong Candidate',
      description: 'Score 85+ with consistent performance',
      targetScore: 85,
      currentScore: readinessScore,
      achieved: readinessScore >= 85,
      achievedAt: readinessScore >= 85 ? new Date() : undefined,
    },
  ]

  return milestones
}

function buildDifficultyProgression(readinessScore: number): IPathwayPlan['difficultyProgression'] {
  return [
    { level: 'easy', requiredScore: 0, achievedAt: readinessScore >= 0 ? new Date() : undefined },
    { level: 'medium', requiredScore: 45, achievedAt: readinessScore >= 45 ? new Date() : undefined },
    { level: 'medium_high', requiredScore: 65, achievedAt: readinessScore >= 65 ? new Date() : undefined },
    { level: 'hard', requiredScore: 80, achievedAt: readinessScore >= 80 ? new Date() : undefined },
  ]
}

// ─── AI-Enhanced Plan Generation ────────────────────────────────────────────

interface AIPlan {
  suggestedTasks: Array<{
    type: 'drill' | 'full_session' | 'review' | 'homework'
    title: string
    description: string
    targetCompetency: string
    difficulty: 'easy' | 'medium' | 'hard'
    estimatedMinutes: number
  }>
}

async function generateAIPlan(
  input: GeneratePathwayInput,
  competencySummary: Awaited<ReturnType<typeof getUserCompetencySummary>>,
  weaknesses: Awaited<ReturnType<typeof getUserWeaknesses>>,
  profile: Record<string, unknown> | null
): Promise<AIPlan | null> {
  try {
    const context = [
      `Domain: ${input.domain}`,
      `Experience: ${input.experience}`,
      `Session score: ${input.feedback.overall_score}/100`,
      `Pass probability: ${input.feedback.pass_probability}`,
      profile?.interviewGoal ? `Goal: ${profile.interviewGoal}` : '',
      competencySummary ? `Readiness: ${competencySummary.overallReadiness}/100` : '',
      weaknesses.length > 0 ? `Weaknesses: ${weaknesses.map(w => w.name).join(', ')}` : '',
      input.feedback.top_3_improvements?.length ? `Improvements needed: ${input.feedback.top_3_improvements.join('; ')}` : '',
    ].filter(Boolean).join('\n')

    const result = await completion({
      taskSlot: 'learn.pathway-plan',
      system: 'You are an interview coaching expert. Generate 2-3 specific, actionable practice tasks based on the candidate\'s performance. Each task should be concrete and completable in 10-30 minutes.',
      messages: [{
        role: 'user',
        content: `Based on this performance data, suggest 2-3 practice tasks:\n\n${context}\n\n${JSON_OUTPUT_RULE}\n{\n  "suggestedTasks": [\n    {\n      "type": "drill" | "homework" | "review",\n      "title": "short title",\n      "description": "specific instructions",\n      "targetCompetency": "competency_name",\n      "difficulty": "easy" | "medium" | "hard",\n      "estimatedMinutes": number\n    }\n  ]\n}`,
      }],
    })

    const raw = result.text || '{}'
    const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    return JSON.parse(cleaned) as AIPlan
  } catch (err) {
    logger.error({ err }, 'AI plan generation failed')
    return null
  }
}
