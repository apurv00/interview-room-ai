import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { DrillAttempt } from '@shared/db/models/DrillAttempt'
import { aiLogger as logger } from '@shared/logger'
import type { AnswerEvaluation } from '@shared/types'

export interface WeakQuestion {
  sessionId: string
  questionIndex: number
  question: string
  answer: string
  avgScore: number
  relevance: number
  structure: number
  specificity: number
  ownership: number
  competency: string
  sessionDate: string
}

export interface DrillResult {
  questionIndex: number
  question: string
  originalScore: number
  newScore: number
  delta: number
  breakdown: {
    relevance: number
    structure: number
    specificity: number
    ownership: number
  }
}

export interface DrillHistoryEntry {
  id: string
  question: string
  originalScore: number
  newScore: number
  delta: number
  competency: string
  createdAt: string
}

/**
 * Get questions where user scored poorly (avg < 60).
 */
export async function getWeakQuestions(
  userId: string,
  limit = 10,
  competency?: string,
): Promise<WeakQuestion[]> {
  try {
    await connectDB()

    const sessions = await InterviewSession.find({
      userId: new mongoose.Types.ObjectId(userId),
      status: 'completed',
    })
      .sort({ createdAt: -1 })
      .limit(20)
      .select('evaluations createdAt config')
      .lean()

    const weak: WeakQuestion[] = []

    for (const session of sessions) {
      const evals = (session.evaluations || []) as AnswerEvaluation[]
      for (const ev of evals) {
        const avg = Math.round(
          (ev.relevance + ev.structure + ev.specificity + ev.ownership) / 4
        )
        if (avg >= 60) continue

        // Determine weakest competency
        const scores = {
          relevance: ev.relevance,
          structure: ev.structure,
          specificity: ev.specificity,
          ownership: ev.ownership,
        }
        const weakestDim = Object.entries(scores)
          .sort((a, b) => a[1] - b[1])[0][0]

        if (competency && weakestDim !== competency) continue

        weak.push({
          sessionId: session._id.toString(),
          questionIndex: ev.questionIndex,
          question: ev.question,
          answer: ev.answer,
          avgScore: avg,
          relevance: ev.relevance,
          structure: ev.structure,
          specificity: ev.specificity,
          ownership: ev.ownership,
          competency: weakestDim,
          sessionDate: session.createdAt.toISOString(),
        })
      }
    }

    // Sort by score ascending (weakest first), then deduplicate by question text
    const seen = new Set<string>()
    const deduped = weak
      .sort((a, b) => a.avgScore - b.avgScore)
      .filter(q => {
        const key = q.question.toLowerCase().trim()
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

    return deduped.slice(0, limit)
  } catch (err) {
    logger.error({ err }, 'Failed to get weak questions')
    return []
  }
}

/**
 * Save a drill attempt result.
 */
export async function saveDrillAttempt(
  userId: string,
  data: {
    sessionId: string
    questionIndex: number
    question: string
    originalAnswer: string
    originalScore: number
    newAnswer: string
    newScore: number
    competency: string
  },
): Promise<DrillResult> {
  await connectDB()

  const delta = data.newScore - data.originalScore

  await DrillAttempt.create({
    userId: new mongoose.Types.ObjectId(userId),
    sessionId: new mongoose.Types.ObjectId(data.sessionId),
    questionIndex: data.questionIndex,
    question: data.question,
    originalAnswer: data.originalAnswer,
    originalScore: data.originalScore,
    newAnswer: data.newAnswer,
    newScore: data.newScore,
    delta,
    competency: data.competency,
  })

  return {
    questionIndex: data.questionIndex,
    question: data.question,
    originalScore: data.originalScore,
    newScore: data.newScore,
    delta,
    breakdown: {
      relevance: 0,
      structure: 0,
      specificity: 0,
      ownership: 0,
    },
  }
}

/**
 * Get recent drill attempts for a user.
 */
export async function getDrillHistory(
  userId: string,
  limit = 20,
): Promise<DrillHistoryEntry[]> {
  try {
    await connectDB()

    const attempts = await DrillAttempt.find({
      userId: new mongoose.Types.ObjectId(userId),
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()

    return attempts.map(a => ({
      id: a._id.toString(),
      question: a.question,
      originalScore: a.originalScore,
      newScore: a.newScore,
      delta: a.delta,
      competency: a.competency,
      createdAt: a.createdAt.toISOString(),
    }))
  } catch (err) {
    logger.error({ err }, 'Failed to get drill history')
    return []
  }
}
