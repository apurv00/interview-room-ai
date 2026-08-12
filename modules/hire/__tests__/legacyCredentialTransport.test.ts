import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { NextRequest, type NextResponse } from 'next/server'

vi.mock('next-auth/middleware', () => ({
  withAuth: vi.fn((handler: unknown) => handler),
}))

type HireMiddleware = (request: NextRequest) => NextResponse | Promise<NextResponse>

let hireMiddleware: HireMiddleware

function request(path: string): NextRequest {
  const req = new NextRequest(`https://hire.interviewprep.guru${path}`, {
    headers: { host: 'hire.interviewprep.guru' },
  })
  Object.defineProperty(req, 'nextauth', {
    configurable: true,
    value: { token: null },
  })
  return req
}

beforeAll(async () => {
  vi.stubEnv('IPG_SURFACE', 'hire-control')
  vi.resetModules()
  hireMiddleware = (await import('../../../middleware')).default as unknown as HireMiddleware
})

afterAll(() => {
  vi.unstubAllEnvs()
})

describe('legacy Hire request-target credentials', () => {
  it.each([
    `/apply/${'a'.repeat(64)}`,
    `/api/apply/${'a'.repeat(64)}`,
    `/candidate/${'b'.repeat(24)}?token=${'a'.repeat(64)}`,
    `/candidate/privacy/${'a'.repeat(64)}`,
    `/hire-signin?setup=${'a'.repeat(64)}`,
    `/handoff?code=${'a'.repeat(64)}`,
  ])('returns HTTP 410 for %s without reflecting the secret', async (path) => {
    const response = await hireMiddleware(request(path))
    expect(response.status).toBe(410)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const body = await response.text()
    expect(body).toBe('This link format is no longer active')
    expect(body).not.toContain('a'.repeat(64))
  })

  it.each([
    '/apply',
    '/api/apply',
    '/api/apply/resolve',
    `/candidate/${'b'.repeat(24)}`,
    '/hire-signin',
    '/handoff',
  ])('keeps the fixed fragment/body entry point %s reachable', async (path) => {
    const response = await hireMiddleware(request(path))
    expect(response.status).not.toBe(410)
  })
})
