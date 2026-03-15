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
}

export async function sendEmail({ to, subject, html }: EmailOptions): Promise<boolean> {
  if (!resend) {
    logger.warn('RESEND_API_KEY not configured, skipping email')
    return false
  }

  try {
    const { error } = await resend.emails.send({
      from: FROM,
      to,
      subject,
      html,
    })

    if (error) {
      logger.error({ error, to, subject }, 'Failed to send email')
      return false
    }

    logger.info({ to, subject }, 'Email sent successfully')
    return true
  } catch (err) {
    logger.error({ err, to, subject }, 'Email service error')
    return false
  }
}
