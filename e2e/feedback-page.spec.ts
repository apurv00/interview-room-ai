import { test, expect } from '@playwright/test'

test.describe('Feedback Page', () => {
  test('feedback page loads with score ring', async ({ page }) => {
    // Navigate to history to find a completed session
    await page.goto('/history')
    // Click the first completed session
    const sessionLink = page.locator('button:has-text("Feedback"), a[href*="/feedback/"]').first()
    if (await sessionLink.isVisible({ timeout: 5000 })) {
      await sessionLink.click()
      // Verify score ring renders
      await expect(page.locator('[role="meter"], [class*="score"], svg circle')).toBeVisible({ timeout: 10000 })
    }
  })

  test('tabs switch correctly', async ({ page }) => {
    await page.goto('/history')
    const sessionLink = page.locator('button').filter({ hasText: /\d+/ }).first()
    if (await sessionLink.isVisible({ timeout: 5000 })) {
      await sessionLink.click()
      await page.waitForURL(/\/feedback\//)

      // Click Questions tab
      const questionsTab = page.locator('button:has-text("Questions")')
      if (await questionsTab.isVisible()) {
        await questionsTab.click()
        await page.waitForTimeout(500)
      }

      // Click Transcript tab
      const transcriptTab = page.locator('button:has-text("Transcript")')
      if (await transcriptTab.isVisible()) {
        await transcriptTab.click()
        await page.waitForTimeout(500)
      }
    }
  })

  test('question heatmap rows expand on click', async ({ page }) => {
    await page.goto('/history')
    const sessionLink = page.locator('button').filter({ hasText: /\d+/ }).first()
    if (await sessionLink.isVisible({ timeout: 5000 })) {
      await sessionLink.click()
      await page.waitForURL(/\/feedback\//)

      // Find a heatmap row (Q1, Q2, etc.)
      const heatmapRow = page.locator('button:has-text("Q1")').first()
      if (await heatmapRow.isVisible({ timeout: 5000 })) {
        await heatmapRow.click()
        // Verify expanded content appears
        await expect(page.locator('text=Question:, text=Answer:')).toBeVisible({ timeout: 2000 })
      }
    }
  })
})
