import { test, expect } from '@playwright/test'

test.describe('Lobby & Setup', () => {
  test('lobby page loads without errors', async ({ page }) => {
    await page.goto('/lobby')
    await page.waitForLoadState('networkidle')
    expect(page.url()).not.toContain('/signin')
    await expect(page.locator('body')).not.toHaveText(/Internal Server Error|500/)
  })

  test('interview setup page loads', async ({ page }) => {
    await page.goto('/interview/setup')
    await page.waitForLoadState('networkidle')
    // Setup is public — should not redirect to signin
    expect(page.url()).not.toContain('/signin')
  })
})

test.describe('API Health', () => {
  test('domains API returns data', async ({ page }) => {
    const response = await page.request.get('/api/domains')
    expect(response.ok()).toBeTruthy()
    const data = await response.json()
    expect(data.domains).toBeDefined()
    expect(Array.isArray(data.domains)).toBeTruthy()
  })

  test('interview-types API returns data', async ({ page }) => {
    const response = await page.request.get('/api/interview-types')
    expect(response.ok()).toBeTruthy()
    const data = await response.json()
    expect(data.interviewTypes).toBeDefined()
    expect(Array.isArray(data.interviewTypes)).toBeTruthy()
  })
})
