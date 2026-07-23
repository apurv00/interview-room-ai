import { expect, test } from '@playwright/test'
import { attachNetworkTracking } from './helpers/network-tracker'

test('an anonymous user can search and open a live job with the keyboard', async ({ page }) => {
  const networkTracker = attachNetworkTracking(page)
  const response = await page.goto('/jobs')

  expect(response?.status()).toBeGreaterThanOrEqual(200)
  expect(response?.status()).toBeLessThan(300)
  await expect(page.getByRole('heading', { name: 'Jobs', level: 1 })).toBeVisible()
  await expect(page.getByRole('searchbox', { name: 'Search jobs' })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Experience preference' })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Sort' })).toBeVisible()
  await expect(page.getByLabel('Location preference')).toHaveCount(0)
  await expect(page.getByLabel('Work mode')).toHaveCount(0)
  await expect(page.getByLabel('Date posted')).toHaveCount(0)
  await expect(page.getByLabel('Company')).toHaveCount(0)

  const results = page.getByRole('region', { name: 'Job results' })
  await expect(results).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 })

  const firstJob = results.locator('a[href^="/jobs/"]').first()
  await expect(firstJob).toBeVisible()
  const searchTerm = (await firstJob.innerText()).split('\n')[0].trim().slice(0, 80)
  expect(searchTerm.length).toBeGreaterThan(0)

  const search = page.getByRole('searchbox', { name: 'Search jobs' })
  await search.fill(searchTerm)
  const filteredFeed = page.waitForResponse((feedResponse) => {
    const url = new URL(feedResponse.url())
    return feedResponse.request().method() === 'GET'
      && url.pathname === '/api/jobs/feed'
      && url.searchParams.get('q') === searchTerm
  })

  await Promise.all([
    page.waitForURL((url) => url.pathname === '/jobs' && url.searchParams.get('q') === searchTerm),
    filteredFeed,
    search.press('Enter'),
  ])

  expect((await filteredFeed).status()).toBe(200)
  await expect(
    page.getByRole('button', { name: `Remove Search: ${searchTerm} filter` }),
  ).toBeVisible()
  await expect(results).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 })

  const filteredJob = results.locator('a[href^="/jobs/"]').first()
  await expect(filteredJob).toContainText(searchTerm)
  await filteredJob.focus()
  await expect(filteredJob).toBeFocused()
  await Promise.all([
    page.waitForURL((url) => /^\/jobs\/[a-f0-9]{24}$/.test(url.pathname)),
    filteredJob.press('Enter'),
  ])

  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Sign in to read the full posting' }),
  ).toBeVisible()
  expect(new URL(page.url()).pathname).not.toBe('/signin')

  networkTracker.assertNoServerErrors()
})
