import { test, expect } from '@playwright/test'
import { attachConsoleTracking } from './helpers/console-tracker'
import { attachNetworkTracking } from './helpers/network-tracker'

test.describe('Homepage & Lobby', () => {
  test('homepage loads without errors', async ({ page }) => {
    const consoleTracker = attachConsoleTracking(page)
    const networkTracker = attachNetworkTracking(page)

    const response = await page.goto('/')
    expect(response?.status()).toBeLessThan(500)
    await page.waitForLoadState('domcontentloaded')
    const body = await page.locator('body').textContent()
    expect(body).not.toContain('Internal Server Error')

    networkTracker.assertNoServerErrors()
    consoleTracker.assertNoErrors()
  })

  test('homepage renders content', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const bodyText = await page.locator('body').textContent()
    expect(bodyText?.length).toBeGreaterThan(100)
    expect(bodyText).not.toMatch(/500|Internal Server Error/)
  })

  test('lobby page loads', async ({ page }) => {
    const response = await page.goto('/lobby')
    expect(response?.status()).toBeLessThan(500)
    expect(page.url()).not.toContain('/signin')
  })
})

test.describe('Static Pages', () => {
  test('pricing page loads with all three tiers', async ({ page }) => {
    const response = await page.goto('/pricing')
    expect(response?.status()).toBeLessThan(500)
    const body = (await page.locator('body').textContent()) ?? ''
    expect(body).toContain('Free')
    expect(body).toContain('Pro')
    expect(body).toContain('Enterprise')
  })

  test('privacy page loads with visible heading', async ({ page }) => {
    const response = await page.goto('/privacy')
    expect(response?.status()).toBeLessThan(500)
    await expect(page.getByRole('heading', { name: /privacy/i }).first()).toBeVisible()
  })

  test('terms page loads with visible heading', async ({ page }) => {
    const response = await page.goto('/terms')
    expect(response?.status()).toBeLessThan(500)
    await expect(page.getByRole('heading', { name: /terms/i }).first()).toBeVisible()
  })

  test('signin page renders both OAuth buttons', async ({ page }) => {
    const response = await page.goto('/signin')
    expect(response?.status()).toBeLessThan(500)
    // Regression test for the signin page's OAuth bindings (see
    // shared/ui/SignInForm.tsx). These buttons are the only way in and out
    // of the app, so if they vanish the product is effectively offline.
    await expect(page.getByRole('button', { name: /Continue with Google/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /Continue with GitHub/i })).toBeVisible()
  })
})
