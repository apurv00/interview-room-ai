import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  checkRateLimit: vi.fn(),
}))

vi.mock('@/modules/hire-status/services/candidateStatusLinkService', () => ({
  resolveCandidateStatusLink: mocks.resolve,
}))
vi.mock('@shared/middleware/checkRateLimit', () => ({
  checkRateLimit: mocks.checkRateLimit,
}))

import { POST } from '../route'

const LINK_ID = 'a'.repeat(24)
const WORKSPACE_ID = '1'.repeat(24)
const APPLICATION_ID = '2'.repeat(24)
const JOB_ID = '3'.repeat(24)
const CANDIDATE_ID = '4'.repeat(24)
const CAPABILITY = `${WORKSPACE_ID}.${APPLICATION_ID}.${JOB_ID}.${CANDIDATE_ID}.${LINK_ID}.${'bc'.repeat(32)}`
const CAPABILITY_DIGEST = createHash('sha256').update(CAPABILITY, 'utf8').digest('hex')

function capabilityWithSecret(secret: string): string {
  return `${WORKSPACE_ID}.${APPLICATION_ID}.${JOB_ID}.${CANDIDATE_ID}.${LINK_ID}.${secret}`
}

function installCountingRateLimit() {
  const counts = new Map<string, number>()
  mocks.checkRateLimit.mockImplementation(
    async (identifier: string, config: { keyPrefix: string; maxRequests: number }) => {
      const bucket = `${config.keyPrefix}:${identifier}`
      const next = (counts.get(bucket) ?? 0) + 1
      counts.set(bucket, next)
      return next > config.maxRequests
        ? NextResponse.json({ error: 'limited' }, { status: 429 })
        : null
    },
  )
  return counts
}

function capabilityLimitIdentifiers(prefix: string): string[] {
  return mocks.checkRateLimit.mock.calls
    .filter(([, config]) => config.keyPrefix === prefix)
    .map(([identifier]) => identifier as string)
}

function request(body: Record<string, unknown>, ip = '198.51.100.8') {
  return new NextRequest(`http://localhost/api/candidate-status/${LINK_ID}/bootstrap`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': ip,
      'x-forwarded-for': '203.0.113.44',
    },
    body: JSON.stringify(body),
  })
}

function routeParams(linkId = LINK_ID) {
  return { params: Promise.resolve({ linkId }) }
}

function activeStatus() {
  return {
    phase: 'interviewing',
    progress: { current: 2, total: 3 },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.checkRateLimit.mockResolvedValue(null)
  mocks.resolve.mockResolvedValue(activeStatus())
})

describe('POST /api/candidate-status/[linkId]/bootstrap', () => {
  it('opens only a valid fragment capability with dual fail-closed private limits', async () => {
    const response = await POST(request({ capability: CAPABILITY }), routeParams())

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
    await expect(response.json()).resolves.toEqual({
      state: 'ok',
      status: activeStatus(),
    })
    expect(mocks.checkRateLimit).toHaveBeenNthCalledWith(
      1,
      '198.51.100.8',
      expect.objectContaining({
        keyPrefix: 'rl:hire-candidate-status-bootstrap-ip',
        maxRequests: 30,
        failClosed: true,
      }),
    )
    expect(mocks.checkRateLimit).toHaveBeenNthCalledWith(
      2,
      CAPABILITY_DIGEST,
      expect.objectContaining({
        keyPrefix: 'rl:hire-candidate-status-bootstrap-capability',
        maxRequests: 30,
        failClosed: true,
      }),
    )
    expect(mocks.resolve).toHaveBeenCalledWith({
      linkId: LINK_ID,
      capability: CAPABILITY,
    })
  })

  it("keeps guessed valid-format secrets out of a real holder's capability bucket", async () => {
    const counts = installCountingRateLimit()
    const capabilityPrefix = 'rl:hire-candidate-status-bootstrap-capability'
    mocks.resolve.mockImplementation(async ({ capability }: { capability: string }) =>
      capability === CAPABILITY ? activeStatus() : null,
    )

    for (let index = 0; index < 30; index += 1) {
      const spoofed = capabilityWithSecret(index.toString(16).padStart(64, '0'))
      const response = await POST(
        request({ capability: spoofed }, `198.51.100.${index + 1}`),
        routeParams(),
      )
      expect(response.status).toBe(410)
    }

    const holder = await POST(request({ capability: CAPABILITY }, '198.51.101.1'), routeParams())
    expect(holder.status).toBe(200)

    const identifiers = capabilityLimitIdentifiers(capabilityPrefix)
    expect(identifiers).toHaveLength(31)
    expect(new Set(identifiers)).toHaveLength(31)
    expect(identifiers).toContain(CAPABILITY_DIGEST)
    expect(identifiers).not.toContain(CAPABILITY)
    expect(identifiers).not.toContain(LINK_ID)
    expect(identifiers.every((identifier) => /^[a-f0-9]{64}$/.test(identifier))).toBe(true)
    expect(counts.get(`${capabilityPrefix}:${CAPABILITY_DIGEST}`)).toBe(1)
  })

  it('returns one inactive response for malformed, mismatched, and dead capabilities', async () => {
    const malformed = await POST(request({ capability: 'not-a-capability' }), routeParams())
    expect(malformed.status).toBe(410)
    expect(malformed.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mocks.resolve).not.toHaveBeenCalled()

    const mismatched = `${WORKSPACE_ID}.${APPLICATION_ID}.${JOB_ID}.${CANDIDATE_ID}.${'b'.repeat(24)}.${'bc'.repeat(32)}`
    const mismatchedResponse = await POST(request({ capability: mismatched }), routeParams())
    expect(mismatchedResponse.status).toBe(410)
    expect(mocks.resolve).not.toHaveBeenCalled()

    mocks.resolve.mockResolvedValueOnce(null)
    const dead = await POST(request({ capability: CAPABILITY }), routeParams())
    expect(dead.status).toBe(410)
    await expect(dead.json()).resolves.toEqual({
      error: 'This application status link is no longer active',
    })
  })

  it('keeps a limiter response private without resolving the capability', async () => {
    mocks.checkRateLimit.mockResolvedValueOnce(
      NextResponse.json({ error: 'limited' }, { status: 429 }),
    )
    const response = await POST(request({ capability: CAPABILITY }), routeParams())
    expect(response.status).toBe(429)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mocks.resolve).not.toHaveBeenCalled()
  })

  it('uses a bounded unknown-client bucket for malformed proxy identity', async () => {
    const malformedIp = new NextRequest(
      `http://localhost/api/candidate-status/${LINK_ID}/bootstrap`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': 'not-an-ip',
        },
        body: JSON.stringify({ capability: CAPABILITY }),
      },
    )
    await POST(malformedIp, routeParams())
    expect(mocks.checkRateLimit).toHaveBeenNthCalledWith(
      1,
      'unknown-client',
      expect.objectContaining({
        keyPrefix: 'rl:hire-candidate-status-bootstrap-ip',
      }),
    )
  })

  it('does not import B2C auth, cookies, or raw capability rate-limit keys', () => {
    const source = readFileSync(join(__dirname, '..', 'route.ts'), 'utf8')
    expect(source).not.toMatch(/next-auth|@shared\/auth|cookies\(/)
    expect(source).toContain('capabilityRateLimitKey(capability)')
    expect(source).toContain('failClosed: true')
  })
})
