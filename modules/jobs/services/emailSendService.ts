import mongoose from 'mongoose'
import { JobsEmailSend, User } from '@shared/db/models'
import { sendEmail } from '@shared/services/emailService'
import { mintActionToken } from '@shared/services/signedActionToken'
import { logger } from '@shared/logger'
import type { EmailFooterInput } from '../emails/shared'
import {
  activeJobsAccountFilter,
  isJobsAccountActive,
  JobsAccountInactiveError,
  withActiveJobsAccountWrite,
} from '@shared/services/jobsAccountFence'

/**
 * The transactional send discipline (EMAILS.md §2): send-first with a
 * Resend idempotency key (= the dedupeKey), record after. Provider-side
 * idempotency makes the pair double-safe WITHIN Resend's 24h window, so
 * all automatic re-attempts are bounded to 24h of first-due (callers
 * enforce due-window bounds; this service enforces the ledger).
 *
 * Failure semantics: two same-run, still-authorized attempts; still unsent
 * → an UNSTAMPED ledger row is written. Authority changing after ANY
 * provider attempt takes the same alert path because a timeout may have
 * consumed the idempotency key. That row is simultaneously the alert (the
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
  /** Optional source-of-truth check performed immediately before EACH
   *  provider attempt. A confirmed false sends nothing and leaves no ledger
   *  row only when no provider call has occurred. An exception before the
   *  first attempt propagates so durable work can retry. Once a provider call
   *  has happened, any later gate change is delivery-uncertain and burns an
   *  unstamped alert row: a timeout may have consumed the idempotency key. */
  beforeDelivery?: () => Promise<boolean>
}

export type TransactionalSendOutcome =
  | { outcome: 'sent'; resendId?: string }
  | { outcome: 'already-sent' }
  | { outcome: 'suppressed' }
  | { outcome: 'precondition-failed' }
  | { outcome: 'delivery-uncertain-alerted' }
  | { outcome: 'failed-alerted' }

async function burnTransactionalKey(
  input: Pick<TransactionalSendInput, 'userId' | 'stream' | 'dedupeKey'>,
  message: string,
  err?: unknown,
): Promise<void> {
  logger.error(
    { ...(err ? { err } : {}), userId: input.userId, stream: input.stream, dedupeKey: input.dedupeKey },
    message,
  )
  try {
    await withActiveJobsAccountWrite(input.userId, async (dbSession) => {
      await JobsEmailSend.create([{
        userId: input.userId,
        stream: input.stream,
        dedupeKey: input.dedupeKey,
      }], { session: dbSession })
    })
  } catch (createError) {
    if (createError instanceof JobsAccountInactiveError) return
    if ((createError as { code?: number }).code !== 11000) throw createError
  }
}

export async function sendTransactional(input: TransactionalSendInput): Promise<TransactionalSendOutcome> {
  if (!(await isJobsAccountActive(input.userId))) {
    return { outcome: 'precondition-failed' }
  }
  // Ledger first as a READ: an existing row (stamped or not) means this
  // dedupeKey is done — stamped = delivered, unstamped = burned + alerted.
  const existing = await JobsEmailSend.findOne({
    userId: input.userId,
    stream: input.stream,
    dedupeKey: input.dedupeKey,
  }).lean()
  if (existing) return { outcome: 'already-sent' }

  // Send-first with provider idempotency; two same-run attempts.
  let sent = false
  let resendId: string | undefined
  let headers: Record<string, string> | undefined
  for (let attempt = 0; attempt < 2 && !sent; attempt++) {
    try {
      // Preferences, account existence, and the exact recipient are all
      // authority: a deletion, address change, or unsubscribe that lands
      // between provider attempts must win before the next call.
      const user = await User.findOne(activeJobsAccountFilter(input.userId))
        .select('email emailPreferences.jobs.unsubscribedStreams')
        .lean()
      let recipientChanged = !user?.email || user.email !== input.to
      let suppressed = isSuppressed(user?.emailPreferences?.jobs?.unsubscribedStreams, input.stream)
      if (recipientChanged || suppressed) {
        if (attempt === 0) {
          return { outcome: suppressed ? 'suppressed' : 'precondition-failed' }
        }
        await burnTransactionalKey(
          input,
          'transactional email recipient authority changed after provider attempt — delivery uncertain',
        )
        return { outcome: 'delivery-uncertain-alerted' }
      }

      // Re-check on every attempt, not merely once before the retry loop. A
      // legal restriction can commit after a failed provider attempt and must
      // win before the next one.
      if (input.beforeDelivery && !(await input.beforeDelivery())) {
        if (attempt === 0) {
          logger.info(
            { userId: input.userId, stream: input.stream, dedupeKey: input.dedupeKey },
            'transactional email pre-delivery condition changed — delivery skipped',
          )
          return { outcome: 'precondition-failed' }
        }
        await burnTransactionalKey(
          input,
          'transactional email pre-delivery condition changed after provider attempt — delivery uncertain',
        )
        return { outcome: 'delivery-uncertain-alerted' }
      }

      // `beforeDelivery` may itself await CMS and Mongo. Close that window by
      // re-reading account existence, recipient identity, and suppression
      // after it resolves. The remaining Mongo→provider gap is irreducible,
      // but an unsubscribe/delete/address change during policy preparation
      // must not be missed.
      if (input.beforeDelivery) {
        const finalUser = await User.findOne(activeJobsAccountFilter(input.userId))
          .select('email emailPreferences.jobs.unsubscribedStreams')
          .lean()
        recipientChanged = !finalUser?.email || finalUser.email !== input.to
        suppressed = isSuppressed(finalUser?.emailPreferences?.jobs?.unsubscribedStreams, input.stream)
        if (recipientChanged || suppressed) {
          if (attempt === 0) {
            return { outcome: suppressed ? 'suppressed' : 'precondition-failed' }
          }
          await burnTransactionalKey(
            input,
            'transactional email recipient authority changed after provider attempt — delivery uncertain',
          )
          return { outcome: 'delivery-uncertain-alerted' }
        }
      }
    } catch (err) {
      if (attempt === 0) throw err
      await burnTransactionalKey(
        input,
        'transactional email delivery gate failed after provider attempt — delivery uncertain',
        err,
      )
      return { outcome: 'delivery-uncertain-alerted' }
    }

    // Freeze signed headers for this operation. Minting inside the retry
    // loop changes the Resend payload while reusing one idempotency key.
    headers ??= oneClickHeaders(input.userId, input.stream)
    const res = await sendEmail({
      to: input.to,
      subject: input.subject,
      html: input.html,
      headers,
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
    // past the due window. Upsert (rather than create) also stamps an
    // unstamped row won by a concurrent failure path. If both operations
    // observe no row and race their inserts, Mongo's unique index rejects
    // this upsert with E11000; the losing success path then updates the row
    // that won, so confirmed delivery can never remain alert-unstamped.
    const ledgerFilter = {
      userId: input.userId,
      stream: input.stream,
      dedupeKey: input.dedupeKey,
    }
    const successStamp = {
      $set: {
        sentAt: new Date(),
        ...(resendId ? { resendId } : {}),
      },
    }
    try {
      await withActiveJobsAccountWrite(input.userId, (dbSession) =>
        JobsEmailSend.updateOne(
          ledgerFilter,
          successStamp,
          { upsert: true, session: dbSession },
        ),
      )
    } catch (err) {
      if (err instanceof JobsAccountInactiveError) {
        // Delivery already happened. Deletion owns the ledger now and no
        // future send can acquire this account fence.
        return { outcome: 'sent', resendId }
      }
      if ((err as { code?: number }).code !== 11000) throw err
      // The only unique index is the exact ledger identity above. A
      // concurrent burn/success inserted it between our read and upsert;
      // atomically promote that winner to confirmed delivery.
      try {
        await withActiveJobsAccountWrite(input.userId, (dbSession) =>
          JobsEmailSend.updateOne(ledgerFilter, successStamp, { session: dbSession }),
        )
      } catch (retryError) {
        if (!(retryError instanceof JobsAccountInactiveError)) throw retryError
      }
    }
    return { outcome: 'sent', resendId }
  }

  // Both attempts failed: burn the key with an UNSTAMPED row — the
  // dashboard's alert-now class — and log at error level immediately.
  await burnTransactionalKey(
    input,
    'transactional email send failed after retries — unstamped ledger row written (alert-now)',
  )
  return { outcome: 'failed-alerted' }
}

// ── Solicitation discipline (EMAILS.md §2): reserve-FIRST ───────────────────

export type SolicitationStream = 'e1' | 'e4'

export interface SolicitationSendInput {
  userId: string
  stream: SolicitationStream
  /** One reservation per application — a batched email passes several. */
  dedupeKeys: string[]
  to: string
  subject: string
  html: string
  /** The coarse settings toggle this stream rides (EMAILS.md §3) — re-read
   *  with the suppression list at send time (Codex #533). */
  coarseToggle: 'nudges' | 'digest'
  /** Optional source-of-truth check performed after reservation and the
   *  preference re-read, immediately before provider delivery. A false or
   *  failed check releases the unstamped reservation and sends nothing. */
  beforeDelivery?: () => Promise<boolean>
}

export type SolicitationSendOutcome =
  | { outcome: 'sent'; resendId?: string; reserved: string[] }
  | { outcome: 'all-reserved' }
  | { outcome: 'suppressed' }
  | { outcome: 'precondition-failed' }
  | { outcome: 'send-failed' }

/**
 * Reserve-first: ledger rows are inserted BEFORE the send. A duplicate key
 * means that application's slot is burned (sent or reserved earlier) — it
 * drops out; if every key was already reserved there is nothing to send.
 * A send failure leaves the reservations UNSTAMPED: dashboard-surfaced,
 * never auto-retried — losing a nudge is acceptable, double-sending is not.
 */
export async function sendSolicitation(input: SolicitationSendInput): Promise<SolicitationSendOutcome> {
  if (!(await isJobsAccountActive(input.userId))) {
    return { outcome: 'precondition-failed' }
  }
  const reserved: string[] = []
  for (const dedupeKey of input.dedupeKeys) {
    try {
      await withActiveJobsAccountWrite(input.userId, async (dbSession) => {
        await JobsEmailSend.create(
          [{ userId: input.userId, stream: input.stream, dedupeKey }],
          { session: dbSession },
        )
      })
      reserved.push(dedupeKey)
    } catch (err) {
      if (err instanceof JobsAccountInactiveError) {
        return { outcome: 'precondition-failed' }
      }
      if ((err as { code?: number }).code !== 11000) throw err
    }
  }
  if (reserved.length === 0) return { outcome: 'all-reserved' }

  const releaseReservations = async () => {
    await JobsEmailSend.deleteMany({
      userId: input.userId,
      stream: input.stream,
      dedupeKey: { $in: reserved },
      sentAt: { $exists: false },
    })
  }

  const readAuthorityFailure = async (): Promise<'suppressed' | 'precondition-failed' | null> => {
    const currentUser = await User.findOne(activeJobsAccountFilter(input.userId))
      .select('email emailPreferences.jobs')
      .lean()
    if (!currentUser?.email || currentUser.email !== input.to) return 'precondition-failed'
    const jobsPrefs = currentUser.emailPreferences?.jobs as {
      nudges?: boolean
      digest?: boolean
      unsubscribedStreams?: string[]
    } | undefined
    return isSuppressed(jobsPrefs?.unsubscribedStreams, input.stream) ||
      jobsPrefs?.[input.coarseToggle] === false
      ? 'suppressed'
      : null
  }

  // Final suppression re-check between reservation and delivery (Codex
  // #533, mirroring the transactional R24 check): an in-window one-click
  // unsubscribe wins. Releasing the unsent reservations un-burns the keys
  // — the next sweep's upstream suppression filter keeps them silent.
  const initialAuthorityFailure = await readAuthorityFailure()
  if (initialAuthorityFailure) {
    await releaseReservations()
    return { outcome: initialAuthorityFailure }
  }

  if (input.beforeDelivery) {
    let permitted = false
    try {
      permitted = await input.beforeDelivery()
    } catch (err) {
      logger.warn(
        { err, userId: input.userId, stream: input.stream },
        'solicitation pre-delivery check failed — releasing reservation',
      )
    }
    if (!permitted) {
      await releaseReservations()
      return { outcome: 'precondition-failed' }
    }

    // Preference and recipient authority can change while the source-of-
    // truth callback awaits CMS/DB. Re-read them after the callback, not only
    // before it, so the delivery address and consent match the final send.
    const finalAuthorityFailure = await readAuthorityFailure()
    if (finalAuthorityFailure) {
      await releaseReservations()
      return { outcome: finalAuthorityFailure }
    }
  }

  if (!(await isJobsAccountActive(input.userId))) {
    await releaseReservations()
    return { outcome: 'precondition-failed' }
  }
  const res = await sendEmail({
    to: input.to,
    subject: input.subject,
    html: input.html,
    headers: oneClickHeaders(input.userId, input.stream),
  })
  if (!res.ok) {
    logger.error(
      { userId: input.userId, stream: input.stream, reserved },
      'solicitation email send failed — reservations left unstamped (dashboard-surfaced, no auto-retry)'
    )
    return { outcome: 'send-failed' }
  }
  try {
    await withActiveJobsAccountWrite(input.userId, (dbSession) =>
      JobsEmailSend.updateMany(
        { userId: input.userId, stream: input.stream, dedupeKey: { $in: reserved } },
        { $set: { sentAt: new Date(), resendId: res.id } },
        { session: dbSession },
      ),
    )
  } catch (error) {
    if (!(error instanceof JobsAccountInactiveError)) throw error
  }
  return { outcome: 'sent', resendId: res.id, reserved }
}

/** Rolling 7-day solicitation count for the weekly cap (e0/e2 exempt).
 *  Counts EMAILS, not ledger rows (Codex #533): a batched E1 stamps one
 *  row per application sharing a single resendId — one email = one cap
 *  unit. Rows group on resendId (sentAt fallback for id-less providers). */
export async function solicitationSentLast7d(userId: string, now = new Date()): Promise<number> {
  const groups: Array<{ n: number }> = await JobsEmailSend.aggregate([
    {
      $match: {
        userId: new mongoose.Types.ObjectId(userId),
        stream: { $in: ['e1', 'e3', 'e4'] },
        sentAt: { $gte: new Date(now.getTime() - 7 * 86_400_000) },
      },
    },
    { $group: { _id: { $ifNull: ['$resendId', '$sentAt'] } } },
    { $count: 'n' },
  ])
  return groups[0]?.n ?? 0
}
