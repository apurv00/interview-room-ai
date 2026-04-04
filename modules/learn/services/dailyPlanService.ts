import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { PathwayPlan, User } from '@shared/db/models'
import type { PracticeTask } from '@shared/db/models/PathwayPlan'
import { getUserCompetencySummary, getUserWeaknesses } from './competencyService'
import { getDueCompetencies } from './spacedRepetitionService'
import { logger } from '@shared/logger'

// ─── Types ────────────────────────────────────────────────────────────────────

interface DailyScheduleDay {
  day: number
  date: string
  theme: string
  tasks: PracticeTask[]
  completed: boolean
}

interface TodayResult {
  plan: { planType: string; startDate: string; endDate: string; readinessScore: number } | null
  today: { day: number; date: string; theme: string; tasks: PracticeTask[] } | null
  progress: { currentDay: number; completedDays: number; totalDays: number }
}

// ─── Themes by phase ──────────────────────────────────────────────────────────

const PHASE_CONFIG = [
  { days: [1, 2, 3], theme: 'Foundation', difficulty: 'easy' as const, taskType: 'drill' as const },
  { days: [4, 5, 6, 7], theme: 'Building', difficulty: 'medium' as const, taskType: 'full_session' as const },
  { days: [8, 9, 10, 11], theme: 'Intensity', difficulty: 'hard' as const, taskType: 'full_session' as const },
  { days: [12, 13, 14], theme: 'Polish', difficulty: 'medium' as const, taskType: 'full_session' as const },
]

function getPhaseForDay(day: number) {
  return PHASE_CONFIG.find(p => p.days.includes(day)) || PHASE_CONFIG[0]
}

function generateTaskId(day: number, idx: number): string {
  return `day${day}_task${idx}_${Math.random().toString(36).slice(2, 8)}`
}

// ─── Generate 14-Day Plan ─────────────────────────────────────────────────────

export async function generate14DayPlan(
  userId: string,
  domain: string,
  interviewType: string = 'screening',
  experience: string = '3-6'
): Promise<typeof PathwayPlan.prototype | null> {
  try {
    await connectDB()

    const [profile, competencySummary, weaknesses, dueCompetencies] = await Promise.all([
      User.findById(userId).select('interviewGoal targetRole weakAreas').lean(),
      getUserCompetencySummary(userId, domain),
      getUserWeaknesses(userId, 6),
      getDueCompetencies(userId, domain),
    ])

    const weakAreas = competencySummary?.weakAreas || []
    const strongAreas = competencySummary?.strongAreas || []
    const readinessScore = competencySummary?.overallReadiness || 40

    // Build 14-day schedule
    const startDate = new Date()
    const endDate = new Date(startDate.getTime() + 14 * 24 * 60 * 60 * 1000)
    const dailySchedule: DailyScheduleDay[] = []

    for (let day = 1; day <= 14; day++) {
      const dayDate = new Date(startDate.getTime() + (day - 1) * 24 * 60 * 60 * 1000)
      const phase = getPhaseForDay(day)
      const tasks: PracticeTask[] = []

      // Pick target competency for the day (rotate through weak areas, then due, then strong)
      const targetIdx = (day - 1) % Math.max(weakAreas.length, 1)
      const targetCompetency = weakAreas[targetIdx] || 'general'

      // Check if any SR-due competency should be prioritized today
      const dueToday = dueCompetencies.find(d =>
        d.urgency === 'overdue_critical' || d.urgency === 'due_today'
      )
      const primaryCompetency = dueToday?.competencyName || targetCompetency

      if (phase.theme === 'Foundation') {
        // Easy drills on weakest competencies
        tasks.push({
          taskId: generateTaskId(day, 0),
          type: 'drill',
          title: `Quick drill: ${primaryCompetency}`,
          description: `Practice a focused ${primaryCompetency} drill for ${domain}. Answer 2-3 targeted questions.`,
          targetCompetency: primaryCompetency,
          difficulty: 'easy',
          estimatedMinutes: 10,
          completed: false,
        })
        if (day <= 2) {
          tasks.push({
            taskId: generateTaskId(day, 1),
            type: 'review',
            title: 'Review common patterns',
            description: `Review common ${interviewType} question patterns for ${domain}. Take notes on your approach.`,
            targetCompetency: 'general',
            difficulty: 'easy',
            estimatedMinutes: 10,
            completed: false,
          })
        }
      } else if (phase.theme === 'Building') {
        // 10-min interview sessions + targeted drills
        tasks.push({
          taskId: generateTaskId(day, 0),
          type: 'full_session',
          title: `10-min ${interviewType} practice`,
          description: `Complete a 10-minute ${interviewType} interview focusing on ${primaryCompetency}.`,
          targetCompetency: primaryCompetency,
          difficulty: 'medium',
          estimatedMinutes: 15,
          completed: false,
        })
        if (day % 2 === 0) {
          tasks.push({
            taskId: generateTaskId(day, 1),
            type: 'drill',
            title: `Targeted drill: ${weakAreas[1] || primaryCompetency}`,
            description: `Short drill on ${weakAreas[1] || primaryCompetency} to reinforce learning.`,
            targetCompetency: weakAreas[1] || primaryCompetency,
            difficulty: 'medium',
            estimatedMinutes: 10,
            completed: false,
          })
        }
      } else if (phase.theme === 'Intensity') {
        // 20-min sessions + weak area review
        tasks.push({
          taskId: generateTaskId(day, 0),
          type: 'full_session',
          title: `20-min deep practice`,
          description: `Complete a 20-minute ${interviewType} interview. Focus on providing structured, specific answers.`,
          targetCompetency: primaryCompetency,
          difficulty: 'hard',
          estimatedMinutes: 25,
          completed: false,
        })
      } else {
        // Polish: 30-min mock interviews + confidence
        tasks.push({
          taskId: generateTaskId(day, 0),
          type: 'full_session',
          title: day === 14 ? 'Final mock interview' : `30-min mock interview`,
          description: day === 14
            ? `Your final practice session! Treat this like the real interview. Full 30 minutes.`
            : `Full-length mock interview. Practice your timing and confidence.`,
          targetCompetency: 'general',
          difficulty: 'medium',
          estimatedMinutes: 35,
          completed: false,
        })
        if (day === 13) {
          tasks.push({
            taskId: generateTaskId(day, 1),
            type: 'homework',
            title: 'Prepare your stories',
            description: 'Review your best STAR stories. Prepare 3 stories you can adapt to any question.',
            targetCompetency: 'structure',
            difficulty: 'easy',
            estimatedMinutes: 15,
            completed: false,
          })
        }
      }

      dailySchedule.push({
        day,
        date: dayDate.toISOString().split('T')[0],
        theme: phase.theme,
        tasks,
        completed: false,
      })
    }

    // Flatten tasks for the practiceTasks field (backward compat)
    const allTasks = dailySchedule.flatMap(d => d.tasks)

    const plan = await PathwayPlan.findOneAndUpdate(
      { userId: new mongoose.Types.ObjectId(userId) },
      {
        userId: new mongoose.Types.ObjectId(userId),
        planType: '14_day',
        startDate,
        endDate,
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
          reason: 'Based on your 14-day plan progression',
        },
        generatedAt: new Date(),
        userGoal: (profile?.interviewGoal as string) || '',
        targetRole: (profile?.targetRole as string) || domain,
      },
      { upsert: true, new: true }
    )

    return plan
  } catch (err) {
    logger.error({ err }, 'Failed to generate 14-day plan')
    return null
  }
}

// ─── Get Today's Tasks ────────────────────────────────────────────────────────

export async function getTodaysTasks(userId: string): Promise<TodayResult> {
  const empty: TodayResult = { plan: null, today: null, progress: { currentDay: 0, completedDays: 0, totalDays: 14 } }

  try {
    await connectDB()
    const plan = await PathwayPlan.findOne({
      userId: new mongoose.Types.ObjectId(userId),
      planType: '14_day',
    }).sort({ generatedAt: -1 }).lean()

    if (!plan?.dailySchedule || !plan.startDate) return empty

    const now = new Date()
    const start = new Date(plan.startDate)
    const daysDiff = Math.floor((now.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1
    const currentDay = Math.min(Math.max(daysDiff, 1), 14)
    const completedDays = plan.dailySchedule.filter(d => d.completed).length
    const todaySchedule = plan.dailySchedule.find(d => d.day === currentDay) || null

    return {
      plan: {
        planType: plan.planType || '14_day',
        startDate: plan.startDate.toISOString(),
        endDate: plan.endDate?.toISOString() || '',
        readinessScore: plan.readinessScore,
      },
      today: todaySchedule ? {
        day: todaySchedule.day,
        date: todaySchedule.date,
        theme: todaySchedule.theme,
        tasks: todaySchedule.tasks,
      } : null,
      progress: { currentDay, completedDays, totalDays: 14 },
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
      planType: '14_day',
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
      // Mark day as completed if all tasks done
      if (day.tasks.length > 0 && day.tasks.every(t => t.completed)) {
        day.completed = true
      }
    }

    if (found) {
      await plan.save()
    }

    return found
  } catch (err) {
    logger.error({ err }, 'Failed to complete daily task')
    return false
  }
}
