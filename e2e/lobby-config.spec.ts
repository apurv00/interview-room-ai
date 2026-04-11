import { test, expect } from '@playwright/test'

test.describe('Lobby & Setup', () => {
  test('lobby page loads', async ({ page }) => {
    const response = await page.goto('/lobby')
    expect(response?.status()).toBeLessThan(500)
    expect(page.url()).not.toContain('/signin')
  })

  test('interview setup page renders the wizard shell', async ({ page }) => {
    const response = await page.goto('/interview/setup')
    expect(response?.status()).toBeLessThan(500)
    expect(page.url()).not.toContain('/signin')

    // The step counter is the cheapest stable selector to prove the wizard
    // component actually rendered (see InterviewSetupForm.tsx:675). The
    // setup-wizard.spec.ts suite covers the step progression in detail.
    await expect(page.getByText(/Step 1 of \d+/i)).toBeVisible()
  })
})

test.describe('API Health', () => {
  // Note: both endpoints return a bare JSON array, not an object wrapper
  // (see app/api/domains/route.ts and app/api/interview-types/route.ts).
  test('domains API returns data', async ({ page }) => {
    const response = await page.request.get('/api/domains')
    expect(response.ok()).toBeTruthy()
    const data = await response.json()
    expect(Array.isArray(data)).toBeTruthy()
    expect(data.length).toBeGreaterThan(0)
  })

  test('interview-types API returns data', async ({ page }) => {
    const response = await page.request.get('/api/interview-types')
    expect(response.ok()).toBeTruthy()
    const data = await response.json()
    expect(Array.isArray(data)).toBeTruthy()
    expect(data.length).toBeGreaterThan(0)
  })
})
