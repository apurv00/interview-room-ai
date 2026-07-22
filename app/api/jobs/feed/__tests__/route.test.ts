import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(),
  getFeed: vi.fn(),
  roleToJobsDomain: vi.fn(),
}))

vi.mock('@shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('@jobs', () => ({
  getFeed: mocks.getFeed,
  JOB_DOMAINS: [{ id: 'pm' }, { id: 'backend' }],
  roleToJobsDomain: mocks.roleToJobsDomain,
}))

import { GET, POST } from '../route'

const FEED = {
  cards: [],
  page: 1,
  pageSize: 20,
  hasMore: false,
  total: 0,
  sharpened: 0,
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
})

describe('/api/jobs/feed transport privacy', () => {
  it('keeps GET public for non-sensitive domain/page navigation', async () => {
    const response = await GET(new Request('http://localhost/api/jobs/feed?page=2&domain=pm'))

    expect(response.status).toBe(200)
    expect(mocks.getFeed).toHaveBeenCalledWith({ domain: 'pm', page: 2 })
    expect(mocks.roleToJobsDomain).not.toHaveBeenCalled()
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
      page: 3,
      targetRole: '  Backend Engineer  ',
      skills: [' TypeScript ', 'typescript', '', 'React', ' REACT '],
    })

    expect(response.status).toBe(200)
    expect(mocks.roleToJobsDomain).toHaveBeenCalledWith('Backend Engineer')
    expect(mocks.getFeed).toHaveBeenCalledWith({
      domain: undefined,
      roleDomain: 'backend',
      page: 3,
      skills: ['TypeScript', 'React'],
      targetRole: 'Backend Engineer',
    })
    expect(response.headers.get('cache-control')).toContain('private')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('pragma')).toBe('no-cache')
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
    ['invalid page', { page: 0 }],
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

  it('keeps unexpected personalized-feed failures private and non-cacheable', async () => {
    mocks.getFeed.mockRejectedValueOnce(new Error('database unavailable'))

    const response = await post({ targetRole: 'Product Manager' })

    expect(response.status).toBe(500)
    expect(response.headers.get('cache-control')).toContain('private')
    expect(response.headers.get('cache-control')).toContain('no-store')
    await expect(response.json()).resolves.toEqual({ error: 'Unable to load personalized jobs' })
  })
})
