import { renderShell, ctaButton, escapeHtml, type EmailFooterInput } from './shared'

/**
 * E1 — response nudge (EMAILS.md §1, solicitation). Sent ONLY for
 * confirmed applications (status=applied — never apply_clicked; the
 * in-app confirm card owns that question). Product-voice subject: we ask
 * the USER for news, never imply we have any. ≥3 due rows for one user
 * collapse into ONE batched email (one cap slot).
 */

export interface E1Row {
  company: string
  jobTitle: string
  markedAppliedAgoDays: number
  interviewUrl: string
  rejectedUrl: string
  nothingYetUrl: string
}

export interface E1Input {
  rows: E1Row[]
  trackerUrl: string
  footer: EmailFooterInput
}

function rowButtons(r: E1Row): string {
  const btn = (href: string, label: string, primary: boolean) =>
    `<a href="${escapeHtml(href)}" style="display:inline-block;${primary ? 'background:#2563eb;color:#ffffff;' : 'background:#f1f5f9;color:#0f172a;'}padding:8px 14px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600;margin:0 8px 8px 0;">${escapeHtml(label)}</a>`
  return `${btn(r.interviewUrl, '🎙 Got an interview', true)}${btn(r.rejectedUrl, 'Rejected', false)}${btn(r.nothingYetUrl, 'Nothing yet', false)}`
}

export function buildE1Email(input: E1Input): { subject: string; html: string } {
  const single = input.rows.length === 1
  const subject = single
    ? `Any news from ${input.rows[0].company}? Tell us in one tap`
    : `Any news on your ${input.rows.length} applications? One tap each`
  const rowsHtml = input.rows
    .map(
      (r) => `
  <div style="border:1px solid #e2e8f0;border-radius:12px;padding:16px;margin:0 0 12px;">
    <p style="font-size:14px;margin:0 0 4px;"><strong>${escapeHtml(r.jobTitle)}</strong> at <strong>${escapeHtml(r.company)}</strong></p>
    <p style="font-size:12px;color:#94a3b8;margin:0 0 12px;">You marked this applied ${r.markedAppliedAgoDays} days ago.</p>
    ${rowButtons(r)}
  </div>`
    )
    .join('')
  const body = `
  <h1 style="font-size:20px;margin:0 0 12px;">${single ? 'Heard anything back?' : 'Quick check-in on your applications'}</h1>
  <p style="font-size:14px;color:#475569;line-height:1.6;margin:0 0 20px;">
    Keeping your tracker current takes one tap — and it keeps your prep pointed
    at applications still marked Applied on your tracker.
  </p>
  ${rowsHtml}
  <p style="font-size:13px;margin:16px 0 0;">
    <a href="${escapeHtml(input.trackerUrl)}" style="color:#2563eb;">Open the full tracker →</a>
  </p>`
  return { subject, html: renderShell(body, input.footer) }
}

/** E4 — deferred practice (EMAILS.md §1, solicitation). Apply-intent-gated.
 *  `intent` branches the copy (Codex #533): an apply_clicked row is an
 *  UNCONFIRMED click — the email must never assert 'you applied' (the
 *  machine-fact vs user-claim rule extends into the inbox). */
export interface E4Input {
  company: string
  jobTitle: string
  practiceUrl: string
  intent: 'clicked' | 'applied'
  footer: EmailFooterInput
}

export function buildE4Email(input: E4Input): { subject: string; html: string } {
  const applied = input.intent === 'applied'
  const subject = applied
    ? `A 20-minute mock for your ${input.company} application`
    : `A 20-minute mock for the ${input.company} role you opened`
  const opener = applied
    ? `You applied to <strong>${escapeHtml(input.jobTitle)}</strong> at
    <strong>${escapeHtml(input.company)}</strong>`
    : `You opened the apply page for <strong>${escapeHtml(input.jobTitle)}</strong> at
    <strong>${escapeHtml(input.company)}</strong>`
  const body = `
  <h1 style="font-size:20px;margin:0 0 12px;">Prep before they call 🎯</h1>
  <p style="font-size:14px;color:#475569;line-height:1.6;margin:0 0 20px;">
    ${opener}. A voice mock built from this exact posting is set for 20 minutes,
    and completed practice stays with this tracked job.
  </p>
  ${ctaButton(input.practiceUrl, 'Take the practice session')}`
  return { subject, html: renderShell(body, input.footer) }
}
