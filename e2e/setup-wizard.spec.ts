import { test, expect, type Page } from '@playwright/test'
import { attachConsoleTracking } from './helpers/console-tracker'
import { attachNetworkTracking } from './helpers/network-tracker'

/**
 * Pick the Frontend Engineer domain via the two-screen CategoryDomainPicker:
 * the "Interview fields" grid → the Programming category → the Frontend Engineer
 * role. (CategoryDomainPicker fetches /api/categories + /api/domains; we wait for
 * the role option to be visible before clicking to avoid a re-render race.)
 */
async function selectFrontendDomain(page: Page) {
  await expect(page.getByRole('listbox', { name: /Interview fields/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: /Programming/i }).first().click()
  const role = page.getByRole('option', { name: /Frontend Engineer/i })
  await expect(role).toBeVisible({ timeout: 10_000 })
  await role.click()
}

/**
 * Interview Setup wizard (the 3-step flow at /interview/setup).
 *
 * Steps after the consolidation:
 *   0 — Domain (only)
 *   1 — Experience + Resume + JD/Company context (merged)
 *   2 — Round type + Duration + recap + "Enter Interview Room"
 *
 * Deferred-auth design: anonymous users can configure and progress through all
 * steps; the auth gate fires only on "Enter Interview Room" (Step 2, the final
 * step), where AuthGateProvider.requireAuth() opens a modal rather than
 * redirecting.
 *
 * These tests verify:
 *   1. Step 0 renders the domain-only shell (step counter, heading, CTA), and
 *      the resume control is NOT on Step 0 (it moved to Step 1).
 *   2. Step 0 → Step 1 advances on domain alone, revealing experience + resume.
 *   3. The "I don't have a resume" → quick-profile escape hatch works on Step 1.
 *
 * Tests intentionally stop at Step 1 because CategoryDomainPicker / DepthSelector
 * / duration pickers churn frequently; a Step 0 → Step 1 transition is the
 * minimum that proves the wizard state machine is wired end-to-end.
 *
 * References:
 *   - modules/interview/components/InterviewSetupForm.tsx (wizard component)
 *   - modules/interview/components/CategoryDomainPicker.tsx (field→role picker)
 *   - middleware.ts (deferred-auth whitelist)
 */

test.describe('Interview Setup wizard — Step 0 (domain)', () => {
  test('renders domain-only shell with disabled Continue CTA', async ({ page }) => {
    const consoleTracker = attachConsoleTracking(page)
    const networkTracker = attachNetworkTracking(page)

    await page.goto('/interview/setup')

    // Step counter.
    await expect(page.getByText(/Step 1 of \d+/i)).toBeVisible()

    // Step 0 heading from stepTitles[0].
    await expect(
      page.getByRole('heading', { name: /Choose your interview domain/i }),
    ).toBeVisible()

    // Domain section is present.
    await expect(page.getByText(/^Interview Domain/i).first()).toBeVisible()

    // Resume now lives on Step 1 — it must NOT render on Step 0.
    await expect(page.getByText(/^Resume/i)).toHaveCount(0)

    // Back button exists but is disabled on Step 0.
    const backButton = page.getByRole('button', { name: /^Back$/i })
    await expect(backButton).toBeVisible()
    await expect(backButton).toBeDisabled()

    // Continue CTA is rendered but disabled until a domain is picked
    // (canGoNext === !!role). exact:true avoids matching "Continue with quick
    // profile" which only renders later (Step 1).
    const continueCta = page.getByRole('button', { name: 'Continue', exact: true })
    await expect(continueCta).toBeVisible()
    await expect(continueCta).toBeDisabled()

    // "Enter Interview Room" must NOT appear on Step 0.
    await expect(
      page.getByRole('button', { name: /Enter Interview Room/i }),
    ).toHaveCount(0)

    networkTracker.assertNoServerErrors()
    consoleTracker.assertNoErrors()
  })
})

test.describe('Interview Setup wizard — step progression', () => {
  test('Step 0 → Step 1 advances on domain alone', async ({ page }) => {
    const consoleTracker = attachConsoleTracking(page)
    const networkTracker = attachNetworkTracking(page)

    await page.goto('/interview/setup')

    // 1) Pick a domain via the two-screen picker (see selectFrontendDomain).
    await selectFrontendDomain(page)

    // 2) Step 0 is domain-only now, so Continue enables immediately.
    //    exact:true so it never matches "Continue with quick profile".
    const continueCta = page.getByRole('button', { name: 'Continue', exact: true })
    await expect(continueCta).toBeEnabled({ timeout: 10_000 })
    await continueCta.click()

    // 3) Step 1 (the merged background step) renders with experience + resume.
    await expect(page.getByText(/Step 2 of \d+/i)).toBeVisible()
    await expect(
      page.getByRole('heading', { name: /Your background & context/i }),
    ).toBeVisible()
    await expect(page.getByText(/^Experience Level/i).first()).toBeVisible()
    await expect(page.getByText(/^Resume/i).first()).toBeVisible()

    // Back button should now be enabled (we're past step 0).
    await expect(page.getByRole('button', { name: /^Back$/i })).toBeEnabled()

    networkTracker.assertNoServerErrors()
    consoleTracker.assertNoErrors()
  })

  test('"I don\'t have a resume" → quick-profile escape hatch on Step 1', async ({ page }) => {
    await page.goto('/interview/setup')

    // Resume moved to Step 1, so advance there first.
    await selectFrontendDomain(page)
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect(page.getByText(/Step 2 of \d+/i)).toBeVisible()

    // Click the escape hatch and confirm the quick-profile form appears.
    await page.getByRole('button', { name: /I don.?t have a resume/i }).click()
    await expect(page.getByPlaceholder(/Current title/i)).toBeVisible()
    await expect(page.getByPlaceholder(/Top skills/i)).toBeVisible()
    await expect(
      page.getByRole('button', { name: /Continue with quick profile/i }),
    ).toBeVisible()
  })
})

test.describe('Interview Setup wizard — deferred auth', () => {
  test('anonymous users are not redirected away from /interview/setup', async ({ page }) => {
    // Positive assertion of the deferred-auth design. See middleware.ts.
    const response = await page.goto('/interview/setup')
    expect(response?.status()).toBeLessThan(500)

    // Wait briefly to rule out a delayed client-side redirect.
    await page.waitForTimeout(500)
    expect(page.url()).not.toContain('/signin')
    expect(page.url()).toContain('/interview/setup')
  })
})
