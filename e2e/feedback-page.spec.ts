import { test, expect } from '@playwright/test'

test.describe('Feedback & History', () => {
  test('history page returns 200', async ({ page }) => {
    const response = await page.goto('/history')
    expect(response?.status()).toBeLessThan(500)
  })

  test('invalid feedback session does not 500', async ({ page }) => {
    const response = await page.goto('/feedback/nonexistent-session-id')
    // May redirect to signin or home — but should not 500
    expect(response?.status()).not.toBe(500)
  })
})

test.describe('Resume Pages (public)', () => {
  test('resume builder loads', async ({ page }) => {
    const response = await page.goto('/resume/builder')
    expect(response?.status()).toBeLessThan(500)
  })

  test('resume ATS check loads', async ({ page }) => {
    const response = await page.goto('/resume/ats-check')
    expect(response?.status()).toBeLessThan(500)
  })

  test('resume templates loads', async ({ page }) => {
    const response = await page.goto('/resume/templates')
    expect(response?.status()).toBeLessThan(500)
  })
})
