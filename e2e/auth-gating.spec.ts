import { test, expect } from '@playwright/test'

/**
 * Auth gating behavior. Interview Prep Guru uses a **deferred-auth** model:
 * anonymous users can browse most surfaces freely, and auth is enforced only
 * at value-capture actions (start interview, save resume). The only page that
 * uses a classic redirect-to-signin gate is `/settings`.
 *
 * These tests verify:
 *   1. `/settings` redirects anonymous users toward the sign-in flow.
 *   2. Data-centric pages (`/history`, `/learn/progress`) show the shared
 *      `SignedOutEmptyState` instead of redirecting.
 *   3. `/interview/setup` is anonymous-accessible (positive assertion of the
 *      deferred-auth design — see middleware.ts:141-152 for the whitelist).
 *   4. `/signin` exposes both OAuth provider buttons.
 *   5. `/resources` redirects into the learn hub.
 */

test.describe('Redirect-gated pages', () => {
  test('/settings redirects anonymous users to the sign-in flow', async ({ page }) => {
    await page.goto('/settings')
    // The redirect may land on /signin (with or without a callbackUrl param)
    // or on the NextAuth /api/auth/signin staging page. Either way, the
    // anonymous user must end up on an auth surface, not on /settings.
    await page.waitForURL(/\/signin|\/api\/auth\/signin/, { timeout: 15_000 })
    expect(page.url()).not.toContain('/settings')
  })
})

test.describe('Deferred-auth empty states', () => {
  test('/history shows the signed-out empty state', async ({ page }) => {
    const response = await page.goto('/history')
    expect(response?.status()).toBeLessThan(500)
    expect(page.url()).not.toContain('/signin')

    // `SignedOutEmptyState` headline from app/history/page.tsx:94.
    await expect(page.getByRole('heading', { name: /See your past interviews here/i })).toBeVisible()
    // Empty state provides a "Sign in" button (see shared/ui/SignedOutEmptyState.tsx:52).
    await expect(page.getByRole('button', { name: /^Sign in$/i })).toBeVisible()
  })

  test('/learn/progress shows the signed-out empty state', async ({ page }) => {
    const response = await page.goto('/learn/progress')
    expect(response?.status()).toBeLessThan(500)
    expect(page.url()).not.toContain('/signin')

    // `SignedOutEmptyState` headline from app/(learn)/learn/progress/page.tsx:74.
    await expect(page.getByRole('heading', { name: /Track your progress here/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Sign in$/i })).toBeVisible()
  })
})

test.describe('Deferred-auth public surfaces', () => {
  test('/interview/setup is anonymous-accessible', async ({ page }) => {
    // Middleware whitelists /interview/setup as part of the deferred-auth
    // design — see middleware.ts:148. Auth is enforced client-side only when
    // the user clicks "Enter Interview Room" (see setup-wizard.spec.ts).
    const response = await page.goto('/interview/setup')
    expect(response?.status()).toBeLessThan(500)
    expect(page.url()).not.toContain('/signin')

    // Step counter is the cheapest selector that confirms the wizard rendered.
    await expect(page.getByText(/Step 1 of \d+/i)).toBeVisible()
  })

  test('/resources redirects to the learn hub', async ({ page }) => {
    await page.goto('/resources')
    await page.waitForURL(/\/learn/, { timeout: 10_000 })
    expect(page.url()).toMatch(/\/learn(\/|$)/)
  })
})

test.describe('Sign-in surface', () => {
  test('/signin renders both OAuth provider buttons', async ({ page }) => {
    await page.goto('/signin')
    await expect(page.getByRole('button', { name: /Continue with Google/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /Continue with GitHub/i })).toBeVisible()

    // The app is OAuth-only — assert no credentials form slipped in.
    expect(await page.locator('input[type="password"]').count()).toBe(0)
  })

  test('/signin preserves callbackUrl when linked from a gated page', async ({ page }) => {
    // Simulates what a user sees after /settings bounces them.
    await page.goto('/signin?callbackUrl=%2Fsettings')
    await expect(page.getByRole('button', { name: /Continue with Google/i })).toBeVisible()
    expect(page.url()).toContain('callbackUrl')
  })
})
