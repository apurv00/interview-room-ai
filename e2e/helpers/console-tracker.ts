import type { Page, ConsoleMessage } from '@playwright/test'
import { expect } from '@playwright/test'

/**
 * Patterns that are safe to ignore when tracking console errors. These are
 * known-noisy third-party beacons / telemetry that are orthogonal to our
 * application correctness.
 */
const DEFAULT_IGNORE_PATTERNS: RegExp[] = [
  /\/vitals/i,                 // Known analytics endpoint returning 503 — tracked separately.
  /googletagmanager/i,         // GTM beacon failures.
  /google-analytics/i,         // GA beacon failures.
  /sentry\.io/i,               // Sentry beacon failures shouldn't fail the test.
  /DEP0169/,                   // Node.js url.parse() deprecation warning (tracked separately).
  /\bMONGOOSE\b/,              // Server-side Mongoose warnings leak into server logs only.
  /next-auth.*ClientFetchError/, // Fetch races during fast navigation.
  /Failed to load resource.*opengraph-image/, // OG prefetches flake on staging.
  // React 18 SSR/CSR drift — orthogonal to the page-under-test.
  /Hydration failed/i,
  /hydration mismatch/i,
  /Text content does not match/i,
  // CSP violations from known third-party beacons / ad networks only.
  // Intentionally scoped to specific blocked-origin hosts so that a
  // first-party CSP regression (e.g., a broken nonce/hash on
  // `/_next/static/chunks/*` or a blocked same-origin font) still fails
  // the test. googletagmanager / google-analytics / sentry.io are already
  // covered above by plain host rules, so they're not duplicated here.
  /Refused to (?:load|execute|connect|apply|frame) [^\n]*(?:doubleclick|facebook\.(?:net|com)|hotjar|segment\.(?:io|com)|intercom|fullstory|linkedin|clarity\.ms|stripe\.com|cloudflareinsights|cdn\.segment|mixpanel|amplitude|posthog|launchdarkly)/i,
  // Cold-boot image / manifest / font load failures that don't affect page correctness.
  /Failed to load resource.*(favicon|opengraph|apple-icon|icon\?|manifest|fonts\.(gstatic|googleapis))/i,
  // Sentry-style passthrough errors logged as console.error.
  /Non-Error promise rejection captured/i,
  // Benign browser warning that fires on any page with a layout observer.
  /ResizeObserver loop/i,
  // Next.js dev overlay chatter (harmless on staging previews).
  /\[Fast Refresh\]/i,
  /Download the React DevTools/i,
]

interface TrackerOptions {
  /** Extra regexes to ignore in addition to the defaults. */
  ignorePatterns?: RegExp[]
  /** When true, replace the defaults entirely rather than extending. */
  replaceDefaults?: boolean
}

export interface ConsoleTracker {
  /** Errors and uncaught page exceptions captured since the tracker was attached. */
  errors: string[]
  /** Fails the current test if any non-ignored console error was captured. */
  assertNoErrors(): void
}

/**
 * Attach `console.error` + `pageerror` tracking to a Page. Returns a tracker
 * whose `.assertNoErrors()` method should be called at the end of the test.
 *
 * Usage:
 *   const tracker = attachConsoleTracking(page)
 *   await page.goto('/')
 *   tracker.assertNoErrors()
 */
export function attachConsoleTracking(page: Page, opts: TrackerOptions = {}): ConsoleTracker {
  const ignore = opts.replaceDefaults
    ? [...(opts.ignorePatterns ?? [])]
    : [...DEFAULT_IGNORE_PATTERNS, ...(opts.ignorePatterns ?? [])]
  const errors: string[] = []

  const isIgnored = (text: string) => ignore.some((re) => re.test(text))

  const onConsole = (msg: ConsoleMessage) => {
    if (msg.type() !== 'error') return
    const text = msg.text()
    if (isIgnored(text)) return
    errors.push(`[console.error] ${text}`)
  }
  const onPageError = (err: Error) => {
    const text = `${err.message}\n${err.stack ?? ''}`
    if (isIgnored(text)) return
    errors.push(`[pageerror] ${err.message}`)
  }

  page.on('console', onConsole)
  page.on('pageerror', onPageError)

  return {
    errors,
    assertNoErrors() {
      expect(
        errors,
        `Expected no console errors but captured ${errors.length}:\n${errors.join('\n')}`,
      ).toEqual([])
    },
  }
}
