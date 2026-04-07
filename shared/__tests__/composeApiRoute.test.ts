import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { z } from 'zod'

// Mock dependencies before importing
vi.mock('next-auth', () => ({
  getServerSession: vi.fn(),
}))

vi.mock('@shared/auth/authOptions', () => ({
  authOptions: {},
}))

vi.mock('@shared/redis', () => ({
  redis: {
    incr: vi.fn().mockResolvedValue(1),
    pexpire: vi.fn().mockResolvedValue(true),
  },
}))

vi.mock('@shared/logger', () => ({
  aiLogger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { getServerSession } from 'next-auth'
import { redis } from '@shared/redis'
import { AppError } from '@shared/errors'

const TestSchema = z.object({
  name: z.string(),
  value: z.number(),
})

function createRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const defaultOptions = {
  schema: TestSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 10, keyPrefix: 'rl:test' },
}

describe('composeApiRoute', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.mocked(redis.incr).mockResolvedValue(1)
    vi.mocked(redis.pexpire).mockResolvedValue(true)
  })

  it('returns 401 when no session and auth required', async () => {
    vi.mocked(getServerSession).mockResolvedValue(null)

    const handler = composeApiRoute({
      ...defaultOptions,
      handler: vi.fn(),
    })

    const res = await handler(createRequest({ name: 'test', value: 1 }))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Unauthorized')
  })

  it('allows anonymous access when authOptional is true', async () => {
    vi.mocked(getServerSession).mockResolvedValue(null)

    const mockHandler = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    )

    const handler = composeApiRoute({
      ...defaultOptions,
      authOptional: true,
      handler: mockHandler,
    })

    const res = await handler(createRequest({ name: 'test', value: 1 }))
    expect(res.status).toBe(200)
    expect(mockHandler).toHaveBeenCalledTimes(1)

    const ctx = mockHandler.mock.calls[0][1]
    expect(ctx.user.id).toBe('anonymous')
    expect(ctx.user.role).toBe('candidate')
  })

  it('passes authenticated user to handler', async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: 'user123', role: 'candidate', plan: 'pro', email: 'test@test.com' },
      expires: '',
    })

    const mockHandler = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    )

    const handler = composeApiRoute({
      ...defaultOptions,
      handler: mockHandler,
    })

    await handler(createRequest({ name: 'test', value: 1 }))

    const ctx = mockHandler.mock.calls[0][1]
    expect(ctx.user.id).toBe('user123')
    expect(ctx.user.role).toBe('candidate')
    expect(ctx.user.plan).toBe('pro')
  })

  it('returns 400 for invalid request body', async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: 'user123', role: 'candidate', plan: 'free', email: 'test@test.com' },
      expires: '',
    })

    const handler = composeApiRoute({
      ...defaultOptions,
      handler: vi.fn(),
    })

    const res = await handler(createRequest({ name: 123, value: 'not-a-number' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Validation failed')
    expect(body.details).toBeInstanceOf(Array)
  })

  it('returns 429 when rate limit exceeded', async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: 'user123', role: 'candidate', plan: 'free', email: 'test@test.com' },
      expires: '',
    })
    vi.mocked(redis.incr).mockResolvedValue(11) // exceeds maxRequests of 10

    const handler = composeApiRoute({
      ...defaultOptions,
      handler: vi.fn(),
    })

    const res = await handler(createRequest({ name: 'test', value: 1 }))
    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.error).toContain('Rate limit')
  })

  it('returns 429 with ANON_DAILY_LIMIT code when anonymous daily cap exceeded', async () => {
    vi.mocked(getServerSession).mockResolvedValue(null)
    // First incr (per-minute) is under maxRequests; second incr (anon-day) exceeds.
    let call = 0
    vi.mocked(redis.incr).mockImplementation(async () => {
      call++
      return call === 1 ? 1 : 4 // minute=1 (ok), day=4 (exceeds 3)
    })

    const mockHandler = vi.fn()
    const handler = composeApiRoute({
      ...defaultOptions,
      authOptional: true,
      rateLimit: { ...defaultOptions.rateLimit, anonDailyLimit: 3 },
      handler: mockHandler,
    })

    const res = await handler(createRequest({ name: 'test', value: 1 }))
    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.code).toBe('ANON_DAILY_LIMIT')
    expect(mockHandler).not.toHaveBeenCalled()
  })

  it('allows anonymous request when daily counter under cap', async () => {
    vi.mocked(getServerSession).mockResolvedValue(null)
    let call = 0
    vi.mocked(redis.incr).mockImplementation(async () => {
      call++
      return call === 1 ? 1 : 2 // minute=1, day=2 (under 3)
    })

    const mockHandler = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    )
    const handler = composeApiRoute({
      ...defaultOptions,
      authOptional: true,
      rateLimit: { ...defaultOptions.rateLimit, anonDailyLimit: 3 },
      handler: mockHandler,
    })

    const res = await handler(createRequest({ name: 'test', value: 1 }))
    expect(res.status).toBe(200)
    expect(mockHandler).toHaveBeenCalledTimes(1)
  })

  it('does NOT enforce anonDailyLimit on authenticated users', async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: 'user123', role: 'candidate', plan: 'free', email: 'test@test.com' },
      expires: '',
    })
    // Single incr (only the minute window); no day-window check fires.
    vi.mocked(redis.incr).mockClear()
    vi.mocked(redis.incr).mockResolvedValue(1)

    const mockHandler = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    )
    const handler = composeApiRoute({
      ...defaultOptions,
      authOptional: true,
      rateLimit: { ...defaultOptions.rateLimit, anonDailyLimit: 3 },
      handler: mockHandler,
    })

    const res = await handler(createRequest({ name: 'test', value: 1 }))
    expect(res.status).toBe(200)
    expect(redis.incr).toHaveBeenCalledTimes(1) // only minute window
  })

  it('allows request through when under rate limit', async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: 'user123', role: 'candidate', plan: 'free', email: 'test@test.com' },
      expires: '',
    })
    vi.mocked(redis.incr).mockResolvedValue(5) // under limit

    const mockHandler = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    )

    const handler = composeApiRoute({
      ...defaultOptions,
      handler: mockHandler,
    })

    const res = await handler(createRequest({ name: 'test', value: 1 }))
    expect(res.status).toBe(200)
    expect(mockHandler).toHaveBeenCalledTimes(1)
  })

  it('sets TTL on first rate limit increment', async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: 'user123', role: 'candidate', plan: 'free', email: 'test@test.com' },
      expires: '',
    })
    vi.mocked(redis.incr).mockResolvedValue(1) // first increment

    const mockHandler = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    )

    const handler = composeApiRoute({
      ...defaultOptions,
      handler: mockHandler,
    })

    await handler(createRequest({ name: 'test', value: 1 }))
    expect(redis.pexpire).toHaveBeenCalledWith('rl:test:user123', 60_000)
  })

  it('allows request through when Redis fails (fail-open)', async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: 'user123', role: 'candidate', plan: 'free', email: 'test@test.com' },
      expires: '',
    })
    vi.mocked(redis.incr).mockRejectedValue(new Error('Redis down'))

    const mockHandler = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    )

    const handler = composeApiRoute({
      ...defaultOptions,
      handler: mockHandler,
    })

    const res = await handler(createRequest({ name: 'test', value: 1 }))
    expect(res.status).toBe(200)
    expect(mockHandler).toHaveBeenCalledTimes(1)
  })

  it('handles AppError from handler with correct status code', async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: 'user123', role: 'candidate', plan: 'free', email: 'test@test.com' },
      expires: '',
    })

    const handler = composeApiRoute({
      ...defaultOptions,
      handler: async () => {
        throw new AppError('Custom error', 403, 'FORBIDDEN')
      },
    })

    const res = await handler(createRequest({ name: 'test', value: 1 }))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('Custom error')
    expect(body.code).toBe('FORBIDDEN')
  })

  it('returns 500 for unknown errors from handler', async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: 'user123', role: 'candidate', plan: 'free', email: 'test@test.com' },
      expires: '',
    })

    const handler = composeApiRoute({
      ...defaultOptions,
      handler: async () => {
        throw new Error('Unexpected crash')
      },
    })

    const res = await handler(createRequest({ name: 'test', value: 1 }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Internal server error')
  })

  it('passes parsed body to handler', async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: 'user123', role: 'candidate', plan: 'free', email: 'test@test.com' },
      expires: '',
    })

    const mockHandler = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    )

    const handler = composeApiRoute({
      ...defaultOptions,
      handler: mockHandler,
    })

    await handler(createRequest({ name: 'hello', value: 42 }))

    const ctx = mockHandler.mock.calls[0][1]
    expect(ctx.body).toEqual({ name: 'hello', value: 42 })
  })
})
