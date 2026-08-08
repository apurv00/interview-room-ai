import { escapeHtml } from '@shared/services/emailTemplates/htmlEscape'

/**
 * AI interview invite — pure template (modules/jobs/emails convention):
 * typed inputs in, {subject, html, text} out; zero DB access; the URL and
 * token are minted by aiRoundService, never here. Every interpolation is
 * escaped — recruiter- and candidate-controlled strings reach this template.
 */
export interface AiInviteEmailParams {
  candidateName?: string
  jobTitle: string
  workspaceName: string
  inviteUrl: string
  expiryDays: number
  /** True when the round's authMode is 'otp' — the copy explains the
   * 6-digit code step instead of promising direct entry. */
  verifyByCode: boolean
}

export function buildAiInviteEmail(params: AiInviteEmailParams): {
  subject: string
  html: string
  text: string
} {
  const name = params.candidateName ? escapeHtml(params.candidateName.split(' ')[0]) : 'there'
  const job = escapeHtml(params.jobTitle)
  const company = escapeHtml(params.workspaceName)
  const url = escapeHtml(params.inviteUrl)

  const subject = `${params.workspaceName}: your interview for ${params.jobTitle}`

  const verifyHtml = params.verifyByCode
    ? 'To keep things secure, we&rsquo;ll email you a 6-digit code to confirm it&rsquo;s you when you start &mdash; no account or password needed.'
    : 'No account, password, or code needed &mdash; the button takes you straight there.'
  const verifyText = params.verifyByCode
    ? 'To keep things secure, we will email you a 6-digit code to confirm it is you when you start — no account or password needed.'
    : 'No account, password, or code needed — the link below takes you straight there.'

  const html = `
<div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a2e;">
  <h2 style="margin: 0 0 16px;">Hi ${name},</h2>
  <p style="line-height: 1.6;">
    <strong>${company}</strong> has invited you to complete a short AI-led
    interview for the <strong>${job}</strong> position. It takes about
    15&ndash;30 minutes and you can do it whenever suits you.
  </p>
  <p style="line-height: 1.6;">
    Before it starts you&rsquo;ll see exactly what is recorded and how it is
    used, and you&rsquo;ll be asked for your consent. ${verifyHtml} This link is
    personal to you, so please don&rsquo;t forward this email.
  </p>
  <p style="margin: 28px 0;">
    <a href="${url}" style="background: #4f46e5; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">
      Start your interview
    </a>
  </p>
  <p style="line-height: 1.6; color: #555;">
    This link is personal to you and expires in ${params.expiryDays} days.
    If the button doesn't work, copy this address into your browser:<br/>
    <span style="word-break: break-all;">${url}</span>
  </p>
</div>`.trim()

  const text = [
    `Hi ${params.candidateName?.split(' ')[0] ?? 'there'},`,
    '',
    `${params.workspaceName} has invited you to complete a short AI-led interview for the ${params.jobTitle} position.`,
    '',
    `Before it starts you will see exactly what is recorded and how it is used, and you will be asked for your consent. ${verifyText} The link is personal to you, so please do not forward this email.`,
    '',
    `Start here: ${params.inviteUrl}`,
    '',
    `This link is personal to you and expires in ${params.expiryDays} days.`,
  ].join('\n')

  return { subject, html, text }
}
