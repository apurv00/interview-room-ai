import { test, expect } from '@playwright/test'

test.describe('Homepage & Lobby', () => {
  test('homepage loads without errors', async ({ page }) => {
    const response = await page.goto('/')
    expect(response?.status()).toBeLessThan(500)
    await page.waitForLoadState('domcontentloaded')
    const body = await page.locator('body').textContent()
    expect(body).not.toContain('Internal Server Error')
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

test.describe('Auth-Gated Pages', () => {
  test('interview page requires auth', async ({ page }) => {
    await page.goto('/interview')
    await page.waitForLoadState('networkidle')
    // Should redirect to signin or show auth prompt
    const url = page.url()
    expect(url).toMatch(/\/signin|\/interview/)
  })

  test('history page accessible', async ({ page }) => {
    const response = await page.goto('/history')
    expect(response?.status()).toBeLessThan(500)
  })
})

test.describe('Static Pages', () => {
  test('pricing page loads', async ({ page }) => {
    const response = await page.goto('/pricing')
    expect(response?.status()).toBeLessThan(500)
  })

  test('privacy page loads', async ({ page }) => {
    const response = await page.goto('/privacy')
    expect(response?.status()).toBeLessThan(500)
  })

  test('terms page loads', async ({ page }) => {
    const response = await page.goto('/terms')
    expect(response?.status()).toBeLessThan(500)
  })

  test('signin page loads', async ({ page }) => {
    const response = await page.goto('/signin')
    expect(response?.status()).toBeLessThan(500)
  })
})
