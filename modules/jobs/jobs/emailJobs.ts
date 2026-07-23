import { inngest } from '@shared/services/inngest'
import { connectDB } from '@shared/db/connection'
import { JobApplication, JobPosting, JobsEmailConfig, JobsEmailSend, User, InterviewSession } from '@shared/db/models'
import { logger } from '@shared/logger'
import { buildE0Email } from '../emails/e0'
import { buildE2Email } from '../emails/e2'
import { buildE1Email, buildE4Email } from '../emails/e1'
import {
  buildFooterUrls,
  sendTransactional,
  sendSolicitation,
  solicitationSentLast7d,
  isSuppressed,
  recordTransactionalIncident,
} from '../services/emailSendService'
import { mintActionToken } from '@shared/services/signedActionToken'
import { isInSendWindow, nextSendSlot, e2SendInstant, istCalendarDaysBetween, istDateKey } from '../config/emailTiming'
import { jobPostingStateOf } from '../services/postingAccess'
import { preparePracticeHandoffPosting } from '../services/practiceHandoff'

/**
 * Email jobs (EMAILS.md §1/§6): transactional E0 + E2, solicitation E1 + E4.
 *
 * jobsEmailE0Job — event-triggered ('jobs/email.requested'): the user
 * tapped "Email me this practice link". Consent is the request:
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

type DeliveryPostingIdentity = {
  status?: string
  closedReason?: string | null
  domain?: string | null
  parsedJDHash?: string | null
  parsedJDRoleVersion?: string | null
  updatedAt?: Date
}

/** Exact persisted identity checked after asynchronous Practice preparation.
 * `updatedAt` is the row-version fence maintained by every Mongoose lifecycle
 * write; the named fields make safety-critical state explicit as well. */
function postingDeliveryIdentityFilter(
  postingId: string,
  posting: DeliveryPostingIdentity,
): Record<string, unknown> | null {
  if (!posting.status || !(posting.updatedAt instanceof Date)) return null
  return {
    _id: postingId,
    status: posting.status,
    closedReason: posting.closedReason ?? null,
    domain: posting.domain ?? null,
    parsedJDHash: posting.parsedJDHash ?? null,
    parsedJDRoleVersion: posting.parsedJDRoleVersion ?? null,
    updatedAt: posting.updatedAt,
  }
}

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
  // late must not honor a stale deferred-link request. Persist the same
  // application/hour identity as an incident so an operator can see why
  // the structurally burned key was never sent.
  if (Date.now() - new Date(requestedAt).getTime() > 24 * 3600_000) {
    await step.run('record-past-window-e0', async () => {
      const application = await JobApplication.findOne({ userId, jobPostingId })
        .select('_id')
        .lean()
      if (!application) return
      const hourKey = new Date(requestedAt).toISOString().slice(0, 13)
      await recordTransactionalIncident({
        userId,
        stream: 'e0',
        dedupeKey: `${application._id}:${hourKey}`,
        incidentKind: 'past-window',
      })
    })
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
      JobPosting.findById(jobPostingId)
        .select('title company domain status closedReason parsedJD parsedJDHash parsedJDRoleVersion jdCompressed jdDisplayCompressed updatedAt')
        .lean(),
    ])
    if (!user?.email || !application || !posting) return 'missing-context'
    if (isSuppressed(user.emailPreferences?.jobs?.unsubscribedStreams, 'e0')) return 'suppressed'
    if (jobPostingStateOf(posting) === 'restricted') return 'posting-restricted'
    const prepared = await preparePracticeHandoffPosting(posting)
    if (!prepared.role || !prepared.jdHash) return 'practice-unavailable'

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
      beforeDelivery: async () => {
        // The request may sleep through quiet hours. Re-read the canonical
        // posting at the actual provider boundary so a source revocation,
        // JD replacement, or CMS-role withdrawal wins over prepared copy.
        const [currentApplication, currentPosting] = await Promise.all([
          JobApplication.exists({ _id: application._id, userId, jobPostingId }),
          JobPosting.findById(jobPostingId)
            .select('domain status closedReason parsedJD parsedJDHash parsedJDRoleVersion jdCompressed jdDisplayCompressed updatedAt')
            .lean(),
        ])
        if (!currentApplication || !currentPosting || jobPostingStateOf(currentPosting) === 'restricted') return false
        const currentPrepared = await preparePracticeHandoffPosting(currentPosting)
        if (!currentPrepared.role || currentPrepared.jdHash !== prepared.jdHash) return false

        // CMS/Practice preparation is asynchronous. Close the window it
        // creates with one last exact application + posting identity read;
        // a revoke, JD replacement, or ownership deletion during preparation
        // must win before the provider call.
        const postingIdentity = postingDeliveryIdentityFilter(jobPostingId, currentPosting)
        if (!postingIdentity) return false
        const [sameApplication, samePosting] = await Promise.all([
          JobApplication.exists({ _id: application._id, userId, jobPostingId }),
          JobPosting.exists(postingIdentity),
        ])
        return !!sameApplication && !!samePosting
      },
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
        interviewDateISO: string; interviewDateValue: string
        dedupeKey: string; legacyDedupeKey: string
        confidence: 'exact'; verifiedPracticeSessionIds: string[]
        title: string; company: string
      }
      const due: Candidate[] = []
      const pastWindow: Candidate[] = []
      let cursor: string | null = null
      let truncated = false
      for (;;) {
        type LeanApp = { _id: unknown; userId: unknown; jobPostingId: unknown; interviewDate?: Date; interviewDateConfidence?: string; verifiedPracticeSessionIds?: unknown[]; jobSnapshot?: { title?: string; company?: string } }
        const batch: LeanApp[] = await JobApplication.find({
          // Only rows STILL scheduled (Codex #532): a stale interviewDate on
          // a row the user corrected to rejected/withdrawn/ghosted must
          // never mint a reminder for a dead interview.
          status: 'interview_scheduled',
          interviewDate: {
            $gte: new Date(now.getTime() - 2 * 86_400_000),
            $lte: new Date(now.getTime() + 8 * 86_400_000),
          },
          // Week answers are preferences, not event dates. Only an exact
          // user-supplied date can authorize a date-based reminder.
          interviewDateConfidence: 'exact',
          ...(cursor ? { _id: { $gt: cursor } } : {}),
        })
          .select('_id userId jobPostingId interviewDate interviewDateConfidence verifiedPracticeSessionIds jobSnapshot')
          .sort({ _id: 1 })
          .limit(200)
          .lean<LeanApp[]>()
        for (const r of batch) {
          const at = e2SendInstant(r.interviewDate!, now)
          if (at === null || at.getTime() > now.getTime()) continue
          const applicationId = String(r._id)
          const interviewDateISO = istDateKey(r.interviewDate!)
          const interviewDateValue = r.interviewDate!.toISOString()
          const c: Candidate = {
            applicationId,
            userId: String(r.userId),
            jobPostingId: String(r.jobPostingId),
            interviewDateISO,
            interviewDateValue,
            // Version the corrected IST identity so it cannot collide with an
            // old UTC date key for a different user-edited interview date.
            dedupeKey: `${applicationId}:v2:${interviewDateISO}`,
            // Before A07, E2 used the UTC ISO date. A legacy "Tomorrow"
            // capture retained the request clock time, so the old and new
            // calendar keys differ after 18:30 UTC.
            legacyDedupeKey: `${applicationId}:${interviewDateValue.slice(0, 10)}`,
            confidence: 'exact',
            verifiedPracticeSessionIds: (r.verifiedPracticeSessionIds ?? []).map(String),
            title: r.jobSnapshot?.title ?? 'this role',
            company: r.jobSnapshot?.company ?? 'the company',
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
            dedupeKey: { $in: [c.dedupeKey, c.legacyDedupeKey] },
          }).lean()
          if (!recorded) {
            await recordTransactionalIncident({
              userId: c.userId,
              stream: 'e2',
              dedupeKey: c.dedupeKey,
              incidentKind: 'past-window',
            })
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
            // Rollout compatibility: an accepted/burned pre-A07 send used the
            // UTC date key. It must suppress the v2 IST key too, otherwise the
            // same reminder can reach Resend with a fresh idempotency key.
            const legacyReminder = await JobsEmailSend.findOne({
              userId: c.userId,
              stream: 'e2',
              dedupeKey: c.legacyDedupeKey,
            }).lean()
            if (legacyReminder) continue

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

            const posting = await JobPosting.findById(c.jobPostingId)
              .select('title company domain status closedReason parsedJD parsedJDHash parsedJDRoleVersion jdCompressed jdDisplayCompressed updatedAt')
              .lean()
            const postingState = posting ? jobPostingStateOf(posting) : 'restricted'
            const prepared = postingState !== 'restricted' && posting
              ? await preparePracticeHandoffPosting(posting)
              : null
            const practiceAvailable = !!prepared?.role && !!prepared.jdHash
            const company = postingState === 'restricted' ? c.company : (posting?.company ?? c.company)
            const jobTitle = postingState === 'restricted' ? c.title : (posting?.title ?? c.title)

            // Logistics-only variant when a practice session happened in the
            // last 24h (R10) — the user is already warm.
            let logisticsOnly = false
            if (c.verifiedPracticeSessionIds.length) {
              const recent = await InterviewSession.exists({
                _id: { $in: c.verifiedPracticeSessionIds.slice(-5) },
                status: 'completed',
                completedAt: {
                  $gte: new Date(now.getTime() - 24 * 3600_000),
                  $lte: now,
                },
              })
              logisticsOnly = !!recent
            }

            const daysUntil = istCalendarDaysBetween(now, new Date(c.interviewDateValue))
            const whenLabel = daysUntil <= 0 ? 'today' : daysUntil === 1 ? 'tomorrow' : `in ${daysUntil} days`
            const footerUrls = buildFooterUrls(c.userId, 'e2')
            const { subject, html } = buildE2Email({
              company,
              jobTitle,
              whenLabel,
              prepPlanUrl: practiceAvailable
                ? `${APP_URL}/jobs/${c.jobPostingId}?prep=1`
                : `${APP_URL}/interview/setup`,
              warmUpUrl: `${APP_URL}/jobs/${c.jobPostingId}?practice=1`,
              logisticsOnly,
              practiceAvailable,
              footer: {
                whyLine: `you set an interview date for ${jobTitle} at ${company}`,
                ...footerUrls,
              },
            })
            const res = await sendTransactional({
              userId: c.userId,
              stream: 'e2',
              dedupeKey: c.dedupeKey,
              to: user.email,
              subject,
              html,
              footer: { whyLine: '', ...footerUrls },
              beforeDelivery: async () => {
                // The interview reminder itself is authorized by the user's
                // still-current tracker claim. Date/status edits cancel stale
                // copy even when the posting variant is already generic.
                const applicationIdentity = {
                  _id: c.applicationId,
                  userId: c.userId,
                  jobPostingId: c.jobPostingId,
                  status: 'interview_scheduled',
                  interviewDate: new Date(c.interviewDateValue),
                  interviewDateConfidence: c.confidence,
                }
                const currentApplication = await JobApplication.exists(applicationIdentity)
                if (!currentApplication) return false

                // A restricted/missing posting already uses the user's saved
                // snapshot plus a generic setup CTA, so it carries no fresh
                // canonical content to authorize. Canonical variants re-check
                // policy immediately before every provider attempt; a source
                // revoke cancels this stale rendering. A later in-window sweep
                // can derive the safe snapshot-only generic variant.
                if (postingState === 'restricted') return true
                const currentPosting = await JobPosting.findById(c.jobPostingId)
                  .select('domain status closedReason parsedJD parsedJDHash parsedJDRoleVersion jdCompressed jdDisplayCompressed updatedAt')
                  .lean()
                if (!currentPosting || jobPostingStateOf(currentPosting) === 'restricted') return false
                if (practiceAvailable) {
                  const currentPrepared = await preparePracticeHandoffPosting(currentPosting)
                  if (!currentPrepared.role || currentPrepared.jdHash !== prepared?.jdHash) return false
                }

                // Re-check both exact identities after async preparation. A
                // source revoke or tracker edit that lands during the CMS
                // lookup cannot authorize the already-rendered canonical copy.
                const postingIdentity = postingDeliveryIdentityFilter(c.jobPostingId, currentPosting)
                if (!postingIdentity) return false
                const [sameApplication, samePosting] = await Promise.all([
                  JobApplication.exists(applicationIdentity),
                  JobPosting.exists(postingIdentity),
                ])
                return !!sameApplication && !!samePosting
              },
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
      company: string; jobTitle: string; markedAppliedAgoDays: number
      intent: 'clicked' | 'applied'
      applicationStatus?: string
      applicationUpdatedAt?: Date
    }
    const work = await step.run('find-due-solicitation', async () => {
      const e1: SolicitationCandidate[] = []
      const e4: SolicitationCandidate[] = []
      type LeanRow = {
        _id: unknown; userId: unknown; jobPostingId: unknown; appliedAt?: Date; status?: string
        updatedAt?: Date
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
        markedAppliedAgoDays: Math.max(0, istCalendarDaysBetween(intentAt, now)),
        intent,
        applicationStatus: r.status,
        applicationUpdatedAt: r.updatedAt,
      })
      const paginate = async (filter: Record<string, unknown>, onRow: (r: LeanRow) => void) => {
        let cursor: string | null = null
        for (;;) {
          const batch: LeanRow[] = await JobApplication.find({ ...filter, ...(cursor ? { _id: { $gt: cursor } } : {}) })
            .select('_id userId jobPostingId appliedAt status statusHistory outcome practiceSessionIds jobSnapshot updatedAt')
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
            // LATEST relevant entry (Codex #533): a clicked-then-confirmed
            // row must key age off the confirmation, not the older click —
            // and intent comes from the CURRENT status (applied never
            // downgrades to click copy).
            const relevant = (r.statusHistory ?? []).filter((h) => (h.status === 'apply_clicked' || h.status === 'applied') && h.at)
            if (!relevant.length) return
            const latest = relevant.reduce((x, y) => (new Date(x.at!) > new Date(y.at!) ? x : y))
            const age = istCalendarDaysBetween(new Date(latest.at!), now)
            if (age < 3 || age > 14) return
            e4.push(toCandidate(r, new Date(latest.at!), r.status === 'applied' ? 'applied' : 'clicked'))
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
                  markedAppliedAgoDays: c.markedAppliedAgoDays,
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
                      ? `you marked ${group[0].jobTitle} at ${group[0].company} as applied on your tracker`
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
                // Revalidate the exact-posting Practice contract at send
                // time. An open row alone is insufficient: its retained JD
                // may be unreadable or its role may have been deactivated in
                // CMS since this candidate was derived.
                const posting = await JobPosting.findById(c.jobPostingId)
                  .select('domain status closedReason parsedJD parsedJDHash parsedJDRoleVersion jdCompressed jdDisplayCompressed updatedAt')
                  .lean()
                if (!posting || posting.status !== 'open') continue
                const prepared = await preparePracticeHandoffPosting(posting)
                if (!prepared.role || !prepared.jdHash) continue
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
                  beforeDelivery: async () => {
                    if (!c.applicationStatus || !(c.applicationUpdatedAt instanceof Date)) return false
                    const applicationIdentity = {
                      _id: c.applicationId,
                      userId,
                      jobPostingId: c.jobPostingId,
                      status: c.applicationStatus,
                      practiceSessionIds: { $size: 0 },
                      updatedAt: c.applicationUpdatedAt,
                    }
                    const currentPosting = await JobPosting.findById(c.jobPostingId)
                      .select('domain status closedReason parsedJD parsedJDHash parsedJDRoleVersion jdCompressed jdDisplayCompressed updatedAt')
                      .lean()
                    if (!currentPosting || currentPosting.status !== 'open') return false
                    const currentPrepared = await preparePracticeHandoffPosting(currentPosting)
                    if (!currentPrepared.role || currentPrepared.jdHash !== prepared.jdHash) return false

                    const postingIdentity = postingDeliveryIdentityFilter(c.jobPostingId, currentPosting)
                    if (!postingIdentity) return false
                    const [sameApplication, samePosting] = await Promise.all([
                      JobApplication.exists(applicationIdentity),
                      JobPosting.exists(postingIdentity),
                    ])
                    return !!sameApplication && !!samePosting
                  },
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
