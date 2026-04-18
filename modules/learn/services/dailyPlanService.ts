import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { PathwayPlan, User } from '@shared/db/models'
import type { PracticeTask } from '@shared/db/models/PathwayPlan'
import { getUserCompetencySummary, getUserWeaknesses } from './competencyService'
import { getDueCompetencies } from './spacedRepetitionService'
import { logger } from '@shared/logger'

// ─── Constants ────────────────────────────────────────────────────────────────

const PLAN_DURATION_DAYS = 30

type PlanPhase = 'assessment' | 'foundation' | 'building' | 'intensity' | 'mastery' | 'review'
type PlanTier = 'free' | 'pro' | 'enterprise'

// ─── Phase definitions with adaptive exit criteria ────────────────────────────

const PHASE_DEFINITIONS: Record<PlanPhase, {
  label: string
  exitScoreThreshold: number    // avg score needed to advance
  minSessionsToAdvance: number  // minimum sessions before advancing
  taskTypes: PracticeTask['type'][]
  difficulty: PracticeTask['difficulty']
  interviewDuration: number     // minutes for full_session tasks
}> = {
  assessment: {
    label: 'Assessment',
    exitScoreThreshold: 0,      // always exits after 1 day
    minSessionsToAdvance: 1,
    taskTypes: ['full_session'],
    difficulty: 'easy',
    interviewDuration: 10,
  },
  foundation: {
    label: 'Foundation',
    exitScoreThreshold: 50,
    minSessionsToAdvance: 2,
    taskTypes: ['drill', 'review'],
    difficulty: 'easy',
    interviewDuration: 10,
  },
  building: {
    label: 'Building',
    exitScoreThreshold: 65,
    minSessionsToAdvance: 3,
    taskTypes: ['full_session', 'drill'],
    difficulty: 'medium',
    interviewDuration: 20,
  },
  intensity: {
    label: 'Intensity',
    exitScoreThreshold: 75,
    minSessionsToAdvance: 2,
    taskTypes: ['full_session', 'drill'],
    difficulty: 'hard',
    interviewDuration: 20,
  },
  mastery: {
    label: 'Mastery',
    exitScoreThreshold: 100,    // never exits — stays until Review
    minSessionsToAdvance: 999,
    taskTypes: ['full_session'],
    difficulty: 'hard',
    interviewDuration: 30,
  },
  review: {
    label: 'Review',
    exitScoreThreshold: 100,
    minSessionsToAdvance: 999,
    taskTypes: ['full_session', 'review'],
    difficulty: 'medium',
    interviewDuration: 30,
  },
}

// Phase progression order
const PHASE_ORDER: PlanPhase[] = ['assessment', 'foundation', 'building', 'intensity', 'mastery', 'review']

// ─── Tier task density ────────────────────────────────────────────────────────

function getTasksPerDay(tier: PlanTier): number {
  switch (tier) {
    case 'free': return 1
    case 'pro': return 2
    case 'enterprise': return 3
    default: return 1
  }
}

// Free tier: space 3 interviews across the month
function getFreeInterviewDays(): number[] {
  return [1, 15, 28]
}

function generateTaskId(day: number, idx: number): string {
  return `day${day}_task${idx}_${Math.random().toString(36).slice(2, 8)}`
}

// ─── Generate Monthly Plan ────────────────────────────────────────────────────

export async function generateMonthlyPlan(
  userId: string,
  domain: string,
  interviewType: string = 'screening',
  experience: string = '3-6',
  startingPhase?: PlanPhase
): Promise<typeof PathwayPlan.prototype | null> {
  try {
    await connectDB()

    const [userDoc, competencySummary, weaknesses, dueCompetencies] = await Promise.all([
      User.findById(userId).select('interviewGoal targetRole weakAreas plan').lean(),
      getUserCompetencySummary(userId, domain),
      getUserWeaknesses(userId, 6),
      getDueCompetencies(userId, domain),
    ])

    const tier = (userDoc?.plan as PlanTier) || 'free'
    const weakAreas = competencySummary?.weakAreas || []
    const strongAreas = competencySummary?.strongAreas || []
    const readinessScore = competencySummary?.overallReadiness || 40
    const tasksPerDay = getTasksPerDay(tier)
    const freeInterviewDays = getFreeInterviewDays()

    // Determine starting phase
    const initialPhase: PlanPhase = startingPhase || 'assessment'

    // Build 30-day schedule
    const startDate = new Date()
    const endDate = new Date(startDate.getTime() + PLAN_DURATION_DAYS * 24 * 60 * 60 * 1000)
    const monthLabel = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}`

    const dailySchedule: Array<{
      day: number; date: string; theme: string; phase: string;
      tasks: PracticeTask[]; completed: boolean
    }> = []

    // For initial generation, distribute phases across 30 days based on tier
    let currentPhase = initialPhase
    let phaseDay = 0  // days spent in current phase

    for (let day = 1; day <= PLAN_DURATION_DAYS; day++) {
      const dayDate = new Date(startDate.getTime() + (day - 1) * 24 * 60 * 60 * 1000)
      const phaseDef = PHASE_DEFINITIONS[currentPhase]
      const tasks: PracticeTask[] = []

      // Force Review phase for last 3 days
      if (day >= PLAN_DURATION_DAYS - 2) {
        currentPhase = 'review'
      }

      // Assessment is always day 1 only
      if (currentPhase === 'assessment' && day > 1) {
        currentPhase = 'foundation'
        phaseDay = 0
      }

      const activePhaseDef = PHASE_DEFINITIONS[currentPhase]

      // Pick target competency (rotate through weak areas + SR due)
      const targetIdx = (day - 1) % Math.max(weakAreas.length, 1)
      const targetCompetency = weakAreas[targetIdx] || 'general'
      const dueToday = dueCompetencies.find(d =>
        d.urgency === 'overdue_critical' || d.urgency === 'due_today'
      )
      const primaryCompetency = dueToday?.competencyName || targetCompetency

      // Generate tasks based on tier and phase
      for (let taskIdx = 0; taskIdx < tasksPerDay; taskIdx++) {
        const isFreeUser = tier === 'free'
        const isInterviewDay = isFreeUser ? freeInterviewDays.includes(day) : true

        if (taskIdx === 0) {
          // Primary task
          if (currentPhase === 'assessment') {
            tasks.push({
              taskId: generateTaskId(day, taskIdx),
              type: 'full_session',
              title: 'Diagnostic interview',
              description: `Complete a baseline ${interviewType} interview to assess your current level.`,
              targetCompetency: 'general',
              difficulty: 'easy',
              estimatedMinutes: 15,
              completed: false,
            })
          } else if (isInterviewDay && activePhaseDef.taskTypes.includes('full_session')) {
            tasks.push({
              taskId: generateTaskId(day, taskIdx),
              type: 'full_session',
              title: `${activePhaseDef.interviewDuration}-min ${interviewType} practice`,
              description: `Complete a ${activePhaseDef.interviewDuration}-minute ${interviewType} interview focusing on ${primaryCompetency}. ${activePhaseDef.label} phase.`,
              targetCompetency: primaryCompetency,
              difficulty: activePhaseDef.difficulty,
              estimatedMinutes: activePhaseDef.interviewDuration + 5,
              completed: false,
            })
          } else {
            tasks.push({
              taskId: generateTaskId(day, taskIdx),
              type: 'drill',
              title: `Quick drill: ${primaryCompetency}`,
              description: `Practice a focused ${primaryCompetency} drill for ${domain}.`,
              targetCompetency: primaryCompetency,
              difficulty: activePhaseDef.difficulty,
              estimatedMinutes: 10,
              completed: false,
            })
          }
        } else {
          // Secondary tasks (Pro/Enterprise only)
          const secondaryCompetency = weakAreas[(day + taskIdx) % Math.max(weakAreas.length, 1)] || primaryCompetency
          const taskType = day % 3 === 0 ? 'review' as const : 'drill' as const
          tasks.push({
            taskId: generateTaskId(day, taskIdx),
            type: taskType,
            title: taskType === 'review'
              ? `Review: ${secondaryCompetency}`
              : `Targeted drill: ${secondaryCompetency}`,
            description: taskType === 'review'
              ? `Review your past answers and feedback for ${secondaryCompetency}.`
              : `Short focused practice on ${secondaryCompetency}.`,
            targetCompetency: secondaryCompetency,
            difficulty: activePhaseDef.difficulty === 'hard' ? 'medium' : activePhaseDef.difficulty,
            estimatedMinutes: 10,
            completed: false,
          })
        }
      }

      dailySchedule.push({
        day,
        date: dayDate.toISOString().split('T')[0],
        theme: activePhaseDef.label,
        phase: currentPhase,
        tasks,
        completed: false,
      })

      phaseDay++

      // For free tier: use fixed phase schedule (no adaptive transitions)
      if (tier === 'free') {
        if (day === 1) currentPhase = 'foundation'
        else if (day === 8) currentPhase = 'building'
        else if (day === 16) currentPhase = 'intensity'
        else if (day === 24) currentPhase = 'mastery'
        phaseDay = 0
      }
    }

    // Flatten tasks for backward compat
    const allTasks = dailySchedule.flatMap(d => d.tasks)

    const plan = await PathwayPlan.findOneAndUpdate(
      { userId: new mongoose.Types.ObjectId(userId), planType: 'monthly' },
      {
        userId: new mongoose.Types.ObjectId(userId),
        planType: 'monthly',
        startDate,
        endDate,
        planDurationDays: PLAN_DURATION_DAYS,
        monthLabel,
        tier,
        autoGenerated: false,
        currentPhase: initialPhase,
        phaseHistory: [{ phase: initialPhase, enteredAt: new Date(), avgScore: 0 }],
        dailySchedule,
        practiceTasks: allTasks.slice(0, 10),
        readinessScore,
        readinessLevel: readinessScore >= 75 ? 'ready' : readinessScore >= 55 ? 'approaching' : readinessScore >= 35 ? 'developing' : 'not_ready',
        topBlockingWeaknesses: (weaknesses || []).slice(0, 3).map((w: Record<string, unknown>) => ({
          competency: (w.weaknessName || w.name || 'unknown') as string,
          currentScore: 40,
          targetScore: 70,
          reason: (w.description || '') as string,
        })),
        strengthsToPreserve: strongAreas.slice(0, 3),
        nextSessionRecommendation: {
          domain,
          interviewType,
          focusCompetencies: weakAreas.slice(0, 3),
          difficulty: readinessScore >= 60 ? 'medium' : 'easy',
          reason: 'Based on your monthly plan progression',
        },
        generatedAt: new Date(),
        userGoal: (userDoc?.interviewGoal as string) || '',
        targetRole: (userDoc?.targetRole as string) || domain,
      },
      { upsert: true, returnDocument: 'after' }
    )

    return plan
  } catch (err) {
    logger.error({ err }, 'Failed to generate monthly plan')
    return null
  }
}

// ─── Evaluate Phase Transition ────────────────────────────────────────────────

export async function evaluatePhaseTransition(
  userId: string
): Promise<{ shouldAdvance: boolean; currentPhase: PlanPhase; nextPhase: PlanPhase | null; reason: string }> {
  try {
    await connectDB()
    const plan = await PathwayPlan.findOne({
      userId: new mongoose.Types.ObjectId(userId),
      planType: 'monthly',
    }).sort({ generatedAt: -1 }).lean()

    if (!plan?.currentPhase) {
      return { shouldAdvance: false, currentPhase: 'assessment', nextPhase: null, reason: 'No active plan' }
    }

    const currentPhase = plan.currentPhase as PlanPhase
    if (currentPhase === 'mastery' || currentPhase === 'review') {
      return { shouldAdvance: false, currentPhase, nextPhase: null, reason: 'Already at terminal phase' }
    }

    // Free tier uses fixed schedule — no adaptive transitions
    if (plan.tier === 'free') {
      return { shouldAdvance: false, currentPhase, nextPhase: null, reason: 'Free tier uses fixed schedule' }
    }

    const phaseDef = PHASE_DEFINITIONS[currentPhase]

    // Get recent session scores
    const competencySummary = await getUserCompetencySummary(userId)
    const avgScore = competencySummary?.overallReadiness || 0

    // Check if completed sessions in current phase (count completed full_session tasks)
    const completedSessions = (plan.dailySchedule || [])
      .flatMap(d => d.tasks)
      .filter(t => t.type === 'full_session' && t.completed)
      .length

    // Check phase history to count sessions since entering this phase
    const currentPhaseEntry = (plan.phaseHistory || []).find(
      p => p.phase === currentPhase && !p.exitedAt
    )
    const sessionsInPhase = currentPhaseEntry
      ? completedSessions  // simplified — counts all completed sessions
      : 0

    if (avgScore >= phaseDef.exitScoreThreshold && sessionsInPhase >= phaseDef.minSessionsToAdvance) {
      const currentIdx = PHASE_ORDER.indexOf(currentPhase)
      const nextPhase = currentIdx < PHASE_ORDER.length - 2 ? PHASE_ORDER[currentIdx + 1] : null

      return {
        shouldAdvance: true,
        currentPhase,
        nextPhase,
        reason: `Avg score ${avgScore} ≥ ${phaseDef.exitScoreThreshold} with ${sessionsInPhase} sessions completed`,
      }
    }

    return {
      shouldAdvance: false,
      currentPhase,
      nextPhase: null,
      reason: `Score ${avgScore}/${phaseDef.exitScoreThreshold}, sessions ${sessionsInPhase}/${phaseDef.minSessionsToAdvance}`,
    }
  } catch (err) {
    logger.error({ err }, 'Failed to evaluate phase transition')
    return { shouldAdvance: false, currentPhase: 'assessment', nextPhase: null, reason: 'Error' }
  }
}

// ─── Advance Phase ────────────────────────────────────────────────────────────

export async function advancePhase(userId: string): Promise<boolean> {
  try {
    await connectDB()
    const evaluation = await evaluatePhaseTransition(userId)
    if (!evaluation.shouldAdvance || !evaluation.nextPhase) return false

    const plan = await PathwayPlan.findOne({
      userId: new mongoose.Types.ObjectId(userId),
      planType: 'monthly',
    }).sort({ generatedAt: -1 })

    if (!plan) return false

    const now = new Date()

    // Close current phase in history
    if (plan.phaseHistory) {
      const current = plan.phaseHistory.find(
        p => p.phase === evaluation.currentPhase && !p.exitedAt
      )
      if (current) current.exitedAt = now
    }

    // Open new phase
    plan.currentPhase = evaluation.nextPhase as typeof plan.currentPhase
    plan.phaseHistory = [
      ...(plan.phaseHistory || []),
      { phase: evaluation.nextPhase, enteredAt: now, avgScore: 0 },
    ]

    // Update remaining days to use new phase's task types
    const startDate = plan.startDate ? new Date(plan.startDate) : new Date()
    const currentDay = Math.floor((now.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)) + 1
    const newPhaseDef = PHASE_DEFINITIONS[evaluation.nextPhase]

    if (plan.dailySchedule) {
      for (const daySchedule of plan.dailySchedule) {
        if (daySchedule.day > currentDay && daySchedule.day <= PLAN_DURATION_DAYS - 3) {
          daySchedule.phase = evaluation.nextPhase
          daySchedule.theme = newPhaseDef.label
          // Update uncompleted tasks to new phase difficulty
          for (const task of daySchedule.tasks) {
            if (!task.completed) {
              task.difficulty = newPhaseDef.difficulty
              if (task.type === 'full_session') {
                task.title = `${newPhaseDef.interviewDuration}-min practice`
                task.estimatedMinutes = newPhaseDef.interviewDuration + 5
              }
            }
          }
        }
      }
    }

    await plan.save()
    return true
  } catch (err) {
    logger.error({ err }, 'Failed to advance phase')
    return false
  }
}

// ─── Auto-Regenerate Plan ─────────────────────────────────────────────────────

export async function autoRegeneratePlan(userId: string): Promise<typeof PathwayPlan.prototype | null> {
  try {
    await connectDB()

    // Find previous month's plan
    const previousPlan = await PathwayPlan.findOne({
      userId: new mongoose.Types.ObjectId(userId),
      planType: 'monthly',
    }).sort({ generatedAt: -1 }).lean()

    // Determine starting phase from previous plan's end state
    const startingPhase: PlanPhase = previousPlan?.currentPhase
      ? (previousPlan.currentPhase === 'review' || previousPlan.currentPhase === 'mastery'
        ? 'building'  // Strong users restart at Building, not Assessment
        : previousPlan.currentPhase as PlanPhase)
      : 'assessment'

    const domain = previousPlan?.nextSessionRecommendation?.domain || previousPlan?.targetRole || ''
    const interviewType = previousPlan?.nextSessionRecommendation?.interviewType || 'screening'

    const plan = await generateMonthlyPlan(userId, domain, interviewType, '3-6', startingPhase)

    if (plan) {
      plan.autoGenerated = true
      await plan.save()
    }

    return plan
  } catch (err) {
    logger.error({ err }, 'Failed to auto-regenerate plan')
    return null
  }
}

// ─── Get Today's Tasks ────────────────────────────────────────────────────────

interface TodayResult {
  plan: {
    planType: string
    startDate: string
    endDate: string
    readinessScore: number
    currentPhase: string
    tier: string
    monthLabel: string
  } | null
  today: {
    day: number
    date: string
    theme: string
    phase: string
    tasks: PracticeTask[]
  } | null
  progress: {
    currentDay: number
    completedDays: number
    totalDays: number
    phaseProgress: string
  }
}

export async function getTodaysTasks(userId: string): Promise<TodayResult> {
  const empty: TodayResult = {
    plan: null,
    today: null,
    progress: { currentDay: 0, completedDays: 0, totalDays: PLAN_DURATION_DAYS, phaseProgress: '' },
  }

  try {
    await connectDB()
    const plan = await PathwayPlan.findOne({
      userId: new mongoose.Types.ObjectId(userId),
      planType: 'monthly',
    }).sort({ generatedAt: -1 }).lean()

    if (!plan?.dailySchedule || !plan.startDate) return empty

    const now = new Date()
    const start = new Date(plan.startDate)
    const daysDiff = Math.floor((now.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1
    const currentDay = Math.min(Math.max(daysDiff, 1), plan.planDurationDays || PLAN_DURATION_DAYS)
    const completedDays = plan.dailySchedule.filter(d => d.completed).length
    const todaySchedule = plan.dailySchedule.find(d => d.day === currentDay) || null

    const evaluation = await evaluatePhaseTransition(userId)
    const phaseProgress = evaluation.reason

    return {
      plan: {
        planType: plan.planType || 'monthly',
        startDate: plan.startDate.toISOString(),
        endDate: plan.endDate?.toISOString() || '',
        readinessScore: plan.readinessScore,
        currentPhase: (plan.currentPhase as string) || 'assessment',
        tier: (plan.tier as string) || 'free',
        monthLabel: (plan.monthLabel as string) || '',
      },
      today: todaySchedule ? {
        day: todaySchedule.day,
        date: todaySchedule.date,
        theme: todaySchedule.theme,
        phase: todaySchedule.phase || (plan.currentPhase as string) || '',
        tasks: todaySchedule.tasks,
      } : null,
      progress: {
        currentDay,
        completedDays,
        totalDays: plan.planDurationDays || PLAN_DURATION_DAYS,
        phaseProgress,
      },
    }
  } catch (err) {
    logger.error({ err }, 'Failed to get today\'s tasks')
    return empty
  }
}

// ─── Complete a Daily Task ────────────────────────────────────────────────────

export async function completeDailyTask(userId: string, taskId: string): Promise<boolean> {
  try {
    await connectDB()
    const plan = await PathwayPlan.findOne({
      userId: new mongoose.Types.ObjectId(userId),
      planType: 'monthly',
    }).sort({ generatedAt: -1 })

    if (!plan?.dailySchedule) return false

    let found = false
    for (const day of plan.dailySchedule) {
      for (const task of day.tasks) {
        if (task.taskId === taskId && !task.completed) {
          task.completed = true
          task.completedAt = new Date()
          found = true
        }
      }
      if (day.tasks.length > 0 && day.tasks.every(t => t.completed)) {
        day.completed = true
      }
    }

    if (found) await plan.save()
    return found
  } catch (err) {
    logger.error({ err }, 'Failed to complete daily task')
    return false
  }
}
