import { inngest } from '@shared/services/inngest'
import { connectDB } from '@shared/db/connection'
import { JobApplication, JobPosting, JobsEmailConfig, JobsEmailSend, User, InterviewSession } from '@shared/db/models'
import { logger } from '@shared/logger'
import { buildE0Email } from '../emails/e0'
import { buildE2Email } from '../emails/e2'
import { buildE1Email, buildE4Email } from '../emails/e1'
import { buildFooterUrls, sendTransactional, sendSolicitation, solicitationSentLast7d, isSuppressed } from '../services/emailSendService'
import { mintActionToken } from '@shared/services/signedActionToken'
import { isInSendWindow, nextSendSlot, e2SendInstant, istCalendarDaysBetween } from '../config/emailTiming'

/**
 * Email jobs (EMAILS.md §1/§6): transactional E0 + E2, solicitation E1 + E4.
 *
 * jobsEmailE0Job — event-triggered ('jobs/email.requested'): the user
 * tapped "Email me tonight's practice link". Consent is the request:
 * bypasses coarse prefs and the weekly cap; honors ONLY the suppression
 * gate (e0/all). Outside the 08:00–21:00 IST window the send sleeps to
 * the next 08:00 IST (step.sleepUntil — durable, survives redeploys).
 *
 * jobsEmailSweepJob — hourly cron ('35 * * * *' UTC = :05 past each IST
 * hour): derives due E2 (transactional, cap-exempt) then E1/E4
 * (solicitation: weekly cap w/ priority E1>E4, cap-miss = DROP,
 * reserve-first ledger, shared response-ask budget with the in-app
 * nudges, ≥3 due E1 → one batched email). Guard pipeline per §6.
 */

interface StepRunner {
  run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T>
  sleepUntil?: (name: string, until: Date) => Promise<void>
}

const APP_URL = process.env.APP_URL || process.env.NEXTAUTH_URL || 'https://www.interviewprep.guru'
/** Max E2 reminders per application EVER — date-toggling must not mint
 *  unlimited cap-exempt sends (review R19). */
const E2_PER_APPLICATION_CEILING = 3
const SENDS_PER_STEP = 20

// ── E0: user-requested practice link ────────────────────────────────────────

export async function runE0Handler(
  event: { data: { userId: string; jobPostingId: string; requestedAt: string } },
  step: StepRunner
): Promise<{ outcome: string }> {
  await connectDB()
  const cfg = await JobsEmailConfig.getConfig()
  if (!cfg.e0Enabled) return { outcome: 'stream-disabled' }

  const { userId, jobPostingId, requestedAt } = event.data
  // 24h idempotency-window bound (Codex #530): a replay arriving a day
  // late must not send "tonight's" link tomorrow night.
  if (Date.now() - new Date(requestedAt).getTime() > 24 * 3600_000) {
    logger.warn({ userId, jobPostingId }, 'E0 request older than 24h — dropped (past idempotency window)')
    return { outcome: 'past-window' }
  }

  // Quiet hours: durable sleep to the next 08:00 IST (a request at 23:00
  // IST is honored at 08:00, not silently at midnight).
  const now = new Date()
  if (!isInSendWindow(now) && step.sleepUntil) {
    await step.sleepUntil('wait-for-send-window', nextSendSlot(now))
  }

  const result = await step.run('send-e0', async () => {
    const [user, application, posting] = await Promise.all([
      User.findById(userId).select('email emailPreferences.jobs.unsubscribedStreams').lean(),
      JobApplication.findOne({ userId, jobPostingId }).select('_id').lean(),
      JobPosting.findById(jobPostingId).select('title company').lean(),
    ])
    if (!user?.email || !application || !posting) return 'missing-context'
    if (isSuppressed(user.emailPreferences?.jobs?.unsubscribedStreams, 'e0')) return 'suppressed'

    const footerUrls = buildFooterUrls(userId, 'e0')
    const { subject, html } = buildE0Email({
      company: posting.company ?? 'the company',
      jobTitle: posting.title ?? 'this role',
      practiceUrl: `${APP_URL}/jobs/${jobPostingId}?practice=1`,
      footer: {
        whyLine: `you asked us to email you a practice link for ${posting.title ?? 'this role'}`,
        ...footerUrls,
      },
    })
    // dedupeKey embeds the request HOUR: double-taps collapse, tomorrow's
    // request works (EMAILS.md §1).
    const hourKey = new Date(requestedAt).toISOString().slice(0, 13)
    const sent = await sendTransactional({
      userId,
      stream: 'e0',
      dedupeKey: `${application._id}:${hourKey}`,
      to: user.email,
      subject,
      html,
      footer: { whyLine: '', ...footerUrls },
    })
    return sent.outcome
  })
  return { outcome: result }
}

// ── E2: T-1 interview reminder sweep ────────────────────────────────────────

export async function runEmailSweepHandler(step: StepRunner): Promise<{ e2Sent: number; e1Sent: number; e4Sent: number } | { skipped: string }> {
  await connectDB()
  const cfg = await JobsEmailConfig.getConfig()
  if (!cfg.e2Enabled && !cfg.e1Enabled && !cfg.e4Enabled) return { skipped: 'all-streams-disabled' }
  const now = new Date()
  if (!isInSendWindow(now)) return { skipped: 'quiet-hours' }

  let sent = 0
  // E2 (transactional, cap-exempt) — only when its switch is on: the
  // sweep serves multiple streams and one OFF stream must not run its
  // derivation (surfaced by the PR-C suite).
  if (cfg.e2Enabled) {
    // Candidates: a set date with actionable confidence, interview not past.
    // Bounded: interviews within ±8 IST days of now cover every derivable
    // send instant (T-1 and Monday-of-week both fall inside). _id-cursor
    // paginated to exhaustion (EMAILS.md §2 guard 2; Codex #532 — a head
    // read starves the tail behind already-processed rows) with a hard stop
    // of 500 SENDS per run, remainder logged and picked up next hour.
    const derived = await step.run('find-due-e2', async () => {
      const SEND_WINDOW_MS = 24 * 3600_000
      const HARD_STOP = 500
      type Candidate = {
        applicationId: string; userId: string; jobPostingId: string
        interviewDateISO: string; confidence: 'exact' | 'week'; practiceSessionIds: string[]
      }
      const due: Candidate[] = []
      const pastWindow: Candidate[] = []
      let cursor: string | null = null
      let truncated = false
      for (;;) {
        type LeanApp = { _id: unknown; userId: unknown; jobPostingId: unknown; interviewDate?: Date; interviewDateConfidence?: string; practiceSessionIds?: unknown[] }
        const batch: LeanApp[] = await JobApplication.find({
          // Only rows STILL scheduled (Codex #532): a stale interviewDate on
          // a row the user corrected to rejected/withdrawn/ghosted must
          // never mint a reminder for a dead interview.
          status: 'interview_scheduled',
          interviewDate: {
            $gte: new Date(now.getTime() - 2 * 86_400_000),
            $lte: new Date(now.getTime() + 8 * 86_400_000),
          },
          interviewDateConfidence: { $in: ['exact', 'week'] },
          ...(cursor ? { _id: { $gt: cursor } } : {}),
        })
          .select('_id userId jobPostingId interviewDate interviewDateConfidence practiceSessionIds')
          .sort({ _id: 1 })
          .limit(200)
          .lean<LeanApp[]>()
        for (const r of batch) {
          const at = e2SendInstant(r.interviewDate!, r.interviewDateConfidence as 'exact' | 'week', now)
          if (at === null || at.getTime() > now.getTime()) continue
          const c: Candidate = {
            applicationId: String(r._id),
            userId: String(r.userId),
            jobPostingId: String(r.jobPostingId),
            interviewDateISO: r.interviewDate!.toISOString().slice(0, 10),
            confidence: r.interviewDateConfidence as 'exact' | 'week',
            practiceSessionIds: (r.practiceSessionIds ?? []).map(String),
          }
          // Automatic sends are bounded to 24h of the FIRST due instant
          // (EMAILS.md §2, Codex #532): past it, Resend's idempotency key
          // has expired, so a missing ledger row must alert a human — never
          // auto-send a possible duplicate.
          if (now.getTime() - at.getTime() > SEND_WINDOW_MS) pastWindow.push(c)
          else if (due.length < HARD_STOP) due.push(c)
          else truncated = true
        }
        if (batch.length < 200) break
        cursor = String(batch[batch.length - 1]._id)
      }
      if (truncated) logger.warn({ hardStop: HARD_STOP }, 'E2 sweep hit the per-run send cap — remainder defers to the next hourly run')
      return { due, pastWindow }
    })
    const candidates = derived.due

    // Past-window rows: normal when the reminder already sent (ledger row
    // exists — the common case on the interview day). A MISSING row here
    // means a send may have been accepted but never recorded and the
    // idempotency window is gone — alert, never resend (EMAILS.md §2).
    if (derived.pastWindow.length) {
      await step.run('alert-past-window-e2', async () => {
        for (const c of derived.pastWindow) {
          const recorded = await JobsEmailSend.findOne({
            userId: c.userId,
            stream: 'e2',
            dedupeKey: `${c.applicationId}:${c.interviewDateISO}`,
          }).lean()
          if (!recorded) {
            logger.error(
              { applicationId: c.applicationId, interviewDateISO: c.interviewDateISO },
              'E2 reminder past the 24h idempotency window with NO ledger row — human review required, auto-send refused'
            )
          }
        }
        return derived.pastWindow.length
      })
    }

    for (let i = 0; i < candidates.length; i += SENDS_PER_STEP) {
      const chunk = candidates.slice(i, i + SENDS_PER_STEP)
      sent += await step.run(`send-e2-${Math.floor(i / SENDS_PER_STEP)}`, async () => {
        let n = 0
        for (const c of chunk) {
          try {
            // Per-application ceiling (R19): dedupeKeys are prefix-scoped by
            // application id, so a count bounds date-toggle re-arms forever.
            const priorReminders = await JobsEmailSend.countDocuments({
              userId: c.userId,
              stream: 'e2',
              dedupeKey: { $regex: `^${c.applicationId}:` },
            })
            if (priorReminders >= E2_PER_APPLICATION_CEILING) continue

            const user = await User.findById(c.userId).select('email emailPreferences.jobs.unsubscribedStreams').lean()
            if (!user?.email) continue
            if (isSuppressed(user.emailPreferences?.jobs?.unsubscribedStreams, 'e2')) continue

            const posting = await JobPosting.findById(c.jobPostingId).select('title company').lean()
            if (!posting) continue

            // Logistics-only variant when a practice session happened in the
            // last 24h (R10) — the user is already warm.
            let logisticsOnly = false
            if (c.practiceSessionIds.length) {
              const recent = await InterviewSession.exists({
                _id: { $in: c.practiceSessionIds.slice(-5) },
                createdAt: { $gte: new Date(now.getTime() - 24 * 3600_000) },
              })
              logisticsOnly = !!recent
            }

            const daysUntil = istCalendarDaysBetween(now, new Date(`${c.interviewDateISO}T00:00:00Z`))
            const whenLabel = c.confidence === 'week' ? 'this week' : daysUntil <= 1 ? 'tomorrow' : `in ${daysUntil} days`
            const footerUrls = buildFooterUrls(c.userId, 'e2')
            const { subject, html } = buildE2Email({
              company: posting.company ?? 'the company',
              jobTitle: posting.title ?? 'this role',
              whenLabel,
              prepPlanUrl: `${APP_URL}/jobs/${c.jobPostingId}?prep=1`,
              warmUpUrl: `${APP_URL}/jobs/${c.jobPostingId}?practice=1`,
              logisticsOnly,
              footer: {
                whyLine: `you set an interview date for ${posting.title ?? 'this role'} at ${posting.company ?? 'the company'}`,
                ...footerUrls,
              },
            })
            const res = await sendTransactional({
              userId: c.userId,
              stream: 'e2',
              dedupeKey: `${c.applicationId}:${c.interviewDateISO}`,
              to: user.email,
              subject,
              html,
              footer: { whyLine: '', ...footerUrls },
            })
            if (res.outcome === 'sent') n++
          } catch (err) {
            // Per-candidate isolation: one bad row never starves the rest.
            logger.error({ err, applicationId: c.applicationId }, 'E2 candidate failed — continuing sweep')
          }
        }
        return n
      })
    }
  }

  // ── Solicitation: E1 + E4 (EMAILS.md §1 — cap-governed, priority E1>E4,
  // cap-miss = DROP; reserve-first ledger discipline) ────────────────────
  let e1Sent = 0
  let e4Sent = 0
  if (cfg.e1Enabled || cfg.e4Enabled) {
    type SolicitationCandidate = {
      applicationId: string; userId: string; jobPostingId: string
      company: string; jobTitle: string; appliedAgoDays: number
      intent: 'clicked' | 'applied'
    }
    const work = await step.run('find-due-solicitation', async () => {
      const e1: SolicitationCandidate[] = []
      const e4: SolicitationCandidate[] = []
      type LeanRow = {
        _id: unknown; userId: unknown; jobPostingId: unknown; appliedAt?: Date
        statusHistory?: Array<{ status: string; at?: Date; source?: string }>
        outcome?: { lastAskedAt?: Date }
        practiceSessionIds?: unknown[]
        jobSnapshot?: { title?: string; company?: string }
      }
      const toCandidate = (r: LeanRow, intentAt: Date, intent: 'clicked' | 'applied' = 'applied'): SolicitationCandidate => ({
        applicationId: String(r._id),
        userId: String(r.userId),
        jobPostingId: String(r.jobPostingId),
        company: r.jobSnapshot?.company ?? 'the company',
        jobTitle: r.jobSnapshot?.title ?? 'this role',
        appliedAgoDays: Math.max(0, istCalendarDaysBetween(intentAt, now)),
        intent,
      })
      const paginate = async (filter: Record<string, unknown>, onRow: (r: LeanRow) => void) => {
        let cursor: string | null = null
        for (;;) {
          const batch: LeanRow[] = await JobApplication.find({ ...filter, ...(cursor ? { _id: { $gt: cursor } } : {}) })
            .select('_id userId jobPostingId appliedAt statusHistory outcome practiceSessionIds jobSnapshot')
            .sort({ _id: 1 })
            .limit(200)
            .lean<LeanRow[]>()
          batch.forEach(onRow)
          if (batch.length < 200) break
          cursor = String(batch[batch.length - 1]._id)
        }
      }

      if (cfg.e1Enabled) {
        // E1: applied 14–28 IST days ago (never past day 28 — it must land
        // BEFORE the 35d auto-ghost), no user-sourced touch in 14d, and
        // the shared response-ask ledger quiet for 7d (an in-app nudge
        // answer defers the email — EMAILS.md §1 / review R4).
        await paginate(
          {
            status: 'applied',
            appliedAt: { $lte: new Date(now.getTime() - 14 * 86_400_000), $gte: new Date(now.getTime() - 28 * 86_400_000) },
          },
          (r) => {
            if (!r.appliedAt) return
            const lastUserTouch = (r.statusHistory ?? [])
              .filter((h) => h.source === 'user' && h.at)
              .reduce((m, h) => Math.max(m, new Date(h.at!).getTime()), 0)
            if (lastUserTouch > now.getTime() - 14 * 86_400_000) return
            const lastAsked = r.outcome?.lastAskedAt ? new Date(r.outcome.lastAskedAt).getTime() : 0
            if (lastAsked > now.getTime() - 7 * 86_400_000) return
            e1.push(toCandidate(r, r.appliedAt))
          }
        )
      }

      if (cfg.e4Enabled) {
        // E4: apply INTENT (clicked or applied — merely-saved never mails,
        // review R7), zero practice, intent aged 3–14 IST days.
        await paginate(
          {
            status: { $in: ['apply_clicked', 'applied'] },
            practiceSessionIds: { $size: 0 },
          },
          (r) => {
            const intent = (r.statusHistory ?? []).find((h) => (h.status === 'apply_clicked' || h.status === 'applied') && h.at)
            if (!intent?.at) return
            const age = istCalendarDaysBetween(new Date(intent.at), now)
            if (age < 3 || age > 14) return
            e4.push(toCandidate(r, new Date(intent.at), intent.status === 'applied' ? 'applied' : 'clicked'))
          }
        )
      }
      return { e1, e4 }
    })

    // Group per user; spend cap slots in priority order (E1 first). All
    // per-user processing in chunked steps.
    const byUser = new Map<string, { e1: SolicitationCandidate[]; e4: SolicitationCandidate[] }>()
    for (const c of work.e1) (byUser.get(c.userId) ?? byUser.set(c.userId, { e1: [], e4: [] }).get(c.userId)!).e1.push(c)
    for (const c of work.e4) (byUser.get(c.userId) ?? byUser.set(c.userId, { e1: [], e4: [] }).get(c.userId)!).e4.push(c)
    const users = Array.from(byUser.keys())

    for (let i = 0; i < users.length; i += 10) {
      const chunk = users.slice(i, i + 10)
      const counts = await step.run(`send-solicitation-${Math.floor(i / 10)}`, async () => {
        let n1 = 0
        let n4 = 0
        for (const userId of chunk) {
          try {
            const queue = byUser.get(userId)!
            const user = await User.findById(userId).select('email emailPreferences.jobs').lean()
            if (!user?.email) continue
            const jobsPrefs = user.emailPreferences?.jobs
            // Coarse toggle (nudges) + suppression list, both fail-closed
            // toward silence; absent prefs = default-true (guard 3).
            if (jobsPrefs?.nudges === false) continue

            let remaining = cfg.globalWeeklyCap - (await solicitationSentLast7d(userId, now))
            if (remaining <= 0) continue // cap-miss = DROP, next window re-derives what's still true

            // One-per-application-ever pre-check (ledger read) keeps email
            // CONTENT consistent with what actually reserves.
            const freshE1: SolicitationCandidate[] = []
            for (const c of queue.e1) {
              const burned = await JobsEmailSend.findOne({ userId, stream: 'e1', dedupeKey: c.applicationId }).lean()
              if (!burned) freshE1.push(c)
            }

            if (cfg.e1Enabled && freshE1.length && !isSuppressed(jobsPrefs?.unsubscribedStreams, 'e1') && remaining > 0) {
              // ≥3 due → ONE batched email, one cap slot (review R2);
              // fewer → individual emails, one slot each.
              const groups: SolicitationCandidate[][] =
                freshE1.length >= 3 ? [freshE1] : freshE1.map((c) => [c])
              for (const group of groups) {
                if (remaining <= 0) break
                const rows = group.map((c) => ({
                  company: c.company,
                  jobTitle: c.jobTitle,
                  appliedAgoDays: c.appliedAgoDays,
                  interviewUrl: emailActionUrl(userId, c.applicationId, 'interview_scheduled'),
                  rejectedUrl: emailActionUrl(userId, c.applicationId, 'rejected'),
                  nothingYetUrl: emailActionUrl(userId, c.applicationId, 'nothing-yet'),
                }))
                const footerUrls = buildFooterUrls(userId, 'e1')
                const { subject, html } = buildE1Email({
                  rows,
                  trackerUrl: `${APP_URL}/jobs/tracker`,
                  footer: {
                    whyLine: group.length === 1
                      ? `you applied to ${group[0].jobTitle} at ${group[0].company} on our tracker`
                      : `you have ${group.length} tracked applications awaiting a response`,
                    ...footerUrls,
                  },
                })
                const res = await sendSolicitation({
                  userId, stream: 'e1', dedupeKeys: group.map((c) => c.applicationId),
                  to: user.email, subject, html, coarseToggle: 'nudges',
                })
                if (res.outcome === 'sent') {
                  remaining--
                  n1++
                  // Consume the SHARED response-ask budget (review R4): the
                  // in-app nudges read the same fields.
                  await JobApplication.updateMany(
                    { _id: { $in: group.map((c) => c.applicationId) } },
                    { $set: { 'outcome.lastAskedAt': new Date() }, $inc: { 'outcome.askCount': 1 } }
                  )
                }
              }
            }

            if (cfg.e4Enabled && queue.e4.length && !isSuppressed(jobsPrefs?.unsubscribedStreams, 'e4')) {
              for (const c of queue.e4) {
                if (remaining <= 0) break
                const burned = await JobsEmailSend.findOne({ userId, stream: 'e4', dedupeKey: c.applicationId }).lean()
                if (burned) continue
                // An honored E0 consumes the automatic E4 (EMAILS.md §1).
                const e0Honored = await JobsEmailSend.findOne({
                  userId, stream: 'e0', dedupeKey: { $regex: `^${c.applicationId}:` }, sentAt: { $exists: true },
                }).lean()
                if (e0Honored) continue
                // Posting must still be open — never nudge practice for a
                // closed job (review R2/R7).
                const posting = await JobPosting.findById(c.jobPostingId).select('status').lean()
                if (!posting || posting.status !== 'open') continue
                const footerUrls = buildFooterUrls(userId, 'e4')
                const { subject, html } = buildE4Email({
                  company: c.company,
                  jobTitle: c.jobTitle,
                  practiceUrl: `${APP_URL}/jobs/${c.jobPostingId}?practice=1`,
                  intent: c.intent,
                  // The why-line states the TRUE trigger fact (EMAILS.md §5):
                  // a click is a click, never an application (Codex #533).
                  footer: {
                    whyLine: c.intent === 'applied'
                      ? `you applied to ${c.jobTitle} at ${c.company} and haven't practiced for it yet`
                      : `you clicked apply on ${c.jobTitle} at ${c.company} and haven't practiced for it yet`,
                    ...footerUrls,
                  },
                })
                const res = await sendSolicitation({
                  userId, stream: 'e4', dedupeKeys: [c.applicationId],
                  to: user.email, subject, html, coarseToggle: 'nudges',
                })
                if (res.outcome === 'sent') {
                  remaining--
                  n4++
                }
              }
            }
          } catch (err) {
            logger.error({ err, userId }, 'solicitation user failed — continuing sweep')
          }
        }
        return { n1, n4 }
      })
      e1Sent += counts.n1
      e4Sent += counts.n4
    }
  }

  return { e2Sent: sent, e1Sent, e4Sent }
}

/** One-tap action URL: single-purpose signed token (EMAILS.md §4). */
function emailActionUrl(userId: string, applicationId: string, action: string): string {
  return `${APP_URL}/api/jobs/email-action?token=${encodeURIComponent(
    mintActionToken({ typ: 'status', uid: userId, aid: applicationId, action, dk: applicationId, expDays: 30 })
  )}`
}

// ── Inngest wrappers ─────────────────────────────────────────────────────────

export const jobsEmailE0Job = inngest.createFunction(
  {
    id: 'jobs-email-e0',
    name: 'Jobs email: requested practice link (E0)',
    retries: 2, // infra throws only — the send ledger makes re-runs idempotent
    triggers: [{ event: 'jobs/email.requested' }],
  },
  async ({ event, step }) =>
    runE0Handler(event as unknown as { data: { userId: string; jobPostingId: string; requestedAt: string } }, step as StepRunner)
)

export const jobsEmailSweepJob = inngest.createFunction(
  {
    id: 'jobs-email-sweep',
    name: 'Jobs email: transactional sweep (E2)',
    retries: 1,
    triggers: [{ cron: '35 * * * *' }],
  },
  async ({ step }) => runEmailSweepHandler(step as StepRunner)
)
