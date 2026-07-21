import { renderShell, ctaButton, escapeHtml, type EmailFooterInput } from './shared'

/**
 * E0 — "Tonight's practice link" (EMAILS.md §1, transactional). The user
 * ASKED for this email; the copy honors that: no selling, no nudging, just
 * the link they requested with enough context to act on a phone.
 */
export interface E0Input {
  company: string
  jobTitle: string
  practiceUrl: string
  footer: EmailFooterInput
}

export function buildE0Email(input: E0Input): { subject: string; html: string } {
  const subject = `Your practice link — ${input.jobTitle} at ${input.company}`
  const body = `
  <h1 style="font-size: 20px; margin: 0 0 12px;">Ready when you are 🎙</h1>
  <p style="font-size: 14px; color: #475569; line-height: 1.6; margin: 0 0 20px;">
    Here's the practice session you asked for — a voice mock built from the
    <strong>${escapeHtml(input.jobTitle)}</strong> posting at <strong>${escapeHtml(input.company)}</strong>.
    Find a quiet spot, plug in your mic, and take it when you're ready.
  </p>
  ${ctaButton(input.practiceUrl, 'Start the practice session')}
  <p style="font-size: 12px; color: #94a3b8; margin: 16px 0 0;">
    Completed practice from this link stays with this tracked job.
  </p>`
  return { subject, html: renderShell(body, input.footer) }
}
