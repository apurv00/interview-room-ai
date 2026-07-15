import { renderShell, ctaButton, escapeHtml, type EmailFooterInput } from './shared'

/**
 * E2 — T-1 interview reminder (EMAILS.md §1, transactional; the user set
 * the date, which is the request). Two variants:
 * - full: prep plan + warm-up CTA
 * - logisticsOnly: a session happened in the last 24h — no warm-up push,
 *   the user is already warm (review R10); just the good-luck logistics.
 */
export interface E2Input {
  company: string
  jobTitle: string
  /** Display label, already formatted ("tomorrow" / "this week"). */
  whenLabel: string
  prepPlanUrl: string
  warmUpUrl: string
  logisticsOnly: boolean
  footer: EmailFooterInput
}

export function buildE2Email(input: E2Input): { subject: string; html: string } {
  const subject = `Your ${input.company} interview is ${input.whenLabel} — you've got this`
  const body = input.logisticsOnly
    ? `
  <h1 style="font-size: 20px; margin: 0 0 12px;">Interview ${escapeHtml(input.whenLabel)}: ${escapeHtml(input.company)} 🍀</h1>
  <p style="font-size: 14px; color: #475569; line-height: 1.6; margin: 0 0 20px;">
    You practiced recently, so we'll keep this short: sleep well, keep your
    resume and the job post open, and arrive five minutes early. Your prep
    plan for <strong>${escapeHtml(input.jobTitle)}</strong> is here if you want one last look.
  </p>
  ${ctaButton(input.prepPlanUrl, 'Open your prep plan')}`
    : `
  <h1 style="font-size: 20px; margin: 0 0 12px;">Interview ${escapeHtml(input.whenLabel)}: ${escapeHtml(input.company)} 🎯</h1>
  <p style="font-size: 14px; color: #475569; line-height: 1.6; margin: 0 0 20px;">
    Tomorrow-you will thank today-you for a 15-minute warm-up. Your prep plan
    for <strong>${escapeHtml(input.jobTitle)}</strong> at <strong>${escapeHtml(input.company)}</strong>
    has a session built from this exact posting.
  </p>
  ${ctaButton(input.warmUpUrl, 'Take a warm-up session')}
  <p style="font-size: 13px; margin: 16px 0 0;">
    <a href="${escapeHtml(input.prepPlanUrl)}" style="color: #2563eb;">Or review your prep plan →</a>
  </p>
  <p style="font-size: 12px; color: #94a3b8; margin: 16px 0 0;">
    Date changed? Update it from the prep plan and your reminder moves with it.
  </p>`
  return { subject, html: renderShell(body, input.footer) }
}
