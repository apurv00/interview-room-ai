import { inngest } from '@shared/services/inngest'
import { connectDB } from '@shared/db/connection'
import { JobApplication, JobPosting, JobsEmailConfig, JobsEmailSend, User, InterviewSession } from '@shared/db/models'
import { logger } from '@shared/logger'
import { buildE0Email } from '../emails/e0'
import { buildE2Email } from '../emails/e2'
import { buildFooterUrls, sendTransactional, isSuppressed } from '../services/emailSendService'
import { isInSendWindow, nextSendSlot, e2SendInstant, istCalendarDaysBetween } from '../config/emailTiming'

/**
 * Transactional email jobs (EMAILS.md §1/§6 — wave 1: E0 + E2 only).
 *
 * jobsEmailE0Job — event-triggered ('jobs/email.requested'): the user
 * tapped "Email me tonight's practice link". Consent is the request:
 * bypasses coarse prefs and the weekly cap; honors ONLY the suppression
 * gate (e0/all). Outside the 08:00–21:00 IST window the send sleeps to
 * the next 08:00 IST (step.sleepUntil — durable, survives redeploys).
 *
 * jobsEmailSweepJob — hourly cron ('35 * * * *' UTC = :05 past each IST
 * hour): derives due E2 T-1 reminders lazily (nothing persisted before
 * the ledger step). Guard pipeline order per §6: config switch →
 * quiet-hours gate → candidate query → per-application ceiling →
 * suppression → template → transactional send.
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

export async function runEmailSweepHandler(step: StepRunner): Promise<{ e2Sent: number } | { skipped: string }> {
  await connectDB()
  const cfg = await JobsEmailConfig.getConfig()
  if (!cfg.e2Enabled) return { skipped: 'e2-disabled' }
  const now = new Date()
  if (!isInSendWindow(now)) return { skipped: 'quiet-hours' }

  // Candidates: a set date with actionable confidence, interview not past.
  // Bounded: interviews within ±8 IST days of now cover every derivable
  // send instant (T-1 and Monday-of-week both fall inside).
  const candidates = await step.run('find-due-e2', async () => {
    const rows = await JobApplication.find({
      // Only rows STILL scheduled (Codex #532): a stale interviewDate on a
      // row the user corrected to rejected/withdrawn/ghosted must never
      // mint a reminder for a dead interview.
      status: 'interview_scheduled',
      interviewDate: {
        $gte: new Date(now.getTime() - 2 * 86_400_000),
        $lte: new Date(now.getTime() + 8 * 86_400_000),
      },
      interviewDateConfidence: { $in: ['exact', 'week'] },
    })
      .select('_id userId jobPostingId interviewDate interviewDateConfidence practiceSessionIds')
      .limit(500)
      .lean()
    // Due = the derived send instant has arrived and the window hasn't
    // closed (e2SendInstant returns null past it).
    return rows
      .filter((r) => {
        const at = e2SendInstant(r.interviewDate!, r.interviewDateConfidence as 'exact' | 'week', now)
        return at !== null && at.getTime() <= now.getTime()
      })
      .map((r) => ({
        applicationId: String(r._id),
        userId: String(r.userId),
        jobPostingId: String(r.jobPostingId),
        interviewDateISO: r.interviewDate!.toISOString().slice(0, 10),
        confidence: r.interviewDateConfidence as 'exact' | 'week',
        practiceSessionIds: (r.practiceSessionIds ?? []).map(String),
      }))
  })

  let sent = 0
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
  return { e2Sent: sent }
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
