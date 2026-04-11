import { test, expect } from '@playwright/test'
import { expectCleanPageLoad, gotoAndTrack } from './helpers/page-checks'

/**
 * Parametrized "does this page load cleanly" suite across every public
 * surface. Each case asserts:
 *   - status < 500
 *   - body rendered (>100 chars, no error overlay)
 *   - zero non-allowlisted console errors
 *   - zero non-allowlisted 5xx network responses
 *
 * If a new public page is added, add it here.
 */

interface PageCase {
  name: string
  path: string
}

const PUBLIC_PAGES: PageCase[] = [
  { name: 'homepage', path: '/' },
  { name: 'pricing', path: '/pricing' },
  { name: 'privacy', path: '/privacy' },
  { name: 'terms', path: '/terms' },
  { name: 'signin', path: '/signin' },
  { name: 'resume landing', path: '/resume' },
  { name: 'resume builder', path: '/resume/builder' },
  { name: 'resume tailor', path: '/resume/tailor' },
  { name: 'resume ATS check', path: '/resume/ats-check' },
  { name: 'resume templates', path: '/resume/templates' },
  { name: 'history (signed out)', path: '/history' },
  { name: 'learn hub', path: '/learn' },
  { name: 'learn guides', path: '/learn/guides' },
  { name: 'learn progress (signed out)', path: '/learn/progress' },
  { name: 'interview setup (deferred auth)', path: '/interview/setup' },
]

test.describe('Public page smoke', () => {
  for (const { name, path } of PUBLIC_PAGES) {
    test(`${name} loads cleanly at ${path}`, async ({ page }) => {
      await expectCleanPageLoad(page, path)
    })
  }
})

test.describe('Content regression checks', () => {
  test('homepage renders hero content', async ({ page }) => {
    const { response, consoleTracker, networkTracker } = await gotoAndTrack(page, '/')
    expect(response?.status()).toBeLessThan(500)
    await page.waitForLoadState('domcontentloaded')

    // The homepage is mostly marketing copy — assert a meaningful body length
    // rather than specific strings that churn with design revisions.
    const body = await page.locator('body').textContent()
    expect(body?.length ?? 0).toBeGreaterThan(500)

    networkTracker.assertNoServerErrors()
    consoleTracker.assertNoErrors()
  })

  test('pricing page shows all three tiers', async ({ page }) => {
    await page.goto('/pricing')
    await page.waitForLoadState('domcontentloaded')
    const body = (await page.locator('body').textContent()) ?? ''
    expect(body).toContain('Free')
    expect(body).toContain('Pro')
    expect(body).toContain('Enterprise')
  })

  test('signin page shows both OAuth provider buttons', async ({ page }) => {
    await page.goto('/signin')
    await expect(page.getByRole('button', { name: /Continue with Google/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /Continue with GitHub/i })).toBeVisible()
  })

  test('/learn/guides settles within 15s (RSC prefetch regression)', async ({ page }) => {
    // The E2E audit report found that the RSC prefetch for /learn/guides stayed
    // pending indefinitely on production. This test asserts the page reaches
    // networkidle within a bounded time budget; if it hangs, this fails fast.
    await page.goto('/learn/guides')
    await page.waitForLoadState('networkidle', { timeout: 15_000 })
  })
})
