import { NextResponse } from 'next/server'
import { connectDB } from '@shared/db/connection'
import { JobApplication, JobsEmailSend } from '@shared/db/models'
import { verifyActionToken } from '@shared/services/signedActionToken'
import { transitionStatus } from '@jobs'
import { checkJobsRateLimit } from '@jobs/services/rateLimit'

export const dynamic = 'force-dynamic'

/**
 * One-tap status actions from E1 emails (EMAILS.md §4). GET renders a
 * confirm page (mail scanners must never mutate state — same rationale as
 * unsubscribe); POST commits. Tokens are single-PURPOSE: the action is
 * inside the token, so a [Rejected] token can never mark an interview.
 *
 * Honesty rules enforced here:
 * - [Nothing yet] writes ONLY outcome.lastAskedAt — an ANSWER that defers
 *   future asks, never a status flip (the user said nothing happened).
 * - Stale-guard compares against the last source:'user' transition AFTER
 *   the email was sent: a system auto-ghost NEVER blocks a token action
 *   (ghosted is recoverable by design; a machine guess must not override
 *   a user claim), but a user's own later correction wins over the email.
 * - Every commit routes through applicationService.transitionStatus — the
 *   single jobs.interview_scheduled emitter, channel 'email'.
 */

const ACTIONS = new Set(['interview_scheduled', 'rejected', 'nothing-yet'])

const page = (inner: string, status = 200) =>
  new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Update your tracker</title></head><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:80px auto;padding:0 24px;color:#0f172a;">${inner}</body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer' } }
  )

const invalidPage = () =>
  page(`<h1 style="font-size:20px;">This link isn't valid anymore</h1>
    <p style="color:#475569;font-size:14px;">It may have expired. Your tracker always has the latest — sign in to update it there.</p>
    <a href="/jobs/tracker" style="color:#2563eb;font-size:14px;">Open the tracker →</a>`)

const ACTION_COPY: Record<string, { title: string; button: string }> = {
  interview_scheduled: { title: 'You got an interview — congrats! Confirm to update your tracker.', button: '🎙 Yes, I got the interview' },
  rejected: { title: 'Mark this application as rejected?', button: 'Yes, mark rejected' },
  'nothing-yet': { title: 'No response yet — we’ll stop asking about this one for a while.', button: 'Confirm' },
}

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get('token') ?? ''
  const v = verifyActionToken(token, 'status')
  if (!v.ok || !v.payload.aid || !ACTIONS.has(v.payload.action)) return invalidPage()
  const copy = ACTION_COPY[v.payload.action]
  // No personal/job data rendered — the token in the URL must stay
  // worthless to a log/Referer snoop (EMAILS.md §4).
  return page(`<h1 style="font-size:20px;">${copy.title}</h1>
    <form method="POST" action="/api/jobs/email-action?token=${encodeURIComponent(token)}">
      <button type="submit" style="background:#2563eb;color:#fff;border:none;border-radius:8px;padding:12px 24px;font-size:14px;font-weight:600;cursor:pointer;">${copy.button}</button>
    </form>`)
}

export async function POST(req: Request) {
  const token = new URL(req.url).searchParams.get('token') ?? ''
  const v = verifyActionToken(token, 'status')
  if (!v.ok || !v.payload.aid || !ACTIONS.has(v.payload.action)) return invalidPage()
  const { uid, aid, action, dk } = v.payload
  const rateLimitBlock = await checkJobsRateLimit(uid, 'email-action')
  if (rateLimitBlock) {
    const response = page(`<h1 style="font-size:20px;">Too many update attempts</h1>
      <p style="color:#475569;font-size:14px;">Please wait before trying this email action again. Your tracker is unchanged.</p>`, 429)
    const retryAfter = rateLimitBlock.headers.get('Retry-After')
    if (retryAfter) response.headers.set('Retry-After', retryAfter)
    return response
  }

  await connectDB()
  const app = await JobApplication.findOne({ _id: aid, userId: uid })
    .select('jobPostingId status statusHistory outcome')
    .lean()
  if (!app) return invalidPage()

  // Stale-guard (EMAILS.md §4): only a USER transition made AFTER this
  // email went out blocks the token — the send instant comes from the
  // ledger row the dk binds to. System moves (auto-ghost) never block.
  if (dk) {
    const send = await JobsEmailSend.findOne({ userId: uid, stream: 'e1', dedupeKey: dk }).select('sentAt').lean()
    const sentAt = send?.sentAt ? new Date(send.sentAt).getTime() : 0
    const laterUserMove = (app.statusHistory ?? []).some(
      (h: { source?: string; at?: Date }) => h.source === 'user' && h.at && new Date(h.at).getTime() > sentAt
    )
    if (laterUserMove) {
      return page(`<h1 style="font-size:20px;">Your tracker is already ahead of this email</h1>
        <p style="color:#475569;font-size:14px;">You updated this application after we sent that note — we didn't change anything.</p>
        <a href="/jobs/tracker" style="color:#2563eb;font-size:14px;">See it in the tracker →</a>`)
    }
  }

  if (action === 'nothing-yet') {
    // An ANSWER, not a transition: defer future response asks (shared
    // ledger with the in-app nudges), change nothing else.
    await JobApplication.updateOne({ _id: aid, userId: uid }, { $set: { 'outcome.lastAskedAt': new Date() } })
    return page(`<h1 style="font-size:20px;">Got it — fingers crossed 🤞</h1>
      <p style="color:#475569;font-size:14px;">We'll stop asking about this one for a while. If news lands, one tap in the tracker updates it.</p>`)
  }

  const result = await transitionStatus(uid, String(app.jobPostingId), action as 'interview_scheduled' | 'rejected', { channel: 'email' })
  if (!result.ok) return invalidPage()

  if (action === 'interview_scheduled') {
    // Continue to the date sheet: the detail page shows it for scheduled
    // rows without a date; sign-in (if needed) preserves the URL.
    return page(`<h1 style="font-size:20px;">Marked — now let's get you ready 🎯</h1>
      <p style="color:#475569;font-size:14px;">Tell us when it is and your prep plan (and a T-1 reminder) build themselves.</p>
      <a href="/jobs/${app.jobPostingId}" style="display:inline-block;background:#2563eb;color:#fff;border-radius:8px;padding:12px 24px;font-size:14px;font-weight:600;text-decoration:none;">Set the date →</a>`)
  }
  return page(`<h1 style="font-size:20px;">Updated — their loss</h1>
    <p style="color:#475569;font-size:14px;">Marked rejected. Your practice evidence stays yours — it counts toward every similar role on the feed.</p>
    <a href="/jobs" style="color:#2563eb;font-size:14px;">See similar live jobs →</a>`)
}
