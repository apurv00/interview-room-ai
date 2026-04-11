import { test, expect } from '@playwright/test'

/**
 * NextAuth endpoint health checks. These are request-only tests (no browser
 * rendering) so they're the cheapest way to verify the signin page's OAuth
 * bindings are wired up correctly and the session endpoint isn't swallowing
 * Mongoose errors.
 */
test.describe('NextAuth API', () => {
  test('GET /api/auth/session returns 200 with JSON body', async ({ request }) => {
    const response = await request.get('/api/auth/session')
    expect(response.status()).toBe(200)

    // Anonymous session is an empty object `{}` in NextAuth v4.
    const body = await response.json()
    expect(body).toBeDefined()
    expect(typeof body).toBe('object')
  })

  test('GET /api/auth/csrf returns a csrfToken', async ({ request }) => {
    const response = await request.get('/api/auth/csrf')
    expect(response.ok()).toBeTruthy()

    const body = await response.json()
    expect(body.csrfToken).toBeDefined()
    expect(typeof body.csrfToken).toBe('string')
    expect(body.csrfToken.length).toBeGreaterThan(16)
  })

  test('GET /api/auth/providers lists google and github', async ({ request }) => {
    const response = await request.get('/api/auth/providers')
    expect(response.ok()).toBeTruthy()

    const body = await response.json()
    // Both OAuth providers must be registered — this is the regression test
    // for the signin page's "Continue with Google" / "Continue with GitHub"
    // buttons. If either is missing, those buttons would break silently.
    expect(body.google).toBeDefined()
    expect(body.google.id).toBe('google')
    expect(body.google.type).toBe('oauth')

    expect(body.github).toBeDefined()
    expect(body.github.id).toBe('github')
    expect(body.github.type).toBe('oauth')
  })
})

test.describe('Public data APIs', () => {
  test('GET /api/domains returns a non-empty domain list', async ({ request }) => {
    const response = await request.get('/api/domains')
    expect(response.ok()).toBeTruthy()
    // Route handler returns a bare JSON array (see app/api/domains/route.ts).
    const data = await response.json()
    expect(Array.isArray(data)).toBeTruthy()
    expect(data.length).toBeGreaterThan(0)
    // Every entry should at least carry a slug + label.
    expect(data[0].slug).toBeDefined()
    expect(data[0].label).toBeDefined()
  })

  test('GET /api/interview-types returns a non-empty type list', async ({ request }) => {
    const response = await request.get('/api/interview-types')
    expect(response.ok()).toBeTruthy()
    // Route handler returns a bare JSON array (see app/api/interview-types/route.ts).
    const data = await response.json()
    expect(Array.isArray(data)).toBeTruthy()
    expect(data.length).toBeGreaterThan(0)
    expect(data[0].slug).toBeDefined()
    expect(data[0].label).toBeDefined()
  })
})
