import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  submit: vi.fn(),
  checkRateLimit: vi.fn(),
}))

vi.mock('@hire', () => ({
  bootstrapHumanInterviewKit: mocks.bootstrap,
  submitHumanInterviewKitScorecard: mocks.submit,
}))
vi.mock('@shared/middleware/checkRateLimit', () => ({
  checkRateLimit: mocks.checkRateLimit,
}))

import { POST as bootstrap } from '../bootstrap/route'
import { POST as submitScorecard } from '../scorecard/route'

const KIT_ID = 'a'.repeat(24)
const WORKSPACE_ID = '1'.repeat(24)
const CAPABILITY = `${WORKSPACE_ID}.${KIT_ID}.${'bc'.repeat(32)}`

const DIMENSIONS = [
  { key: 'role_capability', rating: 4, evidence: 'Relevant practical example.' },
  { key: 'problem_solving', rating: 4, evidence: 'Structured the ambiguous problem.' },
  { key: 'communication', rating: 5, evidence: 'Clear, concise explanation.' },
  { key: 'collaboration', rating: 4, evidence: 'Included partner perspectives.' },
] as const

function request(path: 'bootstrap' | 'scorecard', body: Record<string, unknown>, ip = '198.51.100.8') {
  return new NextRequest(`http://localhost/api/interview-kit/${KIT_ID}/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': ip,
      'x-forwarded-for': '203.0.113.44',
    },
    body: JSON.stringify(body),
  })
}

function routeParams(kitId = KIT_ID) {
  return { params: Promise.resolve({ kitId }) }
}

function activeView() {
  return {
    workspaceName: 'Example Co',
    jobTitle: 'Senior Full-Stack Engineer',
    interviewerName: 'Jordan',
    brief: {
      candidateName: 'Ada Lovelace',
      experienceYears: 5,
      location: 'Bengaluru',
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.checkRateLimit.mockResolvedValue(null)
  mocks.bootstrap.mockResolvedValue(activeView())
  mocks.submit.mockResolvedValue({ state: 'submitted' })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('POST /api/interview-kit/[kitId]/bootstrap', () => {
  it('opens only a valid fragment capability, with dual public limits and private response headers', async () => {
    const response = await bootstrap(
      request('bootstrap', { capability: CAPABILITY }),
      routeParams(),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
    await expect(response.json()).resolves.toEqual({ state: 'ok', ...activeView() })
    expect(mocks.checkRateLimit).toHaveBeenNthCalledWith(
      1,
      '198.51.100.8',
      expect.objectContaining({
        keyPrefix: 'rl:hire-human-kit-bootstrap-ip',
        maxRequests: 30,
        failClosed: true,
      }),
    )
    expect(mocks.checkRateLimit).toHaveBeenNthCalledWith(
      2,
      KIT_ID,
      expect.objectContaining({
        keyPrefix: 'rl:hire-human-kit-bootstrap-kit',
        maxRequests: 30,
        failClosed: true,
      }),
    )
    expect(mocks.bootstrap).toHaveBeenCalledWith({ kitId: KIT_ID, capability: CAPABILITY })
  })

  it('uses a bounded bucket for malformed proxy identity and Vercel-owned header when available', async () => {
    const malformedIpRequest = new NextRequest(
      `http://localhost/api/interview-kit/${KIT_ID}/bootstrap`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': 'not-an-ip',
          'x-real-ip': 'also-not-an-ip',
          'x-forwarded-for': 'still-not-an-ip',
        },
        body: JSON.stringify({ capability: CAPABILITY }),
      },
    )
    await bootstrap(malformedIpRequest, routeParams())
    expect(mocks.checkRateLimit).toHaveBeenNthCalledWith(
      1,
      'unknown-client',
      expect.objectContaining({ keyPrefix: 'rl:hire-human-kit-bootstrap-ip' }),
    )

    vi.stubEnv('VERCEL', '1')
    const vercelRequest = new NextRequest(`http://localhost/api/interview-kit/${KIT_ID}/bootstrap`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vercel-forwarded-for': '198.51.100.9',
        'x-forwarded-for': '203.0.113.44',
      },
      body: JSON.stringify({ capability: CAPABILITY }),
    })
    await bootstrap(vercelRequest, routeParams())
    expect(mocks.checkRateLimit).toHaveBeenLastCalledWith(
      KIT_ID,
      expect.objectContaining({ keyPrefix: 'rl:hire-human-kit-bootstrap-kit' }),
    )
    expect(mocks.checkRateLimit.mock.calls.at(-2)).toEqual([
      '198.51.100.9',
      expect.objectContaining({ keyPrefix: 'rl:hire-human-kit-bootstrap-ip' }),
    ])
  })

  it('returns the same private inactive response for malformed, absent, and dead capabilities', async () => {
    const malformed = await bootstrap(
      request('bootstrap', { capability: 'not-a-capability' }),
      routeParams(),
    )
    expect(malformed.status).toBe(410)
    expect(malformed.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mocks.bootstrap).not.toHaveBeenCalled()

    const mismatchedCapability = `${WORKSPACE_ID}.${'b'.repeat(24)}.${'bc'.repeat(32)}`
    const mismatched = await bootstrap(
      request('bootstrap', { capability: mismatchedCapability }),
      routeParams(),
    )
    expect(mismatched.status).toBe(410)
    expect(mocks.bootstrap).not.toHaveBeenCalled()

    mocks.bootstrap.mockResolvedValueOnce(null)
    const dead = await bootstrap(request('bootstrap', { capability: CAPABILITY }), routeParams())
    expect(dead.status).toBe(410)
    await expect(dead.json()).resolves.toEqual({
      error: 'This interview kit link is no longer active',
    })
  })

  it('makes a limiter response private and does not inspect the kit', async () => {
    mocks.checkRateLimit.mockResolvedValueOnce(NextResponse.json({ error: 'limited' }, { status: 429 }))

    const response = await bootstrap(request('bootstrap', { capability: CAPABILITY }), routeParams())

    expect(response.status).toBe(429)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mocks.bootstrap).not.toHaveBeenCalled()
  })
})

describe('POST /api/interview-kit/[kitId]/scorecard', () => {
  const validBody = {
    capability: CAPABILITY,
    dimensions: DIMENSIONS,
    recommendation: 'yes',
    overallComment: 'Strong practical evidence and thoughtful communication.',
  }

  it('submits the fixed canonical scorecard and returns no reusable result data', async () => {
    const response = await submitScorecard(request('scorecard', validBody), routeParams())

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({ state: 'submitted' })
    expect(mocks.submit).toHaveBeenCalledWith({ kitId: KIT_ID, ...validBody })
    expect(mocks.checkRateLimit).toHaveBeenNthCalledWith(
      1,
      '198.51.100.8',
      expect.objectContaining({
        keyPrefix: 'rl:hire-human-kit-scorecard-ip',
        maxRequests: 8,
        failClosed: true,
      }),
    )
    expect(mocks.checkRateLimit).toHaveBeenNthCalledWith(
      2,
      KIT_ID,
      expect.objectContaining({
        keyPrefix: 'rl:hire-human-kit-scorecard-kit',
        maxRequests: 8,
        failClosed: true,
      }),
    )
  })

  it('rejects reordered, duplicate, or malformed fixed dimensions before the service', async () => {
    const reordered = {
      ...validBody,
      dimensions: [...DIMENSIONS].reverse(),
    }
    const response = await submitScorecard(request('scorecard', reordered), routeParams())

    expect(response.status).toBe(410)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mocks.submit).not.toHaveBeenCalled()
  })

  it('maps a stale submit result to the same inactive response', async () => {
    mocks.submit.mockResolvedValueOnce(null)
    const response = await submitScorecard(request('scorecard', validBody), routeParams())

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toEqual({
      error: 'This interview kit link is no longer active',
    })
  })
})

describe('human kit public-route isolation guards', () => {
  it('does not import B2C authentication, database users, or cookie/session helpers', () => {
    for (const relative of [
      'app/api/interview-kit/[kitId]/bootstrap/route.ts',
      'app/api/interview-kit/[kitId]/scorecard/route.ts',
    ]) {
      const source = readFileSync(join(process.cwd(), relative), 'utf8')
      expect(source).not.toMatch(/next-auth|@shared\/auth|@shared\/db\/models|cookies\(/)
      expect(source).not.toMatch(/User\.(?:find|findOne|create|update)/)
    }
  })
})
