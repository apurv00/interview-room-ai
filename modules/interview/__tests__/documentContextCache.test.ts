import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockRedisGet = vi.fn()
const mockRedisSetex = vi.fn()

vi.mock('@shared/redis', () => ({
  redis: {
    get: (...args: unknown[]) => mockRedisGet(...args),
    setex: (...args: unknown[]) => mockRedisSetex(...args),
  },
}))

vi.mock('@shared/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

const mockFindById = vi.fn()
const mockFindByIdAndUpdate = vi.fn()

vi.mock('@shared/db/models', () => ({
  InterviewSession: {
    findById: (...args: unknown[]) => mockFindById(...args),
    findByIdAndUpdate: (...args: unknown[]) => mockFindByIdAndUpdate(...args),
  },
}))

const mockParseJobDescription = vi.fn()
const mockBuildParsedJDContext = vi.fn()

vi.mock('@interview/services/persona/jdParserService', () => ({
  parseJobDescription: (...args: unknown[]) => mockParseJobDescription(...args),
  buildParsedJDContext: (...args: unknown[]) => mockBuildParsedJDContext(...args),
}))

const mockParseAndCacheResume = vi.fn()
const mockBuildParsedResumeContext = vi.fn()

vi.mock('@interview/services/persona/resumeContextService', () => ({
  parseAndCacheResume: (...args: unknown[]) => mockParseAndCacheResume(...args),
  buildParsedResumeContext: (...args: unknown[]) => mockBuildParsedResumeContext(...args),
}))

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import {
  getCachedJDContext,
  getOrLoadJDContext,
  getOrLoadResumeContext,
  setCachedJDContext,
  setCachedResumeContext,
} from '@interview/services/persona/documentContextCache'

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeLeanQuery(returnValue: unknown) {
  return {
    select: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(returnValue),
    }),
  }
}

async function flushMicrotasks() {
  // Give fire-and-forget parses a chance to start.
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('documentContextCache', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getOrLoadJDContext', () => {
    it('returns cached value on Redis hit', async () => {
      mockRedisGet.mockResolvedValue('CACHED_JD_CONTEXT')
      const result = await getOrLoadJDContext('sess-a', 'raw JD text')
      expect(result).toBe('CACHED_JD_CONTEXT')
      expect(mockFindById).not.toHaveBeenCalled()
      expect(mockParseJobDescription).not.toHaveBeenCalled()
    })

    it('falls back to Mongo when Redis misses, re-warms cache', async () => {
      mockRedisGet.mockResolvedValue(null)
      mockFindById.mockReturnValue(
        makeLeanQuery({
          parsedJobDescription: {
            requirements: [{ id: 'r1', requirement: 'PM', importance: 'must-have', category: 'experience', targetCompetencies: [] }],
          },
        }),
      )
      mockBuildParsedJDContext.mockReturnValue('BUILT_FROM_MONGO')

      const result = await getOrLoadJDContext('sess-b', 'raw JD text')
      expect(result).toBe('BUILT_FROM_MONGO')
      expect(mockBuildParsedJDContext).toHaveBeenCalledOnce()
      expect(mockRedisSetex).toHaveBeenCalledWith(
        'jd:ctx:sess-b',
        expect.any(Number),
        'BUILT_FROM_MONGO',
      )
      // No background parse kicked off — we have usable data already.
      expect(mockParseJobDescription).not.toHaveBeenCalled()
    })

    it('returns null and kicks off fire-and-forget parse when both miss', async () => {
      mockRedisGet.mockResolvedValue(null)
      mockFindById.mockReturnValue(makeLeanQuery({ parsedJobDescription: null }))
      mockParseJobDescription.mockResolvedValue({
        requirements: [{ id: 'r1', requirement: 'PM', importance: 'must-have', category: 'experience', targetCompetencies: [] }],
      })
      mockBuildParsedJDContext.mockReturnValue('PARSED_CTX')
      mockFindByIdAndUpdate.mockResolvedValue(undefined)

      const result = await getOrLoadJDContext('sess-c', 'raw JD text')
      expect(result).toBeNull()

      await flushMicrotasks()
      // Background parse must have been invoked for next time.
      expect(mockParseJobDescription).toHaveBeenCalledWith('raw JD text')
    })

    it('returns null (no background parse) when raw text is empty', async () => {
      mockRedisGet.mockResolvedValue(null)
      mockFindById.mockReturnValue(makeLeanQuery({ parsedJobDescription: null }))

      const result = await getOrLoadJDContext('sess-d', '')
      expect(result).toBeNull()
      await flushMicrotasks()
      expect(mockParseJobDescription).not.toHaveBeenCalled()
    })
  })

  describe('getOrLoadResumeContext', () => {
    it('returns cached value on Redis hit', async () => {
      mockRedisGet.mockResolvedValue('CACHED_RESUME_CONTEXT')
      const result = await getOrLoadResumeContext('sess-e', 'raw resume', 'pm')
      expect(result).toBe('CACHED_RESUME_CONTEXT')
      expect(mockFindById).not.toHaveBeenCalled()
    })

    it('falls back to Mongo when Redis misses, re-warms cache', async () => {
      mockRedisGet.mockResolvedValue(null)
      mockFindById.mockReturnValue(
        makeLeanQuery({
          parsedResume: {
            experience: [{ id: 'exp-1', company: 'Acme', title: 'PM', bullets: [] }],
            skills: [],
            education: [],
            projects: [],
          },
        }),
      )
      mockBuildParsedResumeContext.mockReturnValue('BUILT_FROM_MONGO_RESUME')

      const result = await getOrLoadResumeContext('sess-f', 'raw resume', 'pm')
      expect(result).toBe('BUILT_FROM_MONGO_RESUME')
      expect(mockRedisSetex).toHaveBeenCalledWith(
        'resume:ctx:sess-f',
        expect.any(Number),
        'BUILT_FROM_MONGO_RESUME',
      )
      expect(mockParseAndCacheResume).not.toHaveBeenCalled()
    })

    it('returns null and kicks off fire-and-forget parse when both miss', async () => {
      mockRedisGet.mockResolvedValue(null)
      mockFindById.mockReturnValue(makeLeanQuery({ parsedResume: null }))
      mockParseAndCacheResume.mockResolvedValue({
        experience: [{ id: 'exp-1', company: 'Acme', title: 'PM', bullets: [] }],
        skills: [],
        education: [],
        projects: [],
      })
      mockBuildParsedResumeContext.mockReturnValue('PARSED_RESUME_CTX')
      mockFindByIdAndUpdate.mockResolvedValue(undefined)

      const result = await getOrLoadResumeContext('sess-g', 'raw resume', 'pm')
      expect(result).toBeNull()

      await flushMicrotasks()
      expect(mockParseAndCacheResume).toHaveBeenCalledWith('sess-g', 'raw resume', 'pm')
    })
  })

  describe('setCachedJDContext / setCachedResumeContext', () => {
    it('skips empty context strings', async () => {
      await setCachedJDContext('sess-h', '')
      await setCachedResumeContext('sess-h', '')
      expect(mockRedisSetex).not.toHaveBeenCalled()
    })

    it('writes with 30-min TTL', async () => {
      await setCachedJDContext('sess-i', 'hello')
      expect(mockRedisSetex).toHaveBeenCalledWith('jd:ctx:sess-i', 1800, 'hello')
    })

    it('swallows Redis errors', async () => {
      mockRedisSetex.mockRejectedValueOnce(new Error('redis down'))
      await expect(setCachedJDContext('sess-j', 'hello')).resolves.toBeUndefined()
    })
  })

  describe('getOrLoadJDContext — negative cache', () => {
    it('returns null and skips re-parse when a recent failure is cached', async () => {
      mockRedisGet.mockResolvedValue('__jd_parse_failed__')
      mockFindById.mockReturnValue(makeLeanQuery({ parsedJobDescription: null }))

      const result = await getOrLoadJDContext('sess-fail', 'raw JD text')
      expect(result).toBeNull()
      await flushMicrotasks()
      expect(mockParseJobDescription).not.toHaveBeenCalled()
    })

    it('prefers a valid Mongo doc even when Redis has a failure sentinel', async () => {
      mockRedisGet.mockResolvedValue('__jd_parse_failed__')
      mockFindById.mockReturnValue(
        makeLeanQuery({
          parsedJobDescription: {
            requirements: [
              {
                id: 'r1',
                requirement: 'PM',
                importance: 'must-have',
                category: 'experience',
                targetCompetencies: [],
              },
            ],
          },
        }),
      )
      mockBuildParsedJDContext.mockReturnValue('FROM_MONGO')

      const result = await getOrLoadJDContext('sess-mongo-wins', 'raw JD text')
      expect(result).toBe('FROM_MONGO')
      expect(mockRedisSetex).toHaveBeenCalledWith('jd:ctx:sess-mongo-wins', 1800, 'FROM_MONGO')
      await flushMicrotasks()
      expect(mockParseJobDescription).not.toHaveBeenCalled()
    })

    it('writes failure sentinel with 120s TTL when parse returns empty requirements', async () => {
      mockRedisGet.mockResolvedValue(null)
      mockFindById.mockReturnValue(makeLeanQuery({ parsedJobDescription: null }))
      mockParseJobDescription.mockResolvedValue({
        requirements: [],
        company: '',
        role: '',
        inferredDomain: '',
        keyThemes: [],
      })

      await getOrLoadJDContext('sess-empty', 'raw JD text')
      await flushMicrotasks()
      expect(mockRedisSetex).toHaveBeenCalledWith('jd:ctx:sess-empty', 120, '__jd_parse_failed__')
    })

    it('writes failure sentinel when parse throws', async () => {
      mockRedisGet.mockResolvedValue(null)
      mockFindById.mockReturnValue(makeLeanQuery({ parsedJobDescription: null }))
      mockParseJobDescription.mockRejectedValue(new Error('parse exploded'))

      await getOrLoadJDContext('sess-throw', 'raw JD text')
      await flushMicrotasks()
      expect(mockRedisSetex).toHaveBeenCalledWith('jd:ctx:sess-throw', 120, '__jd_parse_failed__')
    })

    it('getCachedJDContext hides sentinel from external callers', async () => {
      mockRedisGet.mockResolvedValue('__jd_parse_failed__')
      const result = await getCachedJDContext('sess-hidden')
      expect(result).toBeNull()
    })

    it('setCachedJDContext refuses to write the sentinel as content', async () => {
      await setCachedJDContext('sess-defense', '__jd_parse_failed__')
      expect(mockRedisSetex).not.toHaveBeenCalled()
    })
  })
})
