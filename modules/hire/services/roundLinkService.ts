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
    // A failed evaluation carries FABRICATED fallback dimensions (the engine
    // persists placeholders like 60/55/55/60 and its own aggregates exclude
    // status:'failed' rows — G.4). Publishing them as hiring evidence would
    // mislead a decision: keep the row for visibility (question + answer),
    // but suppress every number (Codex P1 on #604).
    const failed = e.status === 'failed'
    const dims = failed
      ? []
      : [
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
      relevance: failed ? null : numberOrNull(e.relevance),
      structure: failed ? null : numberOrNull(e.structure),
      specificity: failed ? null : numberOrNull(e.specificity),
      ownership: failed ? null : numberOrNull(e.ownership),
      jdAlignment: failed ? null : numberOrNull(e.jdAlignment),
      flags: Array.isArray(e.flags) ? (e.flags as string[]) : undefined,
      ...(failed ? { evaluationFailed: true } : {}),
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
    // Refresh a linked-but-pending snapshot once feedback lands. The
    // completedAfterRevoke flag is round-derived state, not session state —
    // preserve it across the rebuild.
    if (round.sessionId && round.results?.pending) {
      const session = (await InterviewSession.findById(round.sessionId)
        .select(SESSION_SELECT)
        .lean()) as EngineSessionLean | null
      if (session?.feedback) {
        await HireRound.updateOne(
          { _id: round._id, workspaceId },
          {
            $set: {
              results: {
                ...buildResultsSnapshot(session),
                ...(round.results?.completedAfterRevoke ? { completedAfterRevoke: true } : {}),
              },
            },
          }
        )
      }
    }
    if (!round.guestUserId || !round.preparedAt) continue

    const sessions = (await InterviewSession.find({
      userId: round.guestUserId,
      createdAt: { $gte: round.preparedAt },
      status: { $in: ['completed', 'in_progress'] },
    })
      .sort({ createdAt: 1 })
      .select(SESSION_SELECT)
      .lean()) as unknown as EngineSessionLean[]

    // jdHash embeds the per-round reference line (buildJdSnapshot), so a
    // session can only match the ONE round that provisioned it — identical
    // JDs across rounds or workspaces can never cross-claim.
    const matches = sessions.filter(
      (s) =>
        s.config?.role === round.config.role &&
        sha256(s.jobDescription ?? '') === round.jdHash
    )

    // Attempt visibility: every engine session this round's config produced
    // counts, completed or not, and counting continues even after a session
    // has been linked (a second device holding the prepared config can start
    // another run post-link). >1 is surfaced on the card, never absorbed.
    if (matches.length > 0 && matches.length !== (round.attemptCount ?? 0)) {
      await HireRound.updateOne(
        { _id: round._id, workspaceId },
        { $set: { attemptCount: matches.length } }
      )
    }
    if (round.sessionId) continue

    // Revoked rounds are still reconciled: without an engine-side handoff
    // check (flagged first-class seam), a guest who reached the lobby before
    // revocation can complete the interview anyway. Skipping it would leave
    // that completed session and its cost silently untracked — instead the
    // results are attached FLAGGED, and the round stays revoked; the
    // workspace decides what the flagged result is worth.
    const revoked = !!round.revokedAt || round.status === 'revoked'

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
              results: {
                ...buildResultsSnapshot(s),
                ...(revoked ? { completedAfterRevoke: true } : {}),
              },
              ...(revoked ? {} : { status: 'completed' as const }),
            },
            $unset: { live: 1 },
          },
          { new: true }
        )
        if (claimed) {
          linked = true
          await appendApplicationEvent(workspaceId, applicationId, {
            type: 'ai_result_linked',
            actorName: 'System',
            note: revoked
              ? 'AI interview completed AFTER the link was revoked — results attached flagged'
              : 'AI interview completed — results attached',
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
