/**
 * Pathway-context URL parser, shared between any page reachable from
 * `buildDrillHref` / `buildInterviewSetupHref` in
 * [`pathwayViewModel.ts`](../services/pathwayViewModel.ts).
 *
 * Extracted from `InterviewSetupForm.tsx` (Wave 5) so the Drill page can
 * reuse the same parser instead of duplicating it. The original lived
 * inline next to the form state; moving it here also surfaces a latent
 * open-redirect risk on `returnTo` that the original only clamped (to
 * 500 chars) but never validated as a same-origin path — see
 * `validateReturnTo` below.
 *
 * Pure function, no React/Next dependencies — accepts any
 * `URLSearchParams`-like reader.
 */

/**
 * Minimal `URLSearchParams` shape so callers can pass either:
 *   - the native `URLSearchParams` object, or
 *   - the result of Next.js's `useSearchParams()` hook
 *     (both implement `get(name): string | null`).
 *
 * Decouples the util from `next/navigation` so this file can be unit-
 * tested without a Next runtime.
 */
export interface SearchParamReader {
  get(name: string): string | null
}

export interface PathwaySetupContext {
  source: 'pathway'
  actionId?: string
  domain?: string
  interviewType?: string
  difficulty?: string
  focus?: string[]
  /**
   * Where to return after the user finishes the downstream action.
   * RAW value as parsed from the URL — callers MUST gate this through
   * `validateReturnTo()` before rendering it into an href, otherwise
   * an attacker can craft `?returnTo=https://evil.com` and an injected
   * "Back" button becomes an open redirect.
   */
  returnTo?: string
}

/**
 * Parse pathway-context query params from the current URL.
 *
 * Returns `null` when `source` is not `'pathway'` — every consumer
 * already branches on that case (the cards/strips render nothing for
 * non-pathway entries), so a null return signals "no pathway context
 * to surface" rather than "no params at all".
 *
 * All string values are length-capped to defend against quota abuse
 * from a forged URL (e.g. someone manually pasting a 10MB
 * `?difficulty=` param). Caps were chosen to match the original local
 * implementation in InterviewSetupForm.tsx so the extraction is
 * behaviour-preserving.
 */
export function readPathwaySetupContext(
  searchParams: SearchParamReader | null | undefined,
): PathwaySetupContext | null {
  if (searchParams?.get('source') !== 'pathway') return null

  const clean = (value: string | null, max = 120) => {
    const trimmed = value?.trim()
    return trimmed ? trimmed.slice(0, max) : undefined
  }

  const focus = clean(searchParams.get('focus'), 1000)
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 10)

  return {
    source: 'pathway',
    actionId: clean(searchParams.get('actionId')),
    domain: clean(searchParams.get('domain'), 50),
    interviewType: clean(searchParams.get('interviewType'), 50),
    difficulty: clean(searchParams.get('difficulty'), 40),
    focus,
    returnTo: clean(searchParams.get('returnTo'), 500),
  }
}

/**
 * Allowlist of route prefixes that may appear in a `returnTo` URL
 * param. Every other path (and any absolute http(s) URL) is rejected.
 *
 * Add a route here ONLY if it's a legitimate landing surface after a
 * pathway-driven action. Keeping the list tight is the whole point —
 * pre-extraction, `InterviewSetupForm` clamped `returnTo` to 500 chars
 * but did not validate the path at all, so a forged URL like
 * `?returnTo=https://evil.example.com` could render a "Back" button
 * that opened a phishing page. This util closes that gap.
 */
const RETURN_TO_ALLOWED_PREFIXES = [
  '/learn/',
  '/feedback/',
  '/interview/',
  '/practice/',
  '/dashboard',
] as const

/**
 * Validate a `returnTo` URL param. Returns the path when it's safe to
 * render into an href, or `null` when the param is missing, absolute,
 * or points to an unrecognised route.
 *
 * Same-origin paths starting with `/` ARE permitted as long as they
 * match an allowlisted prefix. Absolute URLs (any `://`) and
 * protocol-relative URLs (`//foo.com`) are always rejected — even when
 * the host happens to be the current domain, because the same-origin
 * check would need request context that isn't available client-side.
 */
export function validateReturnTo(raw: string | undefined | null): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  // Reject any URL that could navigate cross-origin. Includes
  // `//evil.com/...` (protocol-relative) and `https://evil.com/...`.
  if (trimmed.includes('://') || trimmed.startsWith('//')) return null
  // Must start with `/` to be a same-origin path; rejects scheme-less
  // schemes like `javascript:alert(1)` because they don't start with `/`.
  if (!trimmed.startsWith('/')) return null
  // Path must match one of the allowlisted prefixes.
  const allowed = RETURN_TO_ALLOWED_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
  return allowed ? trimmed : null
}
