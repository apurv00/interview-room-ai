/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
  ping: vi.fn().mockResolvedValue('PONG'),
}))

vi.mock('@shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('mongoose', () => ({ default: { connection: { readyState: 1 } } }))
vi.mock('@shared/redis', () => ({ redis: { ping: mocks.ping } }))

import { GET } from '../route'

const originalHealthToken = process.env.HEALTH_CHECK_TOKEN
const originalSurface = process.env.IPG_SURFACE

afterEach(() => {
  if (originalHealthToken === undefined) delete process.env.HEALTH_CHECK_TOKEN
  else process.env.HEALTH_CHECK_TOKEN = originalHealthToken
  if (originalSurface === undefined) delete process.env.IPG_SURFACE
  else process.env.IPG_SURFACE = originalSurface
  vi.clearAllMocks()
})

describe('GET Hire media object protocol release marker', () => {
  it('exposes the pinned v2 marker to an authenticated Hire control probe', async () => {
    process.env.HEALTH_CHECK_TOKEN = 'gate-secret'
    process.env.IPG_SURFACE = 'hire-control'

    const response = await GET(new NextRequest('https://hire.example.test/api/health', {
      headers: { authorization: 'Bearer gate-secret' },
    }))

    await expect(response.json()).resolves.toMatchObject({
      releaseGateAuthenticated: true,
      surface: 'hire-control',
      hireMediaObjectProtocol: 'v2-opaque-nonce-if-none-match-zero-seal',
    })
  })

  it('does not disclose the marker through the public health response', async () => {
    process.env.HEALTH_CHECK_TOKEN = 'gate-secret'
    process.env.IPG_SURFACE = 'hire-control'

    const response = await GET(new NextRequest('https://hire.example.test/api/health'))

    await expect(response.json()).resolves.toEqual({ status: 'ok' })
    expect(mocks.connectDB).not.toHaveBeenCalled()
    expect(mocks.ping).not.toHaveBeenCalled()
  })

  it.each(['b2c', 'hire-engine'] as const)(
    'reports the protocol as not applicable on the %s surface',
    async (surface) => {
      process.env.HEALTH_CHECK_TOKEN = 'gate-secret'
      process.env.IPG_SURFACE = surface

      const response = await GET(new NextRequest('https://example.test/api/health', {
        headers: { authorization: 'Bearer gate-secret' },
      }))

      await expect(response.json()).resolves.toMatchObject({
        releaseGateAuthenticated: true,
        surface,
        hireMediaObjectProtocol: 'not-applicable',
      })
    },
  )
})
