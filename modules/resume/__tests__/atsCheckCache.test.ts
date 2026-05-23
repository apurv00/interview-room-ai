import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockRedisGet, mockRedisSet } = vi.hoisted(() => ({
  mockRedisGet: vi.fn(),
  mockRedisSet: vi.fn(),
}))

vi.mock('@shared/redis', () => ({
  redis: {
    get: (...args: unknown[]) => mockRedisGet(...args),
    set: (...args: unknown[]) => mockRedisSet(...args),
  },
}))

import {
  buildAtsCacheKey,
  getCachedAtsResult,
  setCachedAtsResult,
} from '@resume/services/atsCheckCache'

describe('buildAtsCacheKey', () => {
  it('produces the same key for the same resume + JD pair', () => {
    const a = buildAtsCacheKey({ resumeText: 'My resume', jobDescription: 'Software engineer' })
    const b = buildAtsCacheKey({ resumeText: 'My resume', jobDescription: 'Software engineer' })
    expect(a).toBe(b)
  })

  it('treats whitespace and casing as equivalent (content-keyed normalization)', () => {
    const a = buildAtsCacheKey({ resumeText: 'My resume', jobDescription: 'Software engineer' })
    const b = buildAtsCacheKey({
      resumeText: '  MY   RESUME  ',
      jobDescription: 'software\n  engineer  ',
    })
    expect(a).toBe(b)
  })

  it('produces different keys when content actually differs', () => {
    const a = buildAtsCacheKey({ resumeText: 'My resume', jobDescription: 'Software engineer' })
    const b = buildAtsCacheKey({ resumeText: 'My OTHER resume', jobDescription: 'Software engineer' })
    expect(a).not.toBe(b)
  })

  it('produces different keys when JD changes but resume stays the same', () => {
    const a = buildAtsCacheKey({ resumeText: 'My resume', jobDescription: 'Software engineer' })
    const b = buildAtsCacheKey({ resumeText: 'My resume', jobDescription: 'Product manager' })
    expect(a).not.toBe(b)
  })

  it('treats absent vs empty JD as the same key', () => {
    const a = buildAtsCacheKey({ resumeText: 'My resume' })
    const b = buildAtsCacheKey({ resumeText: 'My resume', jobDescription: '' })
    expect(a).toBe(b)
  })

  it('uses the documented v1 namespace prefix', () => {
    const k = buildAtsCacheKey({ resumeText: 'r' })
    expect(k.startsWith('ats-check:v1:')).toBe(true)
  })
})

describe('getCachedAtsResult', () => {
  beforeEach(() => {
    mockRedisGet.mockReset()
  })

  it('returns null on a cache miss', async () => {
    mockRedisGet.mockResolvedValue(null)
    expect(await getCachedAtsResult('ats-check:v1:x')).toBeNull()
  })

  it('parses and returns the stored JSON on a cache hit', async () => {
    mockRedisGet.mockResolvedValue(JSON.stringify({ score: 82, summary: 'OK' }))
    const v = await getCachedAtsResult<{ score: number; summary: string }>('ats-check:v1:x')
    expect(v).toEqual({ score: 82, summary: 'OK' })
  })

  it('returns null (logs + recovers) when Redis throws', async () => {
    mockRedisGet.mockRejectedValue(new Error('redis down'))
    expect(await getCachedAtsResult('ats-check:v1:x')).toBeNull()
  })

  it('returns null when the cached payload is malformed JSON', async () => {
    mockRedisGet.mockResolvedValue('not json')
    expect(await getCachedAtsResult('ats-check:v1:x')).toBeNull()
  })
})

describe('setCachedAtsResult', () => {
  beforeEach(() => {
    mockRedisSet.mockReset()
  })

  it('serializes the value and writes with a 7-day TTL', async () => {
    mockRedisSet.mockResolvedValue('OK')
    await setCachedAtsResult('ats-check:v1:x', { score: 91 })
    expect(mockRedisSet).toHaveBeenCalledTimes(1)
    const [key, payload, mode, ttl] = mockRedisSet.mock.calls[0]
    expect(key).toBe('ats-check:v1:x')
    expect(JSON.parse(payload as string)).toEqual({ score: 91 })
    expect(mode).toBe('EX')
    expect(ttl).toBe(7 * 24 * 60 * 60)
  })

  it('swallows write errors so a Redis failure cannot break the user-facing response', async () => {
    mockRedisSet.mockRejectedValue(new Error('redis down'))
    await expect(setCachedAtsResult('ats-check:v1:x', { score: 50 })).resolves.toBeUndefined()
  })
})
