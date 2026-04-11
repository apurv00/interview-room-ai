import type { Page, Response } from '@playwright/test'
import { expect } from '@playwright/test'

/**
 * URLs that are allowed to return 5xx without failing the test. These are
 * known-broken or deliberately-unreliable third-party endpoints whose health
 * is orthogonal to the page-under-test.
 */
const DEFAULT_ALLOWLIST: (string | RegExp)[] = [
  /\/vitals(\/|$|\?)/i,          // Web-vitals analytics (known 503 — tracked separately).
  /googletagmanager/i,
  /google-analytics/i,
  /sentry\.io/i,
  /\/api\/analytics/i,
  // Next.js image / metadata routes that can cold-boot 5xx but don't affect
  // page correctness.
  /\/opengraph-image/i,
  /\/apple-icon/i,
  /\/icon(\?|$)/i,
  /manifest\.webmanifest/i,
  /\/favicon\.ico/i,
  // Third-party fonts — failure falls back to system fonts, not a page break.
  /fonts\.(gstatic|googleapis)\.com/i,
]

interface TrackerOptions {
  /** Extra allowlist entries. Matched by `string.includes` or `regex.test`. */
  allowlist?: (string | RegExp)[]
  /** When true, replace the defaults entirely rather than extending. */
  replaceDefaults?: boolean
}

export interface ServerErrorRecord {
  url: string
  status: number
  method: string
}

export interface NetworkTracker {
  /** Server errors (status >= 500) captured since the tracker was attached. */
  serverErrors: ServerErrorRecord[]
  /** Fails the current test if any non-allowlisted 5xx was captured. */
  assertNoServerErrors(): void
}

function matchesAllowlist(url: string, allowlist: (string | RegExp)[]): boolean {
  return allowlist.some((entry) =>
    typeof entry === 'string' ? url.includes(entry) : entry.test(url),
  )
}

/**
 * Attach response-status tracking to a Page. Returns a tracker whose
 * `.assertNoServerErrors()` should be called at the end of the test.
 *
 * Any response with status >= 500 that does not match the allowlist is
 * recorded and will fail the assertion.
 */
export function attachNetworkTracking(page: Page, opts: TrackerOptions = {}): NetworkTracker {
  const allowlist = opts.replaceDefaults
    ? [...(opts.allowlist ?? [])]
    : [...DEFAULT_ALLOWLIST, ...(opts.allowlist ?? [])]
  const serverErrors: ServerErrorRecord[] = []

  const onResponse = (response: Response) => {
    const status = response.status()
    if (status < 500) return
    const url = response.url()
    if (matchesAllowlist(url, allowlist)) return
    serverErrors.push({ url, status, method: response.request().method() })
  }

  page.on('response', onResponse)

  return {
    serverErrors,
    assertNoServerErrors() {
      expect(
        serverErrors,
        `Expected no 5xx responses but captured ${serverErrors.length}:\n` +
          serverErrors.map((r) => `  ${r.status} ${r.method} ${r.url}`).join('\n'),
      ).toEqual([])
    },
  }
}
