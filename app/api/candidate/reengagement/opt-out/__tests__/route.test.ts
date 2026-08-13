/** @vitest-environment node */

import { describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  apply: vi.fn(),
  checkRateLimit: vi.fn(),
}))

vi.mock('@shared/middleware/checkRateLimit', () => ({
  checkRateLimit: mocks.checkRateLimit,
}))
vi.mock('@hire/services/reengagementOptOutService', () => ({
  verifyHireReengagementOptOutCapability: mocks.verify,
  applyHireReengagementOptOut: mocks.apply,
  HireReengagementOptOutConfigurationError: class HireReengagementOptOutConfigurationError extends Error {},
}))

import { GET, POST } from '../route'

const CAPABILITY = 'opaque-public-capability'

describe('Hire re-engagement opt-out route', () => {
  it('renders a no-store, no-referrer confirmation screen without B2C/session lookup', async () => {
    mocks.verify.mockReturnValue({ workspaceId: 'a'.repeat(24) })
    const response = await GET(new NextRequest(
      `https://hire.example/api/candidate/reengagement/opt-out?capability=${CAPABILITY}`,
    ))

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(response.headers.get('X-Robots-Tag')).toContain('noindex')
    const body = await response.text()
    expect(body).toContain('Stop future re-engagement emails?')
    expect(body).toContain('action="/api/candidate/reengagement/opt-out"')
    expect(mocks.verify).toHaveBeenCalledWith(CAPABILITY)
  })

  it('does not reflect an invalid query capability into its public error page', async () => {
    const forged = 'forged-capability-that-must-not-echo'
    mocks.verify.mockReturnValue(null)
    const response = await GET(new NextRequest(
      `https://hire.example/api/candidate/reengagement/opt-out?capability=${forged}`,
    ))

    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(await response.text()).not.toContain(forged)
  })

  it('records a generic POST result without reflecting the query capability or creating a candidate oracle', async () => {
    mocks.checkRateLimit.mockResolvedValue(null)
    mocks.apply.mockResolvedValue({ accepted: false })
    const response = await POST(new NextRequest(
      `https://hire.example/api/candidate/reengagement/opt-out?capability=${CAPABILITY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' },
    ))

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(await response.text()).not.toContain(CAPABILITY)
    expect(mocks.apply).toHaveBeenCalledWith({ capability: CAPABILITY })
  })

  it('preserves anti-leak headers on a rate-limited public request', async () => {
    mocks.checkRateLimit.mockResolvedValue(new NextResponse('slow down', { status: 429 }))
    const response = await POST(new NextRequest('https://hire.example/api/candidate/reengagement/opt-out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `capability=${CAPABILITY}`,
    }))

    expect(response.status).toBe(429)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
  })
})
