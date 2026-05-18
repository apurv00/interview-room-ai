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
  /**
   * Number of past attempts on the same (normalized) question across
   * the user's interview history. Always >= 1. The cluster surfaced
   * here is the WORST-scoring attempt (lowest avg). Used by the
   * drill-list UI to show a "N attempts" chip when > 1 so users
   * know the question was clubbed. E1 on the drill-mode improvements.
   */
  attemptCount: number
}

/**
 * Aggressive normalization for cluster-key matching:
 *   1. Lowercase
 *   2. Drop apostrophes entirely so contractions collapse with their
 *      stripped form ("what's" matches "whats")
 *   3. Replace anything that isn't a Unicode letter, number, or
 *      whitespace with a space — so trailing punctuation and
 *      surrounding quotes don't split clusters ("...led a team." vs
 *      "...led a team"). Uses `\p{L}\p{N}` with the `u` flag so
 *      accented Latin ("São Paulo", "naïve") and non-Latin scripts
 *      (CJK, Cyrillic, Arabic, Devanagari) survive — the prior
 *      `\w` was ASCII-only and would collapse every non-Latin
 *      question to the empty string, dedup'ing all of them into a
 *      single survivor (Codex P1 on PR #394).
 *   4. Collapse whitespace runs + trim
 *
 * Implementation note: built via `new RegExp(...)` instead of a
 * literal so the `u`-flag check (TS1501 — only available at es6+)
 * isn't triggered by the parser. The tsconfig doesn't set a `target`,
 * which defaults to ES3 for the literal check. Bumping `target` for
 * the whole project is a much bigger surface than this one regex
 * needs.
 */
const NON_LETTER_NUMBER_OR_SPACE_RE = new RegExp('[^\\p{L}\\p{N}\\s]', 'gu')

function normalizeQuestionForDedup(q: string): string {
  return q
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(NON_LETTER_NUMBER_OR_SPACE_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
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
  /**
   * Pathway P2 Wave 5 — per-dimension breakdown, present only on rows
   * persisted after the schema upgrade. Old rows fall back to avg
   * delta (`delta` field) in downstream UI.
   */
  breakdown?: {
    relevance: number
    structure: number
    specificity: number
    ownership: number
  }
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
          // Filled in by the cluster pass below.
          attemptCount: 1,
        })
      }
    }

    // Cluster by normalized question text. Two-pass:
    //   1. Build counts per cluster (every weak attempt contributes,
    //      so the count reflects the user's full attempt history).
    //   2. Sort by avgScore ASC and keep the FIRST seen attempt per
    //      cluster — the worst-scoring one, which matches the
    //      practice-mode mental model ("drill where I'm weakest").
    //      Stamp the cluster's full count onto the survivor.
    const counts = new Map<string, number>()
    for (const q of weak) {
      const key = normalizeQuestionForDedup(q.question)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }

    const seen = new Set<string>()
    const deduped: WeakQuestion[] = []
    for (const q of weak.sort((a, b) => a.avgScore - b.avgScore)) {
      const key = normalizeQuestionForDedup(q.question)
      if (seen.has(key)) continue
      seen.add(key)
      deduped.push({ ...q, attemptCount: counts.get(key) ?? 1 })
    }

    return deduped.slice(0, limit)
  } catch (err) {
    logger.error({ err }, 'Failed to get weak questions')
    return []
  }
}

/**
 * Save a drill attempt result.
 *
 * Wave 5 — `breakdown` is now persisted (previously only `delta`
 * survived; per-dim scores were thrown away after the avg rolled up
 * into `newScore`). Field is optional so callers that haven't been
 * updated yet still work, but the evaluate route DOES pass it.
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
    breakdown?: {
      relevance: number
      structure: number
      specificity: number
      ownership: number
    }
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
    ...(data.breakdown && { breakdown: data.breakdown }),
  })

  return {
    questionIndex: data.questionIndex,
    question: data.question,
    originalScore: data.originalScore,
    newScore: data.newScore,
    delta,
    breakdown: data.breakdown ?? {
      relevance: 0,
      structure: 0,
      specificity: 0,
      ownership: 0,
    },
  }
}

/**
 * Get recent drill attempts for a user.
 *
 * Wave 5 — optional `competency` filter so callers can ask "show me
 * just the relevance drills" without pulling everything and filtering
 * client-side. The new `/api/learn/drill/history` route uses this for
 * `DeltaContextNote`'s "average delta on relevance" trend, and the
 * filter happens in Mongo so the limit applies to the post-filter
 * count (otherwise the limit was being spent on irrelevant rows).
 */
export async function getDrillHistory(
  userId: string,
  limit = 20,
  competency?: string,
): Promise<DrillHistoryEntry[]> {
  try {
    await connectDB()

    const filter: Record<string, unknown> = {
      userId: new mongoose.Types.ObjectId(userId),
    }
    if (competency) filter.competency = competency

    const attempts = await DrillAttempt.find(filter)
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
      // Wave 5 — backwards-compat: old rows lack `breakdown`; pass
      // through `undefined` so UI consumers know to fall back to
      // avg-only trend rather than rendering a zero row.
      ...(a.breakdown && { breakdown: a.breakdown }),
    }))
  } catch (err) {
    logger.error({ err }, 'Failed to get drill history')
    return []
  }
}
