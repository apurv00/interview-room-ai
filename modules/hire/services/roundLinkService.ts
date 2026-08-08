import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models'
import { logger } from '@shared/logger'
import {
  HireRound,
  type HireRoundResults,
  type HireRoundPerQuestion,
  type IHireRound,
} from '../models'
import { sha256 } from './aiRoundService'
import { appendApplicationEvent } from './pipelineService'

/**
 * Completion-event seam, hire side — READ-ONLY against the engine.
 *
 * The engine has no completion hook today (adding one means editing engine
 * files — flagged, not done; see the Phase 1 PR). Instead, the reliable actor
 * who already wants fresh results — the member opening the candidate card —
 * triggers reconciliation: find the engine session the guest's interview
 * created, claim it atomically, and snapshot its results keyed to the round.
 *
 * Match rule (deterministic by construction):
 *   userId    = round.guestUserId      — the User THIS round's OTP flow bound
 *   createdAt ≥ round.preparedAt       — the window this round's prepare opened
 *   config.role and sha256(jobDescription) equal the round's stamped values
 *   session not already claimed        — unique sparse index on sessionId
 * Ambiguity is only possible when one candidate has two live rounds with a
 * byte-identical JD and title; claims are ordered oldest-session-first and
 * anything unclaimed stays visibly "awaiting results" — never silently wrong.
 */

const SESSION_SELECT =
  '_id status config jobDescription feedback evaluations answeredCount plannedQuestionCount endReason completedAt createdAt'

interface EngineSessionLean {
  _id: { toString(): string }
  status: string
  config?: { role?: string }
  jobDescription?: string
  feedback?: Record<string, unknown> | null
  evaluations?: Array<Record<string, unknown>> | null
  answeredCount?: number | null
  plannedQuestionCount?: number | null
  endReason?: string | null
  completedAt?: Date | null
  createdAt: Date
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export function buildResultsSnapshot(session: EngineSessionLean): HireRoundResults {
  const feedback = (session.feedback ?? null) as {
    overall_score?: unknown
    pass_probability?: unknown
    confidence_level?: unknown
    dimensions?: {
      answer_quality?: { score?: unknown }
      communication?: { score?: unknown }
    }
    jd_match_score?: unknown
    red_flags?: unknown
    top_3_improvements?: unknown
  } | null

  const perQuestion: HireRoundPerQuestion[] = (session.evaluations ?? []).map((e) => {
    const dims = [
      numberOrNull(e.relevance),
      numberOrNull(e.structure),
      numberOrNull(e.specificity),
      numberOrNull(e.ownership),
    ].filter((n): n is number => n !== null)
    return {
      questionIndex: numberOrNull(e.questionIndex) ?? 0,
      question: typeof e.question === 'string' ? e.question : '',
      answer: typeof e.answer === 'string' ? e.answer : undefined,
      answerSummary: typeof e.answerSummary === 'string' ? e.answerSummary : undefined,
      score: dims.length ? Math.round(dims.reduce((a, b) => a + b, 0) / dims.length) : null,
      relevance: numberOrNull(e.relevance),
      structure: numberOrNull(e.structure),
      specificity: numberOrNull(e.specificity),
      ownership: numberOrNull(e.ownership),
      jdAlignment: numberOrNull(e.jdAlignment),
      flags: Array.isArray(e.flags) ? (e.flags as string[]) : undefined,
    }
  })

  return {
    overallScore: numberOrNull(feedback?.overall_score),
    passProbability:
      typeof feedback?.pass_probability === 'string' ? feedback.pass_probability : undefined,
    confidenceLevel:
      typeof feedback?.confidence_level === 'string' ? feedback.confidence_level : undefined,
    answerQualityScore: numberOrNull(feedback?.dimensions?.answer_quality?.score),
    communicationScore: numberOrNull(feedback?.dimensions?.communication?.score),
    jdMatchScore: numberOrNull(feedback?.jd_match_score),
    redFlags: Array.isArray(feedback?.red_flags) ? (feedback.red_flags as string[]) : undefined,
    topImprovements: Array.isArray(feedback?.top_3_improvements)
      ? (feedback.top_3_improvements as string[])
      : undefined,
    answeredCount: numberOrNull(session.answeredCount),
    plannedQuestionCount: numberOrNull(session.plannedQuestionCount),
    endReason: typeof session.endReason === 'string' ? session.endReason : null,
    perQuestion,
    // Completed session but session-level feedback not generated yet (the
    // guest may have closed the tab before the feedback page ran) — surfaced
    // as pending and refreshed on later reads, never silently zero.
    pending: !feedback,
    sessionCompletedAt: session.completedAt ?? undefined,
  }
}

export interface RoundActivity {
  roundId: string
  inProgress: boolean
}

/**
 * Reconcile all AI rounds of one application. Returns transient activity info
 * (e.g. "interview in progress right now") the card can show but that is
 * deliberately not persisted.
 */
export async function reconcileApplicationRounds(
  workspaceId: string,
  applicationId: string
): Promise<RoundActivity[]> {
  await connectDB()
  const rounds = await HireRound.find({ workspaceId, applicationId, kind: 'ai' })
  const activity: RoundActivity[] = []

  for (const round of rounds) {
    if (round.status === 'revoked') continue

    // Refresh a linked-but-pending snapshot once feedback lands.
    if (round.sessionId && round.results?.pending) {
      const session = (await InterviewSession.findById(round.sessionId)
        .select(SESSION_SELECT)
        .lean()) as EngineSessionLean | null
      if (session?.feedback) {
        await HireRound.updateOne(
          { _id: round._id, workspaceId },
          { $set: { results: buildResultsSnapshot(session) } }
        )
      }
      continue
    }
    if (round.sessionId || !round.guestUserId || !round.preparedAt) continue

    const sessions = (await InterviewSession.find({
      userId: round.guestUserId,
      createdAt: { $gte: round.preparedAt },
      status: { $in: ['completed', 'in_progress'] },
    })
      .sort({ createdAt: 1 })
      .select(SESSION_SELECT)
      .lean()) as unknown as EngineSessionLean[]

    const matches = sessions.filter(
      (s) =>
        s.config?.role === round.config.role &&
        sha256(s.jobDescription ?? '') === round.jdHash
    )

    let linked = false
    for (const s of matches) {
      if (s.status !== 'completed') continue
      try {
        const claimed = await HireRound.findOneAndUpdate(
          { _id: round._id, workspaceId, sessionId: { $exists: false } },
          {
            $set: {
              sessionId: s._id,
              linkedAt: new Date(),
              status: 'completed',
              results: buildResultsSnapshot(s),
            },
          },
          { new: true }
        )
        if (claimed) {
          linked = true
          await appendApplicationEvent(workspaceId, applicationId, {
            type: 'ai_result_linked',
            actorName: 'System',
            note: 'AI interview completed — results attached',
          })
        }
        break
      } catch (err: unknown) {
        // E11000 on the unique sparse sessionId index: another round claimed
        // this session in a race — try the next candidate session.
        if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) {
          logger.warn(
            { roundId: round._id.toString(), sessionId: s._id.toString() },
            'hire: session already claimed by another round — trying next match'
          )
          continue
        }
        throw err
      }
    }

    if (!linked && matches.some((s) => s.status === 'in_progress')) {
      activity.push({ roundId: round._id.toString(), inProgress: true })
    }
  }
  return activity
}

export type { IHireRound }
