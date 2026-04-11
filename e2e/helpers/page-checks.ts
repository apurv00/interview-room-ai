import type { Page, Response } from '@playwright/test'
import { expect } from '@playwright/test'
import { attachConsoleTracking, type ConsoleTracker } from './console-tracker'
import { attachNetworkTracking, type NetworkTracker } from './network-tracker'

interface TrackedGoto {
  response: Response | null
  consoleTracker: ConsoleTracker
  networkTracker: NetworkTracker
}

/**
 * Navigate to a URL with console + network tracking attached from the very
 * first request. Returns the handles so tests can call
 * `.assertNoErrors()` / `.assertNoServerErrors()` at the end.
 *
 * The trackers MUST be attached before the goto call, so this helper exists
 * primarily to make that ordering hard to get wrong.
 */
export async function gotoAndTrack(page: Page, url: string): Promise<TrackedGoto> {
  const consoleTracker = attachConsoleTracking(page)
  const networkTracker = attachNetworkTracking(page)
  const response = await page.goto(url)
  return { response, consoleTracker, networkTracker }
}

/** Normalize a URL pathname for comparison (strip trailing slash, coerce to '/'). */
function normalizePath(path: string): string {
  const withoutQuery = path.split('?')[0].split('#')[0]
  const stripped = withoutQuery.replace(/\/+$/, '')
  return stripped === '' ? '/' : stripped
}

/**
 * One-liner "the page loads cleanly" assertion:
 *   - navigates to `url`
 *   - asserts final response is a success (2xx) — this catches silent 4xx
 *     regressions where a public page starts returning 404 or a gated page
 *     quietly redirects to /signin
 *   - asserts the final pathname matches the requested path (guards against
 *     unexpected redirects: Playwright's `goto` follows redirects, so the
 *     final URL is what the browser ends up at)
 *   - asserts no console errors
 *   - asserts no 5xx network responses
 *   - asserts page body is non-empty (>100 chars) and does not contain a
 *     stack trace / Next.js error overlay
 *
 * Use this for the parametrized public-page smoke suite. If a page is
 * expected to redirect (like `/resources` → `/learn/guides`), use
 * `gotoAndTrack` directly and assert the target URL yourself.
 */
export async function expectCleanPageLoad(page: Page, url: string): Promise<void> {
  const { response, consoleTracker, networkTracker } = await gotoAndTrack(page, url)

  expect(response, `goto(${url}) returned no Response`).not.toBeNull()
  const status = response!.status()
  // Success range only. 3xx shouldn't appear because goto() follows
  // redirects and reports the final response; 4xx/5xx are real regressions.
  expect(
    status,
    `${url} responded ${status} (expected 2xx)`,
  ).toBeGreaterThanOrEqual(200)
  expect(
    status,
    `${url} responded ${status} (expected 2xx)`,
  ).toBeLessThan(300)

  // Guard against silent redirects. If `/history` suddenly starts bouncing
  // to `/signin`, Playwright would report a 200 from the signin page and
  // this helper would miss the regression without a pathname check.
  const finalUrl = new URL(page.url())
  expect(
    normalizePath(finalUrl.pathname),
    `${url} redirected to ${finalUrl.pathname}`,
  ).toBe(normalizePath(url))

  // Give the client a moment to render but don't wait for networkidle — some
  // pages (notably /learn/guides, see pages-smoke.spec.ts) have long-tail
  // prefetches that we track separately.
  await page.waitForLoadState('domcontentloaded')

  const bodyText = (await page.locator('body').textContent()) ?? ''
  expect(bodyText.length, `${url} rendered an empty body`).toBeGreaterThan(100)
  expect(bodyText, `${url} shows a server-error overlay`).not.toMatch(
    /Internal Server Error|Application error:|Unhandled Runtime Error/,
  )

  networkTracker.assertNoServerErrors()
  consoleTracker.assertNoErrors()
}
