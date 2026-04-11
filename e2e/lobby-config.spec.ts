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
