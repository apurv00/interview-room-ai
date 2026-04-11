import { test, expect } from '@playwright/test'
import { attachConsoleTracking } from './helpers/console-tracker'
import { attachNetworkTracking } from './helpers/network-tracker'

/**
 * Interview Setup wizard (the 4-step flow at /interview/setup).
 *
 * The wizard uses a deferred-auth design: anonymous users can configure and
 * progress through all four steps. The auth gate fires only when the user
 * clicks "Enter Interview Room" on Step 3, at which point
 * `AuthGateProvider.requireAuth()` opens a modal rather than redirecting.
 *
 * These tests verify:
 *   1. Step 0 renders with the correct shell (step counter, headings, CTA).
 *   2. The Continue CTA is initially disabled until a domain + resume exist.
 *   3. The "I don't have a resume" → quick-profile escape hatch works.
 *   4. Selecting a domain + completing quick profile enables advancement to
 *      Step 1, which reveals the experience + context UI.
 *
 * The tests intentionally stop at Step 1 because DomainSelector /
 * DepthSelector / duration pickers churn frequently; a Step 0 → Step 1
 * transition is the minimum that proves the wizard state machine is wired
 * end-to-end without over-coupling to every UI element downstream.
 *
 * References:
 *   - modules/interview/components/InterviewSetupForm.tsx (wizard component)
 *   - modules/interview/components/InterviewSetupForm.tsx:625-630 (step titles)
 *   - modules/interview/components/InterviewSetupForm.tsx:1057 "Enter Interview Room"
 *   - modules/interview/components/DomainSelector.tsx (role="listbox" + options)
 *   - middleware.ts:148 (deferred-auth whitelist)
 */

test.describe('Interview Setup wizard — Step 0', () => {
  test('renders initial shell with disabled Continue CTA', async ({ page }) => {
    const consoleTracker = attachConsoleTracking(page)
    const networkTracker = attachNetworkTracking(page)

    await page.goto('/interview/setup')

    // Step counter from InterviewSetupForm.tsx:675.
    await expect(page.getByText(/Step 1 of \d+/i)).toBeVisible()

    // Step 0 heading from stepTitles[0].
    await expect(
      page.getByRole('heading', { name: /Start with your domain and resume/i }),
    ).toBeVisible()

    // Required-field section headings.
    await expect(page.getByText(/^Interview Domain/i).first()).toBeVisible()
    await expect(page.getByText(/^Resume/i).first()).toBeVisible()

    // Back button exists but is disabled on Step 0.
    const backButton = page.getByRole('button', { name: /^Back$/i })
    await expect(backButton).toBeVisible()
    await expect(backButton).toBeDisabled()

    // Continue CTA is rendered but disabled until the user picks a domain
    // + provides a resume (canGoNext === false).
    const continueCta = page.getByRole('button', { name: /^Continue/ })
    await expect(continueCta).toBeVisible()
    await expect(continueCta).toBeDisabled()

    // "Enter Interview Room" must NOT appear on Step 0.
    await expect(
      page.getByRole('button', { name: /Enter Interview Room/i }),
    ).toHaveCount(0)

    networkTracker.assertNoServerErrors()
    consoleTracker.assertNoErrors()
  })

  test('"I don\'t have a resume" reveals the quick-profile form', async ({ page }) => {
    await page.goto('/interview/setup')

    // Click the escape hatch (InterviewSetupForm.tsx:788).
    await page.getByRole('button', { name: /I don.?t have a resume/i }).click()

    // Quick profile form appears.
    await expect(page.getByPlaceholder(/Current title/i)).toBeVisible()
    await expect(page.getByPlaceholder(/Top skills/i)).toBeVisible()
    await expect(
      page.getByRole('button', { name: /Continue with quick profile/i }),
    ).toBeVisible()
  })
})

test.describe('Interview Setup wizard — step progression', () => {
  test('Step 0 → Step 1 via domain + quick profile', async ({ page }) => {
    const consoleTracker = attachConsoleTracking(page)
    const networkTracker = attachNetworkTracking(page)

    await page.goto('/interview/setup')

    // 1) Pick a domain. DomainSelector renders cards as role="option"
    //    (see DomainSelector.tsx:203). "Frontend Engineer" is a stable label.
    const domainCarousel = page.getByRole('listbox', { name: /Interview domains/i })
    await expect(domainCarousel).toBeVisible()
    await domainCarousel.getByRole('option', { name: /Frontend Engineer/i }).click()

    // 2) Take the quick-profile path for the resume requirement.
    await page.getByRole('button', { name: /I don.?t have a resume/i }).click()
    await page.getByPlaceholder(/Current title/i).fill('Senior Frontend Engineer')
    await page.getByPlaceholder(/Top skills/i).fill('React, TypeScript, Next.js')
    await page.getByRole('button', { name: /Continue with quick profile/i }).click()

    // 3) After quick-profile, hasResume becomes true and canGoNext === true.
    const continueCta = page.getByRole('button', { name: /^Continue/ })
    await expect(continueCta).toBeEnabled()
    await continueCta.click()

    // 4) Step 1 should now render.
    await expect(page.getByText(/Step 2 of \d+/i)).toBeVisible()
    await expect(
      page.getByRole('heading', { name: /Add your experience and context/i }),
    ).toBeVisible()
    await expect(page.getByText(/^Experience Level/i).first()).toBeVisible()

    // Back button should now be enabled (we're past step 0).
    await expect(page.getByRole('button', { name: /^Back$/i })).toBeEnabled()

    networkTracker.assertNoServerErrors()
    consoleTracker.assertNoErrors()
  })
})

test.describe('Interview Setup wizard — deferred auth', () => {
  test('anonymous users are not redirected away from /interview/setup', async ({ page }) => {
    // Positive assertion of the deferred-auth design. See middleware.ts:148.
    const response = await page.goto('/interview/setup')
    expect(response?.status()).toBeLessThan(500)

    // Wait briefly to rule out a delayed client-side redirect.
    await page.waitForTimeout(500)
    expect(page.url()).not.toContain('/signin')
    expect(page.url()).toContain('/interview/setup')
  })
})
