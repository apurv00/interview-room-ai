import { test, expect } from '@playwright/test'

test.describe('Feedback Page (public shell)', () => {
  test('history page loads without errors', async ({ page }) => {
    await page.goto('/history')
    await page.waitForLoadState('networkidle')
    // History is publicly browseable
    expect(page.url()).toContain('/history')
    await expect(page.locator('body')).not.toHaveText(/Internal Server Error|500/)
  })

  test('feedback page with invalid session redirects gracefully', async ({ page }) => {
    await page.goto('/feedback/nonexistent-session-id')
    await page.waitForLoadState('networkidle')
    // Should either redirect to signin, show error, or redirect to home
    // Any of these is acceptable — the key is no 500 error
    const url = page.url()
    const body = await page.locator('body').textContent()
    expect(body).not.toContain('Internal Server Error')
    // Should have navigated somewhere valid
    expect(url).toBeTruthy()
  })
})

test.describe('Resume Pages (public)', () => {
  test('resume builder loads', async ({ page }) => {
    await page.goto('/resume/builder')
    await page.waitForLoadState('networkidle')
    expect(page.url()).toContain('/resume')
    await expect(page.locator('body')).not.toHaveText(/500|Internal Server Error/)
  })

  test('resume ATS check loads', async ({ page }) => {
    await page.goto('/resume/ats-check')
    await page.waitForLoadState('networkidle')
    expect(page.url()).toContain('/resume')
  })

  test('resume templates loads', async ({ page }) => {
    await page.goto('/resume/templates')
    await page.waitForLoadState('networkidle')
    expect(page.url()).toContain('/resume')
  })
})
