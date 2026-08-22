import { test, expect, type Request } from '@playwright/test'
import { expectCleanPageLoad, gotoAndTrack } from './helpers/page-checks'

/**
 * Parametrized "does this page load cleanly" suite across every public
 * surface. Each case asserts:
 *   - final response is 2xx (catches silent 4xx regressions)
 *   - final pathname matches the requested path (catches silent redirects
 *     like a public page quietly redirecting to /signin)
 *   - body rendered (>100 chars, no error overlay)
 *   - zero non-allowlisted console errors
 *   - zero non-allowlisted 5xx network responses
 *
 * If a new public page is added, add it here. Pages that are EXPECTED to
 * redirect (e.g., /resources → /learn/guides) do not belong in this list;
 * assert their redirect behavior in auth-gating.spec.ts instead.
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

  test('homepage surfaces the field taxonomy (incl. Core Engineering)', async ({ page }) => {
    const { consoleTracker, networkTracker } = await gotoAndTrack(page, '/')
    await page.waitForLoadState('domcontentloaded')
    // Phase 5: the "Calibrated for your field" showcase reflects the category
    // taxonomy — Core Engineering in particular (the freshers/engineering angle
    // this initiative was built for). A product requirement, not design copy.
    const body = (await page.locator('body').textContent()) ?? ''
    expect(body).toContain('Core Engineering')
    expect(body).toContain('Data & AI')
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

  test('resume templates page shows the full catalog (every family) on load', async ({ page }) => {
    // Regression: the page used to default its family filter to the first
    // template's family (Classic), hiding 16 of 20 templates until the user
    // discovered the family tabs. It now defaults to "All". Assert template
    // names from multiple distinct families are visible without any clicks.
    await page.goto('/resume/templates')
    await page.waitForLoadState('domcontentloaded')
    const body = (await page.locator('body').textContent()) ?? ''
    expect(body).toContain('Professional') // Classic family
    expect(body).toContain('Technical')    // Technical family
    expect(body).toContain('Creative')     // Sidebar family
    expect(body).toContain('Executive')    // Executive family
    expect(body).toContain('Startup')      // Technical family (columnar)
    expect(body).toContain('Federal')      // Classic family
  })

  test('signin page shows both OAuth provider buttons', async ({ page }) => {
    await page.goto('/signin')
    await expect(page.getByRole('button', { name: /Continue with Google/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /Continue with GitHub/i })).toBeVisible()
  })

  test('/learn/guides settles its RSC requests within 15s', async ({ page }) => {
    const activeRscRequests = new Set<Request>()
    const failedRscRequests: string[] = []
    const errorRscResponses: string[] = []
    let lastRscActivityAt = Date.now()
    const isRscRequest = (request: Request) => {
      const url = new URL(request.url())
      return url.searchParams.has('_rsc') || request.headers().rsc === '1'
    }
    const markStarted = (request: Request) => {
      if (!isRscRequest(request)) return
      activeRscRequests.add(request)
      lastRscActivityAt = Date.now()
    }
    const markSettled = (request: Request) => {
      if (!activeRscRequests.delete(request)) return
      lastRscActivityAt = Date.now()
    }
    const markFailed = (request: Request) => {
      if (isRscRequest(request)) {
        const errorText = request.failure()?.errorText ?? 'unknown error'
        // Next cancels speculative link prefetches when their priority changes.
        // Chromium reports that normal cancellation as ERR_ABORTED; every
        // other RSC transport failure remains fatal.
        if (errorText !== 'net::ERR_ABORTED') {
          failedRscRequests.push(`${request.url()} — ${errorText}`)
        }
      }
      markSettled(request)
    }
    page.on('request', markStarted)
    page.on('requestfinished', markSettled)
    page.on('requestfailed', markFailed)
    page.on('response', response => {
      if (isRscRequest(response.request()) && response.status() >= 400) {
        errorRscResponses.push(`${response.status()} ${response.url()}`)
      }
    })

    const { response, consoleTracker, networkTracker } = await gotoAndTrack(page, '/learn/guides')
    expect(response?.status()).toBe(200)
    await expect(
      page.getByRole('heading', { level: 1, name: 'Interview Preparation Resources' }),
    ).toBeVisible()

    // `networkidle` is the wrong contract for a Next.js page because unrelated
    // analytics and prefetch traffic can remain active. The regression was an
    // RSC request that never completed, so require the exact request class to
    // reach zero and remain quiet for a full second.
    const deadline = Date.now() + 15_000
    while (
      Date.now() < deadline &&
      (activeRscRequests.size > 0 || Date.now() - lastRscActivityAt < 1_000)
    ) {
      await page.waitForTimeout(100)
    }
    expect(
      Array.from(activeRscRequests, request => request.url()),
      'RSC requests still active after the 15s settlement budget',
    ).toEqual([])
    expect(failedRscRequests, 'RSC requests failed before settlement').toEqual([])
    expect(errorRscResponses, 'RSC requests returned an error response').toEqual([])
    expect(Date.now() - lastRscActivityAt).toBeGreaterThanOrEqual(1_000)
    networkTracker.assertNoServerErrors()
    consoleTracker.assertNoErrors()
  })
})
