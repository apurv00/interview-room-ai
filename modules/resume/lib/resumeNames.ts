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

const TAILORED_SUFFIX = /\s*\(Tailored[^)]*\)\s*$/

export function tailoredResumeName(baseName: string | undefined | null, companyName?: string): string {
  let base = (baseName ?? '').trim()
  while (TAILORED_SUFFIX.test(base)) base = base.replace(TAILORED_SUFFIX, '').trim()
  if (!base) base = 'Resume'
  return `${base} (Tailored${companyName ? ` for ${companyName}` : ''})`
}
