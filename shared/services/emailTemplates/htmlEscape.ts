/**
 * Minimal HTML entity escaping for email templates and any other place
 * where user-supplied text is interpolated into HTML.
 *
 * Do NOT use this for inline JS or CSS contexts — it only handles HTML
 * element/attribute contexts. For attributes, always wrap the value in
 * double quotes: <a href="${escapeHtml(url)}">.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
