import { escapeHtml } from './htmlEscape'

interface InviteOtpEmail {
  subject: string
  html: string
  text: string
}

/**
 * Email body for the 6-digit OTP that authenticates a candidate before
 * they take an invited interview. The code itself goes in both the
 * subject preview text and the body for accessibility.
 *
 * All interpolated values are escaped — code is numeric-only by contract
 * but we escape anyway as a belt-and-braces defence.
 */
export function buildInviteOtpEmail(params: {
  code: string
  candidateName?: string
  orgName?: string
  expiryMinutes: number
}): InviteOtpEmail {
  const { code, candidateName, orgName, expiryMinutes } = params
  const safeCode = escapeHtml(code)
  const safeName = candidateName ? escapeHtml(candidateName) : null
  const safeOrg = orgName ? escapeHtml(orgName) : 'your interviewer'

  const subject = `Your interview access code: ${code}`

  const text = [
    safeName ? `Hi ${candidateName},` : 'Hi,',
    '',
    `Your one-time code to start the interview with ${orgName ?? 'your interviewer'} is:`,
    '',
    `    ${code}`,
    '',
    `This code expires in ${expiryMinutes} minutes. If you didn't request it, you can ignore this email.`,
  ].join('\n')

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #0f1419;">
      <h2 style="margin: 0 0 16px; font-size: 20px;">Your interview access code</h2>
      ${safeName ? `<p style="color: #536471; margin: 0 0 16px;">Hi ${safeName},</p>` : ''}
      <p style="color: #536471; margin: 0 0 24px;">
        Enter this code on the interview page to get started with ${safeOrg}:
      </p>
      <div style="background: #f1f5f9; border-radius: 10px; padding: 20px; text-align: center; font-size: 28px; font-weight: 700; letter-spacing: 8px; color: #0f1419; margin: 0 0 24px;">
        ${safeCode}
      </div>
      <p style="color: #8b98a5; font-size: 13px; margin: 0;">
        This code expires in ${expiryMinutes} minutes. If you didn't request it, you can ignore this email.
      </p>
    </div>
  `.trim()

  return { subject, html, text }
}
