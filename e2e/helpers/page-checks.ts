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

/**
 * One-liner "the page loads cleanly" assertion:
 *   - navigates to `url`
 *   - asserts status < 500
 *   - asserts no console errors
 *   - asserts no 5xx network responses
 *   - asserts page body is non-empty (>100 chars) and does not contain a
 *     stack trace / Next.js error overlay
 *
 * Use this for the parametrized public-page smoke suite.
 */
export async function expectCleanPageLoad(page: Page, url: string): Promise<void> {
  const { response, consoleTracker, networkTracker } = await gotoAndTrack(page, url)

  expect(response, `goto(${url}) returned no Response`).not.toBeNull()
  const status = response!.status()
  expect(status, `${url} responded ${status}`).toBeLessThan(500)

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
