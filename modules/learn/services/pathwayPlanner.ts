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
import {
  resolveCurrentPhase,
  detectPhaseGraduation,
  phaseFocusCompetencies,
  DEFAULT_PHASE_THRESHOLDS,
  type PathwayPhase,
} from './phaseAdvancement'
import { emitPathwayEvent } from './pathwayEvents'
import { buildLessonCacheKey, getOrGenerateLesson } from './lessonGenerator'

const STANDARD_PLAN_TYPE = 'standard' as const
const UNIVERSAL_PLAN_TYPE = 'universal' as const
const UNIVERSAL_FALLBACK_COMPETENCIES = ['relevance', 'structure', 'specificity']

/**
 * Filter for "standard" pathway documents that includes pre-redesign docs
 * that were written before the `planType` field existed.
 *
 * Before the 2026-05-14 pathway redesign (commit 3a9a9e7), PathwayPlan
 * documents didn't carry a `planType` field at all. After the redesign,
 * `getCurrentPathway` started filtering strictly on `planType: 'standard'`,
 * so every pathway document in production written before the redesign
 * silently became invisible to the UI — the Pathway page showed
 * "NO PATHWAY YET" even when a fully-populated plan existed in the DB.
 *
 * Match behavior:
 *   - planType: 'standard'          → matches (post-redesign docs)
 *   - planType: { $exists: false }  → matches (pre-redesign docs)
 *   - planType: null                → matches (defensive: serialized null)
 *   - planType: 'monthly'           → does NOT match (older system, different shape)
 *   - planType: 'universal'         → does NOT match (separate planning path)
 *
 * scripts/migrate-pathway-plan-type.mjs backfills the missing field so
 * this OR clause can eventually simplify back to `planType: 'standard'`.
 */
const STANDARD_OR_LEGACY_FILTER = {
  $or: [
    { planType: STANDARD_PLAN_TYPE },
    { planType: { $exists: false } },
    { planType: null },
  ],
}

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

    const uid = new mongoose.Types.ObjectId(userId)

    // Upsert the standard interview-derived plan without colliding with the
    // universal support curriculum.
    const plan = await PathwayPlan.findOneAndUpdate(
      { userId: uid, planType: STANDARD_PLAN_TYPE },
      {
        userId: uid,
        planType: STANDARD_PLAN_TYPE,
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
      { upsert: true, returnDocument: 'after' }
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
      ...STANDARD_OR_LEGACY_FILTER,
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
        ...STANDARD_OR_LEGACY_FILTER,
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
  // G.5: `??` so a legit 0 (abandoned interview) isn't stomped to 50
  // and then used as the readiness baseline.
  let score = feedback.overall_score ?? 50

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

// ─── Universal Phased Plan ──────────────────────────────────────────────────

interface GenerateUniversalPlanInput {
  userId: string
  domain: string
  depth: string
  targetRole?: string
  thresholds?: Record<string, number>
}

/**
 * Create (or refresh) a universal phased pathway plan for a user.
 * This plan tracks session-count pacing across 6 phases and pre-selects
 * lessons for the current phase's focus competencies.
 */
export async function generateUniversalPlan(
  input: GenerateUniversalPlanInput,
): Promise<IPathwayPlan | null> {
  if (!isFeatureEnabled('pathway_planner')) return null

  try {
    await connectDB()
    const { userId, domain, depth, targetRole } = input
    const thresholds = input.thresholds ?? DEFAULT_PHASE_THRESHOLDS

    const uid = new mongoose.Types.ObjectId(userId)
    const existing = await PathwayPlan.findOne({ userId: uid, planType: UNIVERSAL_PLAN_TYPE })
    const sessionsCompleted = existing?.sessionsCompleted ?? 0
    const currentPhase = resolveCurrentPhase(sessionsCompleted, thresholds)

    const competencySummary = await getUserCompetencySummary(userId, domain)
    const weakAreas = competencySummary?.weakAreas ?? []
    const strongAreas = competencySummary?.strongAreas ?? []
    const focus = resolveUniversalFocus(currentPhase, weakAreas, strongAreas)

    const lessons = focus.map((competency) => ({
      lessonId: buildLessonCacheKey(competency, domain, depth),
      competency,
      completed: false,
    }))

    const isNew = !existing
    const plan = await PathwayPlan.findOneAndUpdate(
      { userId: uid, planType: UNIVERSAL_PLAN_TYPE },
      {
        $set: {
          userId: uid,
          planType: UNIVERSAL_PLAN_TYPE,
          domain,
          depth,
          sessionsCompleted,
          phaseThresholds: thresholds,
          currentPhase,
          lessons,
          targetRole: targetRole ?? domain,
          generatedAt: new Date(),
        },
      },
      { upsert: true, returnDocument: 'after' },
    )

    if (isNew) {
      await emitPathwayEvent({
        type: 'pathway_created',
        userId,
        timestamp: new Date(),
        payload: { planId: String(plan._id), currentPhase, domain, depth },
      })
    }

    return plan
  } catch (err) {
    logger.error({ err }, 'Failed to generate universal plan')
    return null
  }
}

/**
 * Called after each session. Bumps sessionsCompleted, detects phase graduation,
 * emits events, and returns the refreshed plan.
 */
export async function advanceUniversalPlan(
  userId: string,
): Promise<IPathwayPlan | null> {
  if (!isFeatureEnabled('pathway_planner')) return null

  try {
    await connectDB()
    const uid = new mongoose.Types.ObjectId(userId)
    const plan = await PathwayPlan.findOne({ userId: uid, planType: UNIVERSAL_PLAN_TYPE })
    if (!plan) return null

    const prevSessions = plan.sessionsCompleted ?? 0
    const newSessions = prevSessions + 1
    const thresholds = plan.phaseThresholds ?? DEFAULT_PHASE_THRESHOLDS

    const graduated = detectPhaseGraduation(prevSessions, newSessions, thresholds)
    const newPhase = resolveCurrentPhase(newSessions, thresholds)

    plan.sessionsCompleted = newSessions
    plan.currentPhase = newPhase

    if (graduated) {
      plan.phaseHistory = plan.phaseHistory ?? []
      plan.phaseHistory.push({
        phase: graduated,
        enteredAt: plan.generatedAt ?? new Date(),
        exitedAt: new Date(),
        avgScore: 0,
      })

      // Bug fix (2026-05-17) — refresh plan.lessons[] on phase
      // transition so the lesson queue actually surfaces guidance for
      // the user's CURRENT phase. Previously the lessons array was
      // populated once at plan creation and never touched again, so a
      // user 3 phases deep was still seeing assessment-phase lessons
      // (or in many cases, an empty queue if they had no weaknesses
      // at creation time and pre-dated the fallback).
      //
      // Completion state for any lesson the user has finished is
      // preserved across the refresh.
      if (plan.domain && plan.depth) {
        try {
          plan.lessons = await buildPhaseLessons(
            userId,
            plan.domain,
            plan.depth,
            newPhase,
            plan.lessons ?? [],
          )
        } catch (err) {
          // Don't fail the session-advance just because the lesson
          // refresh hit an LLM/DB hiccup — sessionsCompleted +
          // phaseHistory progression is the higher-priority update.
          // The backfill in getUniversalPlan will catch it next read.
          logger.warn({ err, userId, newPhase }, 'Failed to refresh plan.lessons on phase transition')
        }
      }
    }

    await plan.save()

    if (graduated) {
      await emitPathwayEvent({
        type: 'phase_graduated',
        userId,
        timestamp: new Date(),
        payload: { graduatedPhase: graduated, enteredPhase: newPhase, sessionsCompleted: newSessions },
      })
      await emitPathwayEvent({
        type: 'phase_entered',
        userId,
        timestamp: new Date(),
        payload: { phase: newPhase, sessionsCompleted: newSessions },
      })

      // Entering review = completing the full curriculum → graduate review too
      if (newPhase === 'review') {
        await emitPathwayEvent({
          type: 'phase_graduated',
          userId,
          timestamp: new Date(),
          payload: { graduatedPhase: 'review', sessionsCompleted: newSessions },
        })
      }

      // Pre-generate lessons for the new phase so they're cached when users click
      if (plan.domain && plan.depth) {
        const domain = plan.domain
        const depth = plan.depth
        getUserCompetencySummary(userId, domain)
          .then((summary) => {
            const focus = resolveUniversalFocus(
              newPhase,
              summary?.weakAreas ?? [],
              summary?.strongAreas ?? [],
            )
            return Promise.allSettled(
              focus.map((competency) =>
                getOrGenerateLesson({ competency, domain, depth }),
              ),
            )
          })
          .catch((err) => {
            logger.warn({ err, userId, newPhase }, 'Lesson pre-generation failed')
          })
      }
    }

    return plan
  } catch (err) {
    logger.error({ err, userId }, 'Failed to advance universal plan')
    return null
  }
}

/**
 * Fetch the current universal plan for a user, or null if none exists.
 *
 * Backfill (2026-05-17): self-heals legacy plans where `lessons` was
 * persisted as `[]`. This happened to plans created before the
 * `UNIVERSAL_FALLBACK_COMPETENCIES` fallback existed (commit 3a9a9e7,
 * 2026-05-14) — if the user had no `weakAreas`/`strongAreas` at
 * creation time, `phaseFocusCompetencies` returned `[]` and the empty
 * array was persisted forever. The UI showed `Lesson queue (0/0)`
 * with no recovery path. We can't migrate those rows in bulk safely
 * (need per-user competency lookup), so we self-heal on first read.
 */
export async function getUniversalPlan(userId: string): Promise<IPathwayPlan | null> {
  if (!isFeatureEnabled('pathway_planner')) return null
  try {
    await connectDB()
    const plan = (await PathwayPlan.findOne({
      userId: new mongoose.Types.ObjectId(userId),
      planType: UNIVERSAL_PLAN_TYPE,
    }).lean()) as IPathwayPlan | null

    if (!plan) return null

    // Self-heal empty lessons[] — only when plan has the data we need
    // to compute lessons (domain + depth). Without those we can't
    // recompute the lessonId cache key, so leave the empty array and
    // let the user re-create through the UI.
    if ((!plan.lessons || plan.lessons.length === 0) && plan.domain && plan.depth) {
      try {
        const refreshed = await buildPhaseLessons(
          userId,
          plan.domain,
          plan.depth,
          (plan.currentPhase as PathwayPhase) ?? 'assessment',
          [],
        )
        if (refreshed.length > 0) {
          await PathwayPlan.updateOne(
            { _id: plan._id },
            { $set: { lessons: refreshed } },
          )
          // Return the freshly-populated plan so the caller sees the
          // backfill on this same request — no need to round-trip.
          plan.lessons = refreshed
        }
      } catch (err) {
        // Best-effort heal — degrade silently so a competency-summary
        // hiccup doesn't take down the pathway page.
        logger.warn({ err, userId, planId: String(plan._id) }, 'Failed to backfill empty plan.lessons on read')
      }
    }

    return plan
  } catch (err) {
    logger.error({ err, userId }, 'Failed to get universal plan')
    return null
  }
}

/**
 * Mark a lesson within the universal plan as complete. Returns true if the plan was modified.
 */
export async function markLessonComplete(
  userId: string,
  lessonId: string,
): Promise<boolean> {
  try {
    await connectDB()
    const uid = new mongoose.Types.ObjectId(userId)
    const result = await PathwayPlan.updateOne(
      { userId: uid, planType: UNIVERSAL_PLAN_TYPE, 'lessons.lessonId': lessonId },
      {
        $set: {
          'lessons.$.completed': true,
          'lessons.$.completedAt': new Date(),
        },
      },
    )
    return result.modifiedCount > 0
  } catch (err) {
    logger.error({ err, userId, lessonId }, 'Failed to mark lesson complete')
    return false
  }
}

function resolveUniversalFocus(
  phase: PathwayPhase,
  weakAreas: string[],
  strongAreas: string[],
): string[] {
  const focus = phaseFocusCompetencies(phase, weakAreas, strongAreas)
  return focus.length > 0 ? focus : UNIVERSAL_FALLBACK_COMPETENCIES
}

/**
 * Build `lessons[]` entries for the user's current phase, preserving any
 * already-completed lessons so we don't reset progress when refreshing
 * on phase transition or when self-healing an empty array.
 *
 * Used by both:
 *   - advanceUniversalPlan (Bug #2: phase-transition refresh)
 *   - getUniversalPlan (Bug #1: backfill-on-read for legacy empty plans)
 */
async function buildPhaseLessons(
  userId: string,
  domain: string,
  depth: string,
  phase: PathwayPhase,
  existingLessons: Array<{ lessonId: string; competency: string; completed: boolean; completedAt?: Date }> = [],
): Promise<Array<{ lessonId: string; competency: string; completed: boolean; completedAt?: Date }>> {
  const summary = await getUserCompetencySummary(userId, domain)
  const focus = resolveUniversalFocus(
    phase,
    summary?.weakAreas ?? [],
    summary?.strongAreas ?? [],
  )
  // Index existing by lessonId so we carry forward completion state for
  // any lesson that was finished before this refresh.
  const completedByLessonId = new Map(
    existingLessons
      .filter((l) => l.completed)
      .map((l) => [l.lessonId, l] as const),
  )
  return focus.map((competency) => {
    const lessonId = buildLessonCacheKey(competency, domain, depth)
    const prior = completedByLessonId.get(lessonId)
    return prior
      ? { lessonId, competency, completed: true, completedAt: prior.completedAt }
      : { lessonId, competency, completed: false }
  })
}

export type { PathwayPhase }
