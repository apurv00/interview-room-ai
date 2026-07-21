/**
 * Shared email building blocks (EMAILS.md §5). Templates are PURE — typed
 * inputs in, {subject, html} out; zero DB access; display labels only
 * (never raw status enums); URLs and tokens are minted by the send
 * service, never inside templates.
 */

export interface EmailFooterInput {
  /** The TRUE trigger fact, already phrased ("you asked for a practice link
   * for X" / "you set an interview date for X"). */
  whyLine: string
  unsubscribeStreamUrl: string
  unsubscribeAllUrl: string
}

/** Subjects must be product-voice: never imply employer contact or an
 *  application-status change we don't possess (EMAILS.md §5 / review R9).
 *  Template tests assert every subject against this list. */
export const BANNED_SUBJECT_PATTERNS: RegExp[] = [
  /update on your .* application/i,
  /your application (?:status|update)/i,
  /(?:^|\s)from (?:the )?(?:hiring|recruiting) team/i,
  /interview (?:invitation|invite)(?!\s+prep)/i,
  /you(?:'ve| have) been (?:shortlisted|selected)/i,
  /regarding your (?:interview|application)/i,
]

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function renderFooter(f: EmailFooterInput): string {
  return `
  <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 28px 0 16px;" />
  <p style="color: #94a3b8; font-size: 12px; line-height: 1.6; margin: 0;">
    You're receiving this because ${esc(f.whyLine)}.<br />
    <a href="${esc(f.unsubscribeStreamUrl)}" style="color: #94a3b8; text-decoration: underline;">Stop these emails</a>
    &nbsp;·&nbsp;
    <a href="${esc(f.unsubscribeAllUrl)}" style="color: #94a3b8; text-decoration: underline;">Stop all job emails</a>
  </p>`
}

/** The light-slate shell every jobs email renders inside. */
export function renderShell(bodyHtml: string, footer: EmailFooterInput): string {
  return `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px; color: #0f172a;">
${bodyHtml}
${renderFooter(footer)}
</div>`
}

export function ctaButton(href: string, label: string): string {
  return `<a href="${esc(href)}" style="display: inline-block; background: #2563eb; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 600;">${esc(label)}</a>`
}

export { esc as escapeHtml }
