import { Resend } from 'resend'
import { logger } from '@shared/logger'

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null

const FROM = process.env.EMAIL_FROM || 'Interview Prep Guru <noreply@interviewprep.guru>'

interface EmailOptions {
  to: string
  subject: string
  html: string
  /** Plain-text alternative for accessibility and conservative mail clients. */
  text?: string
  /** Extra SMTP headers — e.g. List-Unsubscribe / List-Unsubscribe-Post
   *  (RFC 8058) on jobs emails. */
  headers?: Record<string, string>
  replyTo?: string
  /** Resend-side dedupe (EMAILS.md §2 transactional discipline). Only
   *  meaningful within Resend's 24h idempotency window. */
  idempotencyKey?: string
}

export interface SendEmailResult {
  ok: boolean
  /** Resend send id — the JobsEmailSend ledger stamps this. */
  id?: string
}

export async function sendEmail({ to, subject, html, text, headers, replyTo, idempotencyKey }: EmailOptions): Promise<SendEmailResult> {
  if (!resend) {
    logger.warn('RESEND_API_KEY not configured, skipping email')
    return { ok: false }
  }

  try {
    const { data, error } = await resend.emails.send(
      { from: FROM, to, subject, html, ...(text ? { text } : {}), ...(headers ? { headers } : {}), ...(replyTo ? { replyTo } : {}) },
      idempotencyKey ? { idempotencyKey } : undefined
    )

    if (error) {
      logger.error({ error, to, subject }, 'Failed to send email')
      return { ok: false }
    }

    logger.info({ to, subject, id: data?.id }, 'Email sent successfully')
    return { ok: true, id: data?.id }
  } catch (err) {
    logger.error({ err, to, subject }, 'Email service error')
    return { ok: false }
  }
}
