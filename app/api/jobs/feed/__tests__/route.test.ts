import { createHash } from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(),
  getFeed: vi.fn(),
  roleToJobsDomain: vi.fn(),
  redisIncr: vi.fn(),
  redisPexpire: vi.fn(),
  InvalidFeedCursorError: class InvalidFeedCursorError extends Error {},
}))

vi.mock('@shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('@shared/redis', () => ({
  redis: {
    incr: mocks.redisIncr,
    pexpire: mocks.redisPexpire,
  },
}))
vi.mock('@jobs', () => ({
  getFeed: mocks.getFeed,
  JOB_DOMAINS: [{ id: 'pm' }, { id: 'backend' }],
  roleToJobsDomain: mocks.roleToJobsDomain,
  FEED_REMOTE_VALUES: ['remote'],
  FEED_EXPERIENCE_VALUES: ['entry', 'mid', 'senior'],
  FEED_FRESHNESS_VALUES: ['1d', '3d', '7d', '14d', '30d'],
  FEED_SORT_VALUES: ['best', 'newest'],
  FEED_CURSOR_DIRECTIONS: ['after', 'before'],
  InvalidFeedCursorError: mocks.InvalidFeedCursorError,
}))

import { GET, POST } from '../route'

const FEED = {
  cards: [],
  pageSize: 20,
  hasMore: false,
  hasPrevious: false,
  total: 0,
  accessibleTotal: 0,
  resultCap: 400,
  capped: false,
  sharpened: 0,
  sort: 'best',
}

function post(body: unknown, headers?: HeadersInit) {
  return POST(new Request('http://localhost/api/jobs/feed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connectDB.mockResolvedValue(undefined)
  mocks.getFeed.mockResolvedValue(FEED)
  mocks.roleToJobsDomain.mockReturnValue('backend')
  mocks.redisIncr.mockResolvedValue(1)
  mocks.redisPexpire.mockResolvedValue(1)
  vi.stubEnv('VERCEL', '')
  vi.stubEnv('NODE_ENV', 'test')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('/api/jobs/feed transport privacy', () => {
  it('keeps validated discovery filters public and preserves the one-row count consumer', async () => {
    const response = await GET(new Request(
      'http://localhost/api/jobs/feed?page=1&pageSize=1&domain=pm&q=Product&location=Bangalore&remote=remote&experience=mid&company=Acme&freshness=7d&sort=newest',
    ))

    expect(response.status).toBe(200)
    expect(mocks.getFeed).toHaveBeenCalledWith({
      domain: 'pm',
      search: 'Product',
      location: 'Bangalore',
      remote: 'remote',
      experience: 'mid',
      company: 'Acme',
      freshness: '7d',
      sort: 'newest',
      cursor: undefined,
      direction: undefined,
      pageSize: 1,
    })
    expect(mocks.roleToJobsDomain).not.toHaveBeenCalled()
  })

  it('maps supported Interview-role aliases to the canonical Jobs domain', async () => {
    const response = await GET(new Request(
      'http://localhost/api/jobs/feed?domain=product-designer',
    ))

    expect(response.status).toBe(200)
    expect(mocks.getFeed).toHaveBeenCalledWith(expect.objectContaining({ domain: 'design' }))
  })

  it('rejects an unsupported public domain before database work', async () => {
    const response = await GET(new Request(
      'http://localhost/api/jobs/feed?domain=custom-cms-role',
    ))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'UNSUPPORTED_JOB_DOMAIN' })
    expect(mocks.connectDB).not.toHaveBeenCalled()
    expect(mocks.getFeed).not.toHaveBeenCalled()
  })

  it('rejects a malformed domain instead of treating it as unfiltered', async () => {
    const response = await GET(new Request(
      'http://localhost/api/jobs/feed?domain=Product%20Designer',
    ))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'UNSUPPORTED_JOB_DOMAIN' })
    expect(mocks.connectDB).not.toHaveBeenCalled()
    expect(mocks.getFeed).not.toHaveBeenCalled()
  })

  it('rejects legacy offset pages after page one', async () => {
    const response = await GET(new Request('http://localhost/api/jobs/feed?page=2&domain=pm'))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'CURSOR_PAGINATION_REQUIRED' })
    expect(mocks.connectDB).not.toHaveBeenCalled()
  })

  it('rejects legacy resume-derived GET query values with a private migration error', async () => {
    const response = await GET(new Request(
      'http://localhost/api/jobs/feed?page=2&domain=pm&targetRole=Private%20Role&skills=SecretSkill',
    ))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'PERSONALIZATION_REQUIRES_POST' })
    expect(response.headers.get('cache-control')).toContain('private')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(mocks.connectDB).not.toHaveBeenCalled()
    expect(mocks.getFeed).not.toHaveBeenCalled()
  })

  it('accepts personalized signals only in a bounded POST body and deduplicates skills', async () => {
    const response = await post({
      page: 1,
      experience: 'entry',
      targetRole: '  Backend Engineer  ',
      skills: [' TypeScript ', 'typescript', '', 'React', ' REACT '],
    })

    expect(response.status).toBe(200)
    expect(mocks.roleToJobsDomain).toHaveBeenCalledWith('Backend Engineer')
    expect(mocks.getFeed).toHaveBeenCalledWith({
      domain: undefined,
      roleDomain: 'backend',
      search: undefined,
      location: undefined,
      remote: undefined,
      experience: 'entry',
      company: undefined,
      freshness: undefined,
      sort: undefined,
      cursor: undefined,
      direction: undefined,
      pageSize: undefined,
      skills: ['TypeScript', 'React'],
      targetRole: 'Backend Engineer',
    })
    expect(response.headers.get('cache-control')).toContain('private')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('pragma')).toBe('no-cache')
  })

  it('rejects an unsupported personalized domain before database work', async () => {
    const response = await post({ domain: 'custom-cms-role', targetRole: 'Backend Engineer' })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'UNSUPPORTED_JOB_DOMAIN' })
    expect(response.headers.get('cache-control')).toContain('private')
    expect(mocks.connectDB).not.toHaveBeenCalled()
    expect(mocks.getFeed).not.toHaveBeenCalled()
  })

  it('lets an explicit public domain override role-derived soft-domain ranking', async () => {
    await post({ domain: 'pm', targetRole: 'Backend Engineer', skills: ['Roadmaps'] })

    expect(mocks.roleToJobsDomain).not.toHaveBeenCalled()
    expect(mocks.getFeed).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'pm',
      roleDomain: undefined,
    }))
  })

  it.each([
    ['unknown fields', { targetRole: 'PM', resumeText: 'private resume' }],
    ['too many skills', { skills: Array.from({ length: 21 }, (_, index) => `skill-${index}`) }],
    ['oversized skill', { skills: ['x'.repeat(41)] }],
    ['oversized role', { targetRole: 'x'.repeat(81) }],
    ['invalid page', { page: 2 }],
  ])('rejects %s before database work', async (_label, body) => {
    const response = await post(body)

    expect(response.status).toBe(400)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(mocks.connectDB).not.toHaveBeenCalled()
    expect(mocks.getFeed).not.toHaveBeenCalled()
  })

  it('rejects a declared oversized body before parsing or database work', async () => {
    const response = await post({ targetRole: 'PM' }, { 'Content-Length': '9000' })

    expect(response.status).toBe(413)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(mocks.connectDB).not.toHaveBeenCalled()
  })

  it('rejects an actually oversized body when content-length is absent', async () => {
    const response = await POST(new Request('http://localhost/api/jobs/feed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(9_000) }),
    }))

    expect(response.status).toBe(413)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(mocks.connectDB).not.toHaveBeenCalled()
  })

  it('returns a private 400 for malformed JSON', async () => {
    const response = await POST(new Request('http://localhost/api/jobs/feed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{broken',
    }))

    expect(response.status).toBe(400)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(mocks.connectDB).not.toHaveBeenCalled()
  })

  it('maps malformed or query-mismatched cursors to an explicit 400', async () => {
    mocks.getFeed.mockRejectedValueOnce(new mocks.InvalidFeedCursorError())

    const response = await GET(new Request('http://localhost/api/jobs/feed?cursor=bad&direction=after'))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'INVALID_FEED_CURSOR' })
  })

  it('rate-limits database-backed public reads before connecting', async () => {
    mocks.redisIncr.mockResolvedValueOnce(31)

    const response = await GET(new Request('http://localhost/api/jobs/feed', {
      headers: { 'x-forwarded-for': '203.0.113.9' },
    }))

    expect(response.status).toBe(429)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(mocks.redisIncr).toHaveBeenCalledWith(expect.stringMatching(/^rl:jobs:feed:ip:[a-f0-9]{24}$/))
    expect(mocks.connectDB).not.toHaveBeenCalled()
  })

  it('prefers Cloudflare client identity over a spoofed forwarded chain', async () => {
    await GET(new Request('http://localhost/api/jobs/feed', {
      headers: {
        'cf-connecting-ip': '198.51.100.7',
        'x-forwarded-for': '203.0.113.99',
      },
    }))

    const hash = createHash('sha256').update('198.51.100.7').digest('hex').slice(0, 24)
    expect(mocks.redisIncr).toHaveBeenCalledWith(`rl:jobs:feed:ip:${hash}`)
  })

  it('places missing or malformed proxy identity in a bounded shared bucket', async () => {
    await GET(new Request('http://localhost/api/jobs/feed', {
      headers: { 'x-forwarded-for': 'not-an-ip' },
    }))

    const hash = createHash('sha256').update('unknown-client').digest('hex').slice(0, 24)
    expect(mocks.redisIncr).toHaveBeenCalledWith(`rl:jobs:feed:ip:${hash}`)
  })

  it('fails the costly public read closed when Redis is unavailable', async () => {
    mocks.redisIncr.mockRejectedValueOnce(new Error('redis unavailable'))

    const response = await GET(new Request('http://localhost/api/jobs/feed'))

    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toMatchObject({ code: 'FEED_RATE_LIMIT_UNAVAILABLE' })
    expect(mocks.connectDB).not.toHaveBeenCalled()
  })

  it('requires REDIS_URL for production feed reads instead of falling back to localhost', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('REDIS_URL', '')

    const response = await GET(new Request('http://localhost/api/jobs/feed'))

    expect(response.status).toBe(503)
    expect(mocks.redisIncr).not.toHaveBeenCalled()
    expect(mocks.connectDB).not.toHaveBeenCalled()
  })

  it('keeps unexpected personalized-feed failures private and non-cacheable', async () => {
    mocks.getFeed.mockRejectedValueOnce(new Error('database unavailable'))

    const response = await post({ targetRole: 'Product Manager' })

    expect(response.status).toBe(500)
    expect(response.headers.get('cache-control')).toContain('private')
    expect(response.headers.get('cache-control')).toContain('no-store')
    await expect(response.json()).resolves.toEqual({ error: 'Unable to load personalized jobs' })
  })
})
