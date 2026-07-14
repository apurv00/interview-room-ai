import { JobApplication, ProductEvent } from '@shared/db/models'
import { logger } from '@shared/logger'

/**
 * Tracker v1 (PRODUCT_FLOW §2 route table + §4b anti-nag; Wave 4.2).
 *
 * Everything time-derived happens at READ time — no cron:
 * - Nudges (7d "still waiting?", 21d ghost prompt) are computed per row and
 *   never persisted; they render or they don't.
 * - The 35-DAY AUTO-GHOST (founder ruling P-4, 2026-07-14 — DECISIONS #20)
 *   is LAZY: rows at apply_clicked/applied whose last status activity is
 *   >35d old transition to `ghosted` (source:'system') during the tracker
 *   read, in one bulk write. Reversible by construction — the loose machine
 *   allows any user correction, and `ghosted` renders as "No response",
 *   never the g-word.
 * - The next-visit confirm card (anti-nag ask #2 — the return-sheet was
 *   ask #1, but the sheet is EPHEMERAL: closing it persists nothing). The
 *   card therefore owns exactly ONE persisted ask: it surfaces apply_clicked
 *   rows 20h-7d old while askCount is 0, and a single dismissal retires it.
 *   After that the row just reads "Clicked · not confirmed" with one-tap
 *   flip (Codex on #523 — a <2 budget made users dismiss the card twice).
 */

export const GHOST_AFTER_DAYS = 35
const NUDGE_WAITING_DAYS = 7
const NUDGE_GHOST_PROMPT_DAYS = 21
const CONFIRM_MIN_HOURS = 20
const CONFIRM_MAX_DAYS = 7
const CARD_ASK_BUDGET = 1

const GHOSTABLE_STATUSES = ['apply_clicked', 'applied'] as const

export interface TrackerRow {
  jobPostingId: string
  title: string
  company: string
  location: string
  status: string
  daysInStatus: number
  practiceCount: number
  notes?: string
  /** Read-time derived, never persisted. */
  nudge: 'waiting' | 'ghost-prompt' | null
  /** True while the "Clicked · not confirmed" one-tap flip should show. */
  unconfirmedClick: boolean
}

export interface TrackerView {
  groups: Array<{ status: string; count: number; rows: TrackerRow[] }>
  confirmCard: { jobPostingId: string; company: string; clickedAgoHours: number } | null
  autoGhosted: number
}

function lastActivityAt(app: { statusHistory?: Array<{ at: Date | string }>; updatedAt?: Date | string }): Date {
  const hist = app.statusHistory ?? []
  const last = hist.length ? hist[hist.length - 1].at : app.updatedAt
  return last ? new Date(last) : new Date(0)
}

/** Display order: action-needed first, terminal last. */
const GROUP_ORDER = ['interview_scheduled', 'apply_clicked', 'applied', 'saved', 'offer', 'ghosted', 'rejected', 'withdrawn']

export async function getTracker(userId: string, now = new Date()): Promise<TrackerView> {
  const apps = await JobApplication.find({ userId })
    .select('jobPostingId jobSnapshot status statusHistory practiceSessionIds notes outcome updatedAt')
    .sort({ updatedAt: -1 })
    .limit(500)
    .lean()

  // Lazy auto-ghost (P-4): collect crossings, persist in ONE bulk write,
  // then render the post-transition state.
  const toGhost = apps.filter(
    (a) =>
      (GHOSTABLE_STATUSES as readonly string[]).includes(a.status) &&
      now.getTime() - lastActivityAt(a).getTime() > GHOST_AFTER_DAYS * 24 * 3600_000
  )
  if (toGhost.length) {
    await JobApplication.updateMany(
      { _id: { $in: toGhost.map((a) => a._id) }, status: { $in: GHOSTABLE_STATUSES as unknown as string[] } }, // status in filter: never race a fresher move
      {
        $set: { status: 'ghosted', ghostSuggestedAt: now },
        $push: { statusHistory: { status: 'ghosted', at: now, source: 'system' } },
      }
    )
    try {
      await ProductEvent.create({ name: 'jobs.ghost_auto', userId, props: { count: toGhost.length }, ts: now })
    } catch (err) {
      logger.warn({ err }, 'ghost_auto telemetry write failed')
    }
    const ghostedIds = new Set(toGhost.map((a) => String(a._id)))
    for (const a of apps) {
      if (ghostedIds.has(String(a._id))) {
        a.status = 'ghosted'
        a.statusHistory = [...(a.statusHistory ?? []), { status: 'ghosted', at: now, source: 'system' } as never]
      }
    }
  }

  const rows: TrackerRow[] = apps.map((a) => {
    const ageDays = Math.floor((now.getTime() - lastActivityAt(a).getTime()) / (24 * 3600_000))
    const ghostable = (GHOSTABLE_STATUSES as readonly string[]).includes(a.status)
    return {
      jobPostingId: String(a.jobPostingId),
      title: a.jobSnapshot?.title ?? 'Unknown role',
      company: a.jobSnapshot?.company ?? '',
      location: a.jobSnapshot?.location ?? '',
      status: a.status,
      daysInStatus: ageDays,
      practiceCount: Math.min(3, a.practiceSessionIds?.length ?? 0),
      notes: a.notes || undefined,
      nudge: ghostable && ageDays >= NUDGE_GHOST_PROMPT_DAYS ? 'ghost-prompt' : ghostable && ageDays >= NUDGE_WAITING_DAYS ? 'waiting' : null,
      unconfirmedClick: a.status === 'apply_clicked',
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

  return {
    groups,
    confirmCard: candidate
      ? {
          jobPostingId: String(candidate.jobPostingId),
          company: candidate.jobSnapshot?.company ?? 'that job',
          clickedAgoHours: Math.floor((now.getTime() - lastActivityAt(candidate).getTime()) / 3600_000),
        }
      : null,
    autoGhosted: toGhost.length,
  }
}

/** Ask-budget spend for a dismissed confirm card (ask #2 of 2). */
export async function dismissConfirmCard(userId: string, jobPostingId: string): Promise<void> {
  await JobApplication.updateOne({ userId, jobPostingId }, { $inc: { 'outcome.askCount': 1 } })
}

export async function saveNotes(userId: string, jobPostingId: string, notes: string): Promise<boolean> {
  const res = await JobApplication.updateOne({ userId, jobPostingId }, { $set: { notes: notes.slice(0, 2000) } })
  return (res?.matchedCount ?? 0) > 0
}
