import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  user: { id: '507f1f77bcf86cd799439010' } as { id: string } | null,
  connectDB: vi.fn(),
  productEventCreate: vi.fn(),
  recordJobsUserEvent: vi.fn(),
  stitchAnonEventsToUser: vi.fn(),
  anonIdFromCookieHeader: vi.fn(),
}))

vi.mock('@shared/middleware/composeApiRoute', () => ({
  composeApiRoute: (options: {
    handler: (
      req: NextRequest,
      context: { body: Record<string, unknown>; user: { id: string } | null },
    ) => Promise<Response>
  }) => async (req: NextRequest) => options.handler(req, {
    body: await req.json(),
    user: mocks.user,
  }),
}))
vi.mock('@shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('@shared/db/models', () => ({ ProductEvent: { create: mocks.productEventCreate } }))
vi.mock('@shared/logger', () => ({ logger: { warn: vi.fn() } }))
vi.mock('@jobs/services/userEventService', () => ({ recordJobsUserEvent: mocks.recordJobsUserEvent }))
vi.mock('@jobs', () => ({
  ProductEventInputSchema: {},
  ANON_COOKIE: 'jobs_anon',
  ANON_COOKIE_MAX_AGE: 3600,
  anonIdFromCookieHeader: mocks.anonIdFromCookieHeader,
  mintAnonCookie: () => ({ anonId: 'minted-anon', cookieValue: 'signed-cookie' }),
  stitchAnonEventsToUser: mocks.stitchAnonEventsToUser,
}))

import { POST } from '../route'

const request = (name = 'jobs.feed_viewed') => new NextRequest('http://localhost/api/events', {
  method: 'POST',
  body: JSON.stringify({ name, props: { source: 'test' } }),
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.user = { id: '507f1f77bcf86cd799439010' }
  mocks.connectDB.mockResolvedValue(undefined)
  mocks.recordJobsUserEvent.mockResolvedValue(true)
  mocks.anonIdFromCookieHeader.mockReturnValue(null)
})

describe('POST /api/events account-deletion fence', () => {
  it('routes authenticated telemetry through the fenced Jobs writer', async () => {
    const response = await POST(request())

    expect(response.status).toBe(204)
    expect(mocks.recordJobsUserEvent).toHaveBeenCalledWith(expect.objectContaining({
      userId: '507f1f77bcf86cd799439010',
      name: 'jobs.feed_viewed',
    }))
    expect(mocks.productEventCreate).not.toHaveBeenCalled()
  })

  it('does not fall back to an unfenced insert when a deleting account is refused', async () => {
    mocks.recordJobsUserEvent.mockResolvedValue(false)

    const response = await POST(request())

    expect(response.status).toBe(204)
    expect(mocks.recordJobsUserEvent).toHaveBeenCalledOnce()
    expect(mocks.productEventCreate).not.toHaveBeenCalled()
  })

  it('keeps anonymous telemetry on the anonymous-only insert path', async () => {
    mocks.user = null
    mocks.anonIdFromCookieHeader.mockReturnValue('anon-1')

    const response = await POST(request())

    expect(response.status).toBe(204)
    expect(mocks.productEventCreate).toHaveBeenCalledWith(expect.objectContaining({
      anonId: 'anon-1',
      name: 'jobs.feed_viewed',
    }))
    expect(mocks.recordJobsUserEvent).not.toHaveBeenCalled()
  })
})
