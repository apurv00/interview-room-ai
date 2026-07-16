/**
 * Tailored-resume naming — pure, client-safe (the tailor page deep-imports
 * this; the barrel drags server deps).
 *
 * Founder catch 2026-07-16: tailoring an already-tailored resume stacked
 * suffixes — their own account held "Apurv Resume.pdf (Tailored) (Tailored)".
 * The base name is stripped of ANY existing (Tailored…) suffixes — looped,
 * so legacy stacked names heal on their next save — before the single
 * suffix is appended.
 */

/** Strip trailing "(Tailored…)" groups by BALANCED-paren scanning, not
 *  regex: company names may themselves contain parentheses — "Acme
 *  (India)" made the old `[^)]*` regex stop at the inner ')' and the
 *  stacking bug survived for exactly those names (Codex #540 round 3).
 *  Only a trailing group that STARTS with "Tailored" is stripped, so
 *  odd user-chosen base names keep their own parentheticals. */
function stripTailoredSuffixes(name: string): string {
  let s = name.trim()
  for (;;) {
    if (!s.endsWith(')')) return s
    let depth = 0
    let start = -1
    for (let i = s.length - 1; i >= 0; i--) {
      const ch = s[i]
      if (ch === ')') depth += 1
      else if (ch === '(') {
        depth -= 1
        if (depth === 0) {
          start = i
          break
        }
      }
    }
    if (start < 0) return s // unbalanced — leave the name alone
    if (!/^Tailored\b/.test(s.slice(start + 1, s.length - 1))) return s
    s = s.slice(0, start).trim()
  }
}

export function tailoredResumeName(baseName: string | undefined | null, companyName?: string): string {
  const base = stripTailoredSuffixes(baseName ?? '') || 'Resume'
  return `${base} (Tailored${companyName ? ` for ${companyName}` : ''})`
}
