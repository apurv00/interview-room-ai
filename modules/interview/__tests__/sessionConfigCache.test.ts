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

const mockInterviewDomainFindOne = vi.fn()
const mockInterviewDepthFindOne = vi.fn()
const mockEvaluationRubricFindOne = vi.fn()
const mockUserFindById = vi.fn()

function makeLeanQuery(returnValue: unknown) {
  return {
    sort: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(returnValue),
    }),
    lean: vi.fn().mockResolvedValue(returnValue),
    select: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(returnValue),
    }),
  }
}

vi.mock('@shared/db/models', () => ({
  InterviewDomain: {
    findOne: (...args: unknown[]) => mockInterviewDomainFindOne(...args),
  },
  InterviewDepth: {
    findOne: (...args: unknown[]) => mockInterviewDepthFindOne(...args),
  },
  EvaluationRubric: {
    findOne: (...args: unknown[]) => mockEvaluationRubricFindOne(...args),
  },
  User: {
    findById: (...args: unknown[]) => mockUserFindById(...args),
  },
}))

vi.mock('@shared/featureFlags', () => ({
  isFeatureEnabled: vi.fn((flag: string) => flag !== 'rubric_registry'),  // disable rubric by default
}))

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { getOrLoadSessionConfig } from '@interview/services/core/sessionConfigCache'
import { isFeatureEnabled } from '@shared/featureFlags'

// ─── Helpers ────────────────────────────────────────────────────────────────

const OPTS = {
  role: 'pm',
  interviewType: 'behavioral',
  userId: 'user-123',
  experience: '3-6',
}

const DOMAIN_DOC = { label: 'Product Manager', systemPromptContext: 'Focus on roadmap...' }
const DEPTH_DOC = { questionStrategy: 'Use STAR method', evaluationCriteria: 'Judge specificity' }
const PROFILE_DOC = { currentTitle: 'PM', isCareerSwitcher: false }

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('sessionConfigCache', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: session_config_cache enabled, rubric_registry disabled
    vi.mocked(isFeatureEnabled).mockImplementation(
      (flag: string) => flag === 'session_config_cache',
    )
  })

  describe('getOrLoadSessionConfig', () => {
    it('returns empty config when session_config_cache flag is off', async () => {
      vi.mocked(isFeatureEnabled).mockReturnValue(false)

      const result = await getOrLoadSessionConfig('sess-1', OPTS)

      expect(result.domain).toBeNull()
      expect(result.depth).toBeNull()
      expect(result.rubric).toBeNull()
      expect(result.userProfile).toBeNull()
      expect(mockRedisGet).not.toHaveBeenCalled()
    })

    it('returns cached config on Redis hit', async () => {
      const cached = {
        domain: DOMAIN_DOC,
        depth: DEPTH_DOC,
        rubric: null,
        userProfile: PROFILE_DOC,
      }
      mockRedisGet.mockResolvedValue(JSON.stringify(cached))

      const result = await getOrLoadSessionConfig('sess-2', OPTS)

      expect(result.domain).toEqual(DOMAIN_DOC)
      expect(result.depth).toEqual(DEPTH_DOC)
      expect(result.userProfile).toEqual(PROFILE_DOC)
      // Should not hit Mongo
      expect(mockInterviewDomainFindOne).not.toHaveBeenCalled()
      expect(mockUserFindById).not.toHaveBeenCalled()
    })

    it('fetches from Mongo on Redis miss, warms cache', async () => {
      mockRedisGet.mockResolvedValue(null)
      mockInterviewDomainFindOne.mockReturnValue(makeLeanQuery(DOMAIN_DOC))
      mockInterviewDepthFindOne.mockReturnValue(makeLeanQuery(DEPTH_DOC))
      mockUserFindById.mockReturnValue(makeLeanQuery(PROFILE_DOC))

      const result = await getOrLoadSessionConfig('sess-3', OPTS)

      expect(result.domain).toEqual(DOMAIN_DOC)
      expect(result.depth).toEqual(DEPTH_DOC)
      expect(result.userProfile).toEqual(PROFILE_DOC)
      // Should have cached the result
      expect(mockRedisSetex).toHaveBeenCalledWith(
        'session:cfg:sess-3',
        expect.any(Number),
        expect.any(String),
      )
      // Rubric should be null (flag disabled)
      expect(result.rubric).toBeNull()
    })

    it('fetches rubric when rubric_registry flag is enabled', async () => {
      vi.mocked(isFeatureEnabled).mockImplementation(
        (flag: string) => flag === 'session_config_cache' || flag === 'rubric_registry',
      )
      mockRedisGet.mockResolvedValue(null)
      mockInterviewDomainFindOne.mockReturnValue(makeLeanQuery(DOMAIN_DOC))
      mockInterviewDepthFindOne.mockReturnValue(makeLeanQuery(DEPTH_DOC))
      mockUserFindById.mockReturnValue(makeLeanQuery(PROFILE_DOC))
      const rubricDoc = { dimensions: [{ name: 'relevance', label: 'Relevance', weight: 0.25, description: '', scoringGuide: {} }] }
      mockEvaluationRubricFindOne.mockReturnValue(makeLeanQuery(rubricDoc))

      const result = await getOrLoadSessionConfig('sess-4', OPTS)

      expect(mockEvaluationRubricFindOne).toHaveBeenCalledOnce()
      expect(result.rubric).toEqual(rubricDoc)
    })

    it('returns empty config on Mongo failure (fail-open)', async () => {
      mockRedisGet.mockResolvedValue(null)
      mockInterviewDomainFindOne.mockReturnValue({
        lean: vi.fn().mockRejectedValue(new Error('DB down')),
      })
      mockInterviewDepthFindOne.mockReturnValue({
        lean: vi.fn().mockRejectedValue(new Error('DB down')),
      })
      mockUserFindById.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockRejectedValue(new Error('DB down')),
        }),
      })

      const result = await getOrLoadSessionConfig('sess-5', OPTS)

      expect(result.domain).toBeNull()
      expect(result.depth).toBeNull()
      expect(result.userProfile).toBeNull()
      // No Redis write on failure
      expect(mockRedisSetex).not.toHaveBeenCalled()
    })

    it('proceeds normally when Redis write fails after Mongo fetch', async () => {
      mockRedisGet.mockResolvedValue(null)
      mockInterviewDomainFindOne.mockReturnValue(makeLeanQuery(DOMAIN_DOC))
      mockInterviewDepthFindOne.mockReturnValue(makeLeanQuery(DEPTH_DOC))
      mockUserFindById.mockReturnValue(makeLeanQuery(PROFILE_DOC))
      mockRedisSetex.mockRejectedValue(new Error('redis down'))

      const result = await getOrLoadSessionConfig('sess-6', OPTS)

      // Should still return the fetched data despite Redis write failure
      expect(result.domain).toEqual(DOMAIN_DOC)
      expect(result.depth).toEqual(DEPTH_DOC)
    })

    it('returns partial config when only some Mongo queries fail', async () => {
      mockRedisGet.mockResolvedValue(null)
      // Domain succeeds, depth fails, user fails
      mockInterviewDomainFindOne.mockReturnValue(makeLeanQuery(DOMAIN_DOC))
      mockInterviewDepthFindOne.mockReturnValue({
        lean: vi.fn().mockRejectedValue(new Error('timeout')),
      })
      mockUserFindById.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockRejectedValue(new Error('timeout')),
        }),
      })

      const result = await getOrLoadSessionConfig('sess-7', OPTS)

      // Domain was fetched, depth and profile were not
      expect(result.domain).toEqual(DOMAIN_DOC)
      expect(result.depth).toBeNull()
      expect(result.userProfile).toBeNull()
    })
  })
})
