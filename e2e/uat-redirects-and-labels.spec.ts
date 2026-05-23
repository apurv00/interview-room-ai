import { test, expect } from '@playwright/test'
import { attachConsoleTracking } from './helpers/console-tracker'
import { attachNetworkTracking } from './helpers/network-tracker'

/**
 * End-to-end coverage for two regressions called out in PR review for
 * the UAT-waves-1-4 remediation:
 *
 *   - UAT-022: direct visits to /interview with no localStorage config
 *     must land the user on /interview/setup, not the marketing
 *     homepage `/`. Prior code did router.push('/').
 *   - UAT-013: candidate-facing surfaces must render full domain labels
 *     (e.g. "Product Manager") rather than the title-cased slug ("Pm").
 *     getDomainLabel() now lowercases on lookup, and surfaces that
 *     bypassed it (RecentSessionsStrip) were re-routed through it.
 *
 * Both regressions were code-level fixed in this PR but had no
 * end-to-end signal. These tests run unauthenticated against the dev
 * server; both pages render meaningful HTML even when signed out
 * (deferred-auth wizard for /interview/setup, marketing for /).
 *
 * References:
 *   - app/interview/page.tsx (UAT-022 redirect chain)
 *   - modules/interview/config/interviewConfig.ts (UAT-013 helper)
 *   - middleware.ts (route gating)
 */

test.describe('UAT-022 — /interview redirect target', () => {
  test('direct visit to /interview with no config lands on /interview/setup', async ({ page }) => {
    const consoleTracker = attachConsoleTracking(page)
    const networkTracker = attachNetworkTracking(page)

    // Ensure no stale localStorage config carries over from a prior test
    // run. We must navigate first before we can call evaluate to clear
    // storage on the right origin.
    await page.goto('/')
    await page.evaluate(() => {
      try {
        localStorage.removeItem('INTERVIEW_CONFIG')
        localStorage.removeItem('INTERVIEW_ACTIVE_SESSION')
        // Cover the legacy storage-key shapes too.
        localStorage.removeItem('interviewConfig')
        localStorage.removeItem('interviewActiveSession')
      } catch { /* incognito / restricted */ }
    })

    // Now visit /interview directly. The page should bounce to
    // /interview/setup because there is no INTERVIEW_CONFIG in storage.
    await page.goto('/interview')

    // The redirect is client-side via next/navigation router.push, so
    // wait for the URL to settle.
    await page.waitForURL((url) => url.pathname.startsWith('/interview/setup'), {
      timeout: 5_000,
    })

    // Hard assertion: the URL must NOT be `/` (the pre-fix behavior).
    const finalPath = new URL(page.url()).pathname
    expect(finalPath).not.toBe('/')
    expect(finalPath.startsWith('/interview/setup')).toBe(true)

    networkTracker.assertNoServerErrors()
    consoleTracker.assertNoErrors()
  })
})

test.describe('UAT-013 — domain label rendering', () => {
  test('setup wizard surfaces full domain names, not titlecased slugs', async ({ page }) => {
    const consoleTracker = attachConsoleTracking(page)
    const networkTracker = attachNetworkTracking(page)

    await page.goto('/interview/setup')

    // Wait for the DomainSelector to populate. It hits /api/domains
    // and renders cards as role="option"; first card is the canary.
    const domainList = page.getByRole('listbox', { name: /Interview domains/i })
    await expect(domainList).toBeVisible({ timeout: 10_000 })

    // The visible domain catalog must never display "Pm" / "Swe" / etc.
    // — those are the title-cased fallbacks the bug produced. We check
    // a few of the most-common candidates explicitly so any reintroduced
    // bypass fails loudly.
    const bannedTitleCases = ['Pm', 'Swe', 'Mba', 'Hr', 'Devops']
    for (const banned of bannedTitleCases) {
      // Use a strict, anchored regex so substrings like "Pm" inside
      // longer copy ("Performance metric") never false-positive. The
      // domain card itself wraps its label in a stable element with
      // role="option"; we scope the search to the listbox.
      const offender = domainList.getByRole('option', {
        name: new RegExp(`^${banned}$`, 'i'),
      })
      await expect(
        offender,
        `Domain card should never render the raw slug "${banned}"`,
      ).toHaveCount(0)
    }

    // Sanity: at least one well-known full label should be visible
    // (proves the catalog actually rendered, not just that the negative
    // assertions ran against an empty list).
    const productManagerCard = domainList.getByRole('option', {
      name: /Product Manager/i,
    })
    await expect(productManagerCard).toBeVisible()

    networkTracker.assertNoServerErrors()
    consoleTracker.assertNoErrors()
  })
})
