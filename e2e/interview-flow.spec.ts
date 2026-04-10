import { test, expect } from '@playwright/test'

test.describe('Interview Flow', () => {
  test.beforeEach(async ({ page }) => {
    // Set interview config in localStorage before navigating
    await page.goto('/')
    await page.evaluate(() => {
      localStorage.setItem('interviewConfig', JSON.stringify({
        role: 'pm',
        experience: '3-6',
        duration: 10,
        interviewType: 'behavioral',
      }))
    })
  })

  test('interview page loads and shows avatar', async ({ page }) => {
    await page.goto('/interview')
    // Wait for the interview page to render
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 })
    // Avatar or video element should be present
    const hasAvatar = await page.locator('video, [class*="avatar"], svg').first().isVisible()
    expect(hasAvatar).toBeTruthy()
  })

  test('transcript panel shows interviewer text after intro', async ({ page }) => {
    await page.goto('/interview')
    // Wait for transcript panel to have interviewer content
    await expect(page.locator('text=Alex')).toBeVisible({ timeout: 15000 })
  })

  test('end interview navigates to feedback', async ({ page }) => {
    await page.goto('/interview')
    // Wait for interview to start, then end it
    await page.waitForTimeout(5000) // Let intro play
    const endButton = page.locator('button:has-text("End"), [aria-label*="end"], [aria-label*="End"]')
    if (await endButton.isVisible()) {
      await endButton.click()
      // Should navigate to feedback page
      await expect(page).toHaveURL(/\/feedback\//, { timeout: 30000 })
    }
  })
})
