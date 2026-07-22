import { JobApplication, JobPosting } from '@shared/db/models'
import { jobPostingStateOf, type JobPostingState } from './postingAccess'
import { INTERVIEW_OUTCOME_CORRECTION_STATUSES } from './outcomeService'
import {
  isJobsAccountActive,
  JobsAccountInactiveError,
  withActiveJobsAccountWrite,
} from '@shared/services/jobsAccountFence'

/**
 * Tracker v1 (PRODUCT_FLOW §2 route table + §4b anti-nag; Wave 4.2).
 *
 * Everything time-derived here happens at READ time and stays read-only:
 * - Nudges (7d "still waiting?", 21d ghost prompt) are computed per row and
 *   never persisted. They apply only after the user confirms `applied`;
 *   `apply_clicked` is a machine fact, not evidence that an application was
 *   submitted, so it never enters response/ghosting logic.
 * - Status inference belongs to an auditable scheduled lifecycle job. A GET
 *   must never append history, reset timestamps, or emit mutation telemetry.
 * - The next-visit confirm card (anti-nag ask #2 — the return-sheet was
 *   ask #1, but the sheet is EPHEMERAL: closing it persists nothing). The
 *   card therefore owns exactly ONE persisted ask: it surfaces apply_clicked
 *   rows 20h-7d old while askCount is 0, and a single dismissal retires it.
 *   After that the row just reads "Clicked · not confirmed" with one-tap
 *   flip (Codex on #523 — a <2 budget made users dismiss the card twice).
 */

// Backward-compatible public name; the scheduled policy owns the threshold.
export { TRACKER_GHOST_AFTER_DAYS as GHOST_AFTER_DAYS } from './trackerStatusSweepService'
const NUDGE_WAITING_DAYS = 7
const NUDGE_GHOST_PROMPT_DAYS = 21
const CONFIRM_MIN_HOURS = 20
const CONFIRM_MAX_DAYS = 7
const CARD_ASK_BUDGET = 1
const OUTCOME_PROMPT_GRACE_MS = 36 * 3600_000
const OUTCOME_RESULTS = new Set(['advanced', 'waiting', 'rejected', 'offer'])
const OUTCOME_CORRECTION_STATUSES = new Set<string>(INTERVIEW_OUTCOME_CORRECTION_STATUSES)

export interface TrackerRow {
  jobPostingId: string
  title: string
  company: string
  location: string
  status: string
  postingState: JobPostingState | 'snapshot-only'
  daysInStatus: number
  practiceCount: number
  interviewDate?: string
  interviewDateConfidence?: 'exact' | 'week' | 'unknown'
  interviewDatePreference?: 'this-week' | 'next-week' | 'unknown'
  notes?: string
  /** Metadata only; the 500-row tracker never selects Tailor text. */
  tailoredResume?: { createdAt: string }
  appliedWith?: { wasTailored: boolean }
  /** Read-time derived, never persisted. */
  nudge: 'waiting' | 'ghost-prompt' | null
  /** True while the "Clicked · not confirmed" one-tap flip should show. */
  unconfirmedClick: boolean
  /** Candidate-authored interview outcome facts only. Readiness and score
   * interpretation deliberately stay out of this projection. */
  outcome: {
    roundsCompleted: number
    latestResult?: 'advanced' | 'waiting' | 'rejected' | 'offer'
    latestRound?: number
    latestReportedAt?: string
    revision: number
    lastInterviewedAt?: string
  }
  /** Round accepted by the outcome endpoint for a scheduled interview. */
  nextOutcomeRound?: number
  /** True only after an exact interview instant has passed by a safe grace. */
  outcomePromptDue: boolean
  /** Corrections require one complete, canonical latest report. */
  canCorrectOutcome: boolean
}

export interface TrackerView {
  groups: Array<{ status: string; count: number; rows: TrackerRow[] }>
  confirmCard: {
    jobPostingId: string
    company: string
    clickedAgoHours: number
    tailoredResume?: { createdAt: string }
  } | null
}

function lastActivityAt(app: { statusHistory?: Array<{ at: Date | string }>; updatedAt?: Date | string }): Date {
  const hist = app.statusHistory ?? []
  const last = hist.length ? hist[hist.length - 1].at : app.updatedAt
  return last ? new Date(last) : new Date(0)
}

function safeNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100 ? value : 0
}

function safePositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 100 ? value : undefined
}

function safePositiveRevision(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function safeOutcomeRevision(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function safeIso(value: unknown): string | undefined {
  if (!value) return undefined
  const date = new Date(value as Date | string)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

/** Display order: action-needed first, terminal last. */
const GROUP_ORDER = ['interview_scheduled', 'interviewed', 'apply_clicked', 'applied', 'saved', 'offer', 'ghosted', 'rejected', 'withdrawn']

export async function getTracker(userId: string, now = new Date()): Promise<TrackerView> {
  const empty = (): TrackerView => ({ groups: [], confirmCard: null })
  if (!(await isJobsAccountActive(userId))) throw new JobsAccountInactiveError(userId)
  const apps = await JobApplication.find({ userId })
    .select('jobPostingId jobSnapshot status statusHistory appliedAt appliedWith.wasTailored tailoredVersion.createdAt verifiedPracticeSessionIds interviewDate interviewDateConfidence interviewDatePreference notes outcome updatedAt')
    .sort({ updatedAt: -1 })
    .limit(500)
    .lean()
  // One bounded batch keeps lifecycle separate from application status and
  // avoids an N+1 lookup for up to 500 tracker rows. A missing retained post
  // becomes snapshot-only rather than breaking the user's tracker link.
  const postings = apps.length
    ? await JobPosting.find({ _id: { $in: apps.map((app) => app.jobPostingId) } })
        .select('_id status closedReason')
        .lean()
    : []
  const postingStateById = new Map(
    postings.map((posting) => [String(posting._id), jobPostingStateOf(posting)]),
  )

  const rows: TrackerRow[] = apps.map((a) => {
    const ageDays = Math.floor((now.getTime() - lastActivityAt(a).getTime()) / (24 * 3600_000))
    const responseNudgeEligible = a.status === 'applied' && !!a.appliedAt
    const postingState = postingStateById.get(String(a.jobPostingId)) ?? 'snapshot-only'
    const canNudgePreparation = postingState === 'live' || postingState === 'archived'
    const rawOutcome = a.outcome as typeof a.outcome & {
      interviewRounds?: unknown
      latestResult?: unknown
      latestRound?: unknown
      latestReportedAt?: unknown
      revision?: unknown
      lastInterviewedAt?: unknown
      lastDeferredRound?: unknown
    }
    const roundsCompleted = safeNonNegativeInteger(rawOutcome?.interviewRounds)
    const candidateLatestResult = OUTCOME_RESULTS.has(String(rawOutcome?.latestResult))
      ? rawOutcome?.latestResult as 'advanced' | 'waiting' | 'rejected' | 'offer'
      : undefined
    const candidateLatestRound = safePositiveInteger(rawOutcome?.latestRound)
    const candidateLatestReportedAt = safeIso(rawOutcome?.latestReportedAt)
    const outcomeRevision = safeOutcomeRevision(rawOutcome?.revision)
    const candidateRevision = safePositiveRevision(outcomeRevision)
    const lastInterviewedAt = safeIso(rawOutcome?.lastInterviewedAt)
    const hasCanonicalOutcome = !!candidateLatestResult &&
      !!candidateLatestRound &&
      candidateLatestRound === roundsCompleted &&
      !!candidateLatestReportedAt &&
      !!candidateRevision
    const canCorrectOutcome = hasCanonicalOutcome &&
      OUTCOME_CORRECTION_STATUSES.has(a.status)
    const nextOutcomeRound = a.status === 'interview_scheduled' && roundsCompleted < 100
      ? roundsCompleted + 1
      : undefined
    const exactInterviewAt = a.interviewDateConfidence === 'exact' && a.interviewDate
      ? new Date(a.interviewDate).getTime()
      : Number.NaN
    const outcomePromptDue = nextOutcomeRound !== undefined &&
      Number.isFinite(exactInterviewAt) &&
      now.getTime() >= exactInterviewAt + OUTCOME_PROMPT_GRACE_MS &&
      safePositiveInteger(rawOutcome?.lastDeferredRound) !== nextOutcomeRound
    return {
      jobPostingId: String(a.jobPostingId),
      title: a.jobSnapshot?.title ?? 'Unknown role',
      company: a.jobSnapshot?.company ?? '',
      location: a.jobSnapshot?.location ?? '',
      status: a.status,
      postingState,
      daysInStatus: ageDays,
      practiceCount: Math.min(3, a.verifiedPracticeSessionIds?.length ?? 0),
      interviewDate: a.interviewDate ? new Date(a.interviewDate).toISOString() : undefined,
      interviewDateConfidence: a.interviewDateConfidence,
      interviewDatePreference: a.interviewDatePreference,
      notes: a.notes || undefined,
      ...(canNudgePreparation && a.tailoredVersion?.createdAt
        ? { tailoredResume: { createdAt: new Date(a.tailoredVersion.createdAt).toISOString() } }
        : {}),
      ...(a.appliedWith
        ? { appliedWith: { wasTailored: a.appliedWith.wasTailored } }
        : {}),
      nudge: canNudgePreparation && responseNudgeEligible && ageDays >= NUDGE_GHOST_PROMPT_DAYS ? 'ghost-prompt' : canNudgePreparation && responseNudgeEligible && ageDays >= NUDGE_WAITING_DAYS ? 'waiting' : null,
      unconfirmedClick: a.status === 'apply_clicked',
      outcome: {
        roundsCompleted,
        revision: outcomeRevision,
        ...(hasCanonicalOutcome
          ? {
              latestResult: candidateLatestResult,
              latestRound: candidateLatestRound,
              latestReportedAt: candidateLatestReportedAt,
            }
          : {}),
        ...(lastInterviewedAt ? { lastInterviewedAt } : {}),
      },
      ...(nextOutcomeRound !== undefined ? { nextOutcomeRound } : {}),
      outcomePromptDue,
      canCorrectOutcome,
    }
  })

  const groups = GROUP_ORDER.filter((status) => rows.some((r) => r.status === status)).map((status) => {
    const groupRows = rows.filter((r) => r.status === status)
    return { status, count: groupRows.length, rows: groupRows }
  })

  // Confirm card (ask #2): the freshest eligible clicked row.
  const candidate = apps
    .filter((a) => {
      if (a.status !== 'apply_clicked') return false
      if ((a.outcome?.askCount ?? 0) >= CARD_ASK_BUDGET) return false
      const ageMs = now.getTime() - lastActivityAt(a).getTime()
      return ageMs >= CONFIRM_MIN_HOURS * 3600_000 && ageMs <= CONFIRM_MAX_DAYS * 24 * 3600_000
    })
    .sort((a, b) => lastActivityAt(b).getTime() - lastActivityAt(a).getTime())[0]

  const view = {
    groups,
    confirmCard: candidate
      ? {
          jobPostingId: String(candidate.jobPostingId),
          company: candidate.jobSnapshot?.company ?? 'that job',
          clickedAgoHours: Math.floor((now.getTime() - lastActivityAt(candidate).getTime()) / 3600_000),
          ...((postingStateById.get(String(candidate.jobPostingId)) === 'live' ||
            postingStateById.get(String(candidate.jobPostingId)) === 'archived') &&
            candidate.tailoredVersion?.createdAt
            ? { tailoredResume: { createdAt: new Date(candidate.tailoredVersion.createdAt).toISOString() } }
            : {}),
        }
      : null,
  }
  // Do not serve a stale in-memory tracker snapshot after deletion started
  // while this read was assembling its bounded posting join.
  return (await isJobsAccountActive(userId)) ? view : empty()
}

/** Ask-budget spend for a dismissed confirm card (ask #2 of 2). */
export async function dismissConfirmCard(userId: string, jobPostingId: string): Promise<void> {
  await withActiveJobsAccountWrite(userId, (session) =>
    JobApplication.updateOne(
      { userId, jobPostingId },
      { $inc: { 'outcome.askCount': 1 } },
      { session },
    ),
  )
}

export async function saveNotes(userId: string, jobPostingId: string, notes: string): Promise<boolean> {
  const res = await withActiveJobsAccountWrite(userId, (session) =>
    JobApplication.updateOne(
      { userId, jobPostingId },
      { $set: { notes: notes.slice(0, 2000) } },
      { session },
    ),
  )
  return (res?.matchedCount ?? 0) > 0
}
