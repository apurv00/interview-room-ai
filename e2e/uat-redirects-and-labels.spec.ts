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

    // The CategoryDomainPicker mounts on the category grid. Roles live behind
    // categories/search, so we use the search box (which hits the same
    // /api/domains data) to surface each role and assert it renders under its
    // FULL label — never the title-cased slug the bug produced ("Pm", "Devops").
    await expect(page.getByRole('listbox', { name: /Interview fields/i })).toBeVisible({ timeout: 10_000 })
    const search = page.getByLabel('Search roles')

    // Searching a role's slug must surface the full-name option. If a label
    // regressed to its raw title-cased slug, the full name would not appear and
    // these assertions would fail loudly.
    const cases = [
      { query: 'pm', label: /Product Manager/i },
      { query: 'devops', label: /DevOps/i },
      { query: 'frontend', label: /Frontend Engineer/i },
    ]
    for (const c of cases) {
      await search.fill(c.query)
      await expect(
        page.getByRole('option', { name: c.label }),
        `Searching "${c.query}" should surface the full role label, not a raw slug`,
      ).toBeVisible({ timeout: 10_000 })
    }

    networkTracker.assertNoServerErrors()
    consoleTracker.assertNoErrors()
  })
})
