import { JobsEmailSend, User } from '@shared/db/models'
import { sendEmail } from '@shared/services/emailService'
import { mintActionToken } from '@shared/services/signedActionToken'
import { logger } from '@shared/logger'
import type { EmailFooterInput } from '../emails/shared'

/**
 * The transactional send discipline (EMAILS.md §2): send-first with a
 * Resend idempotency key (= the dedupeKey), record after. Provider-side
 * idempotency makes the pair double-safe WITHIN Resend's 24h window, so
 * all automatic re-attempts are bounded to 24h of first-due (callers
 * enforce due-window bounds; this service enforces the ledger).
 *
 * Failure semantics: two same-run attempts; still unsent → an UNSTAMPED
 * ledger row is written. That row is simultaneously the alert (the
 * dashboard's alert-now metric counts unstamped e0/e2 at any age) and the
 * suppression (the dedupeKey is burned — no automatic resend; a human
 * decides from the dashboard). Codex #530/#531.
 */

const APP_URL = process.env.APP_URL || process.env.NEXTAUTH_URL || 'https://www.interviewprep.guru'

export type TransactionalStream = 'e0' | 'e2'

/** Signed unsubscribe URLs for a stream footer (EMAILS.md §3/§4).
 *  Unsub tokens are long-lived: suppression must outlive action windows. */
export function buildFooterUrls(userId: string, stream: TransactionalStream | 'e1' | 'e3' | 'e4'): {
  unsubscribeStreamUrl: string
  unsubscribeAllUrl: string
} {
  const mk = (scope: string) =>
    `${APP_URL}/api/email/unsubscribe?token=${encodeURIComponent(
      mintActionToken({ typ: 'unsub', uid: userId, action: scope, expDays: 365 })
    )}`
  return { unsubscribeStreamUrl: mk(stream), unsubscribeAllUrl: mk('all') }
}

/** RFC 8058 one-click headers (separate immediate-commit endpoint). */
export function oneClickHeaders(userId: string, stream: string): Record<string, string> {
  const token = mintActionToken({ typ: 'unsub', uid: userId, action: stream, expDays: 365 })
  return {
    'List-Unsubscribe': `<${APP_URL}/api/email/unsubscribe/one-click?token=${encodeURIComponent(token)}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  }
}

/** Suppression gate (EMAILS.md §3): stream ∉ list AND 'all' ∉ list. */
export function isSuppressed(
  unsubscribedStreams: string[] | undefined,
  stream: string
): boolean {
  const list = unsubscribedStreams ?? []
  return list.includes(stream) || list.includes('all')
}

export interface TransactionalSendInput {
  userId: string
  stream: TransactionalStream
  dedupeKey: string
  to: string
  subject: string
  html: string
  footer: EmailFooterInput
}

export type TransactionalSendOutcome =
  | { outcome: 'sent'; resendId?: string }
  | { outcome: 'already-sent' }
  | { outcome: 'suppressed' }
  | { outcome: 'failed-alerted' }

export async function sendTransactional(input: TransactionalSendInput): Promise<TransactionalSendOutcome> {
  // Ledger first as a READ: an existing row (stamped or not) means this
  // dedupeKey is done — stamped = delivered, unstamped = burned + alerted.
  const existing = await JobsEmailSend.findOne({
    userId: input.userId,
    stream: input.stream,
    dedupeKey: input.dedupeKey,
  }).lean()
  if (existing) return { outcome: 'already-sent' }

  // Final pref re-check immediately before the send (review R24): an
  // in-window unsubscribe wins over any earlier derivation.
  const user = await User.findById(input.userId).select('emailPreferences.jobs.unsubscribedStreams').lean()
  if (isSuppressed(user?.emailPreferences?.jobs?.unsubscribedStreams, input.stream)) {
    return { outcome: 'suppressed' }
  }

  // Send-first with provider idempotency; two same-run attempts.
  let sent = false
  let resendId: string | undefined
  for (let attempt = 0; attempt < 2 && !sent; attempt++) {
    const res = await sendEmail({
      to: input.to,
      subject: input.subject,
      html: input.html,
      headers: oneClickHeaders(input.userId, input.stream),
      idempotencyKey: `${input.stream}/${input.dedupeKey}`,
    })
    if (res.ok) {
      sent = true
      resendId = res.id
    }
  }

  if (sent) {
    // Record AFTER a successful send. A crash between send and record is
    // covered by the idempotency key within 24h; callers never re-derive
    // past the due window.
    try {
      await JobsEmailSend.create({
        userId: input.userId,
        stream: input.stream,
        dedupeKey: input.dedupeKey,
        sentAt: new Date(),
        resendId,
      })
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err // duplicate = benign race
    }
    return { outcome: 'sent', resendId }
  }

  // Both attempts failed: burn the key with an UNSTAMPED row — the
  // dashboard's alert-now class — and log at error level immediately.
  logger.error(
    { userId: input.userId, stream: input.stream, dedupeKey: input.dedupeKey },
    'transactional email send failed after retries — unstamped ledger row written (alert-now)'
  )
  try {
    await JobsEmailSend.create({
      userId: input.userId,
      stream: input.stream,
      dedupeKey: input.dedupeKey,
    })
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err
  }
  return { outcome: 'failed-alerted' }
}
