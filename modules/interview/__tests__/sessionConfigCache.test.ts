import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockRedisGet = vi.fn()
const mockRedisSetex = vi.fn()
// PR B: EXPIRE is called fire-and-forget on every Redis hit to extend
// the TTL — keeps long-running interviews warm past the default 30-min
// window. Mock returns 1 (success) by default; tests that need to
// simulate an EXPIRE failure override per-call.
const mockRedisExpire = vi.fn().mockResolvedValue(1)

vi.mock('@shared/redis', () => ({
  redis: {
    get: (...args: unknown[]) => mockRedisGet(...args),
    setex: (...args: unknown[]) => mockRedisSetex(...args),
    expire: (...args: unknown[]) => mockRedisExpire(...args),
  },
}))

const mockLoggerInfo = vi.fn()
const mockLoggerWarn = vi.fn()

vi.mock('@shared/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    info: (...args: unknown[]) => mockLoggerInfo(...args),
  },
}))

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

const mockInterviewDomainFindOne = vi.fn()
const mockInterviewDepthFindOne = vi.fn()
const mockEvaluationRubricFindOne = vi.fn()
const mockUserFindById = vi.fn()
const mockInterviewSessionFindById = vi.fn()

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
  InterviewSession: {
    findById: (...args: unknown[]) => mockInterviewSessionFindById(...args),
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
    // Default: InterviewSession.findById returns no JD. Tests that need a
    // parsed JD (or a rejection) override this before calling.
    mockInterviewSessionFindById.mockReturnValue(makeLeanQuery(null))
    // Default EXPIRE returns 1 (success); `vi.clearAllMocks` reset the
    // per-instance impl so restore the default success path explicitly.
    mockRedisExpire.mockResolvedValue(1)
  })

  function findSessionConfigLoadLog() {
    return mockLoggerInfo.mock.calls
      .map(([payload]) => payload as { event?: string })
      .find((p) => p?.event === 'session_config_load')
  }

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

  // ── PR B: TTL refresh + miss observability ────────────────────────────────
  //
  // Problem PR B solves: session config cache had a 30-min TTL but NO
  // refresh on access. An interview running >30 min would see its cache
  // expire mid-flow, forcing a Mongo fallthrough on every subsequent Q.
  // Additionally, the hit/miss path was silent — no log, no way to tell
  // from Vercel whether the cache was actually serving traffic or being
  // circumvented.
  //
  // These tests pin the two contracts ops will depend on.

  describe('PR B — TTL refresh', () => {
    it('refreshes Redis TTL on cache hit (fire-and-forget EXPIRE)', async () => {
      // Cache hit → EXPIRE must fire with 1800s so a long interview
      // resets the 30-min window on every Q-turn access. Without this,
      // interviews past the initial TTL start paying Mongo cost again.
      const cached = {
        domain: DOMAIN_DOC,
        depth: DEPTH_DOC,
        rubric: null,
        userProfile: PROFILE_DOC,
        parsedJD: null,
      }
      mockRedisGet.mockResolvedValue(JSON.stringify(cached))

      await getOrLoadSessionConfig('sess-ttl-hit', OPTS)

      expect(mockRedisExpire).toHaveBeenCalledWith('session:cfg:sess-ttl-hit', 1800)
    })

    it('does NOT call EXPIRE on cache miss (SETEX sets the fresh TTL)', async () => {
      // On miss, setex() writes the fresh key WITH its own TTL — calling
      // EXPIRE on top would be redundant. The hit path is where EXPIRE
      // earns its keep.
      mockRedisGet.mockResolvedValue(null)
      mockInterviewDomainFindOne.mockReturnValue(makeLeanQuery(DOMAIN_DOC))
      mockInterviewDepthFindOne.mockReturnValue(makeLeanQuery(DEPTH_DOC))
      mockUserFindById.mockReturnValue(makeLeanQuery(PROFILE_DOC))

      await getOrLoadSessionConfig('sess-ttl-miss', OPTS)

      expect(mockRedisExpire).not.toHaveBeenCalled()
      expect(mockRedisSetex).toHaveBeenCalled()
    })

    it('TTL refresh EXPIRE failure does NOT propagate to caller', async () => {
      // Redis EXPIRE is fire-and-forget. A failure must never surface —
      // the candidate's answer gets scored regardless of cache health.
      const cached = {
        domain: DOMAIN_DOC,
        depth: DEPTH_DOC,
        rubric: null,
        userProfile: PROFILE_DOC,
        parsedJD: null,
      }
      mockRedisGet.mockResolvedValue(JSON.stringify(cached))
      mockRedisExpire.mockRejectedValueOnce(new Error('redis down'))

      const result = await getOrLoadSessionConfig('sess-ttl-fail', OPTS)

      // Caller sees the cached value unchanged despite EXPIRE failure.
      expect(result.domain).toEqual(DOMAIN_DOC)
      // Drain any pending promise rejections so the test doesn't leak.
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  })

  describe('PR B — session_config_load telemetry', () => {
    // These tests pin the EXACT shape Vercel log searches will pivot on
    // to answer "is the session cache actually serving my traffic?".
    // If a future refactor silently drops source/durationMs/event, the
    // dashboard breaks and we lose observability.

    it('logs source=redis-hit on cache hit', async () => {
      const cached = {
        domain: DOMAIN_DOC,
        depth: DEPTH_DOC,
        rubric: null,
        userProfile: PROFILE_DOC,
        parsedJD: null,
      }
      mockRedisGet.mockResolvedValue(JSON.stringify(cached))

      await getOrLoadSessionConfig('sess-log-hit', OPTS)

      const log = findSessionConfigLoadLog() as {
        event: string
        sessionId: string
        source: string
        durationMs: number
        ttlExtended: boolean
      }
      expect(log).toBeDefined()
      expect(log.event).toBe('session_config_load')
      expect(log.source).toBe('redis-hit')
      expect(log.sessionId).toBe('sess-log-hit')
      expect(log.ttlExtended).toBe(true)
      expect(typeof log.durationMs).toBe('number')
      expect(log.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('logs source=mongo-hit on Redis miss + successful Mongo fetch', async () => {
      mockRedisGet.mockResolvedValue(null)
      mockInterviewDomainFindOne.mockReturnValue(makeLeanQuery(DOMAIN_DOC))
      mockInterviewDepthFindOne.mockReturnValue(makeLeanQuery(DEPTH_DOC))
      mockUserFindById.mockReturnValue(makeLeanQuery(PROFILE_DOC))

      await getOrLoadSessionConfig('sess-log-mongo', OPTS)

      const log = findSessionConfigLoadLog() as { source: string; sessionId: string }
      expect(log).toBeDefined()
      expect(log.source).toBe('mongo-hit')
      expect(log.sessionId).toBe('sess-log-mongo')
    })

    it('logs source=empty when Redis misses AND all 4 Mongo fetches return null', async () => {
      // Edge case: sessionId / role / userId combo that exists but has
      // no corresponding records. Distinct from mongo-error because
      // Mongo was reachable — we just got nothing back.
      mockRedisGet.mockResolvedValue(null)
      mockInterviewDomainFindOne.mockReturnValue(makeLeanQuery(null))
      mockInterviewDepthFindOne.mockReturnValue(makeLeanQuery(null))
      mockUserFindById.mockReturnValue(makeLeanQuery(null))

      await getOrLoadSessionConfig('sess-log-empty', OPTS)

      const log = findSessionConfigLoadLog() as { source: string }
      expect(log.source).toBe('empty')
    })

    it('logs source=redis-error when Redis read throws but Mongo succeeds', async () => {
      // Redis outage degrades the route to always-Mongo for this
      // request. Ops need to distinguish this from a clean first-Q
      // cache miss.
      mockRedisGet.mockRejectedValueOnce(new Error('ECONNREFUSED'))
      mockInterviewDomainFindOne.mockReturnValue(makeLeanQuery(DOMAIN_DOC))
      mockInterviewDepthFindOne.mockReturnValue(makeLeanQuery(DEPTH_DOC))
      mockUserFindById.mockReturnValue(makeLeanQuery(PROFILE_DOC))

      await getOrLoadSessionConfig('sess-log-redis-err', OPTS)

      const log = findSessionConfigLoadLog() as { source: string }
      expect(log.source).toBe('redis-error')
    })

    it('logs source=mongo-error when Redis misses AND connectDB throws', async () => {
      mockRedisGet.mockResolvedValue(null)
      // connectDB is mocked to resolve by default — override to reject.
      const mod = await import('@shared/db/connection')
      vi.mocked(mod.connectDB).mockRejectedValueOnce(new Error('mongo unreachable'))

      await getOrLoadSessionConfig('sess-log-mongo-err', OPTS)

      const log = findSessionConfigLoadLog() as { source: string }
      expect(log.source).toBe('mongo-error')
    })

    it('logs source=feature-off when session_config_cache flag is disabled', async () => {
      vi.mocked(isFeatureEnabled).mockReturnValue(false)

      await getOrLoadSessionConfig('sess-log-off', OPTS)

      const log = findSessionConfigLoadLog() as { source: string }
      expect(log.source).toBe('feature-off')
    })

    it('logs source=mongo-hit when ONLY rubric returns from Mongo (core fields null) (Codex P2 #304)', async () => {
      // Rubric supports wildcard matches (domain:'*', interviewType:'*'),
      // so it can legitimately return data even when the specific
      // domain/depth lookups miss for this session's slug/type. Codex
      // flagged: the old classifier used `hasData` which excluded
      // rubric AND parsedJD — this combo would log `empty` even though
      // Mongo DID return a usable rubric.
      vi.mocked(isFeatureEnabled).mockImplementation(
        (flag: string) => flag === 'session_config_cache' || flag === 'rubric_registry',
      )
      mockRedisGet.mockResolvedValue(null)
      // Core fields all null
      mockInterviewDomainFindOne.mockReturnValue(makeLeanQuery(null))
      mockInterviewDepthFindOne.mockReturnValue(makeLeanQuery(null))
      mockUserFindById.mockReturnValue(makeLeanQuery(null))
      // Rubric returns via wildcard
      mockEvaluationRubricFindOne.mockReturnValue(
        makeLeanQuery({ dimensions: [{ name: 'relevance', label: 'Relevance', weight: 0.25 }] }),
      )

      await getOrLoadSessionConfig('sess-rubric-only', OPTS)

      const log = findSessionConfigLoadLog() as { source: string }
      expect(log.source).toBe('mongo-hit')
      expect(log.source).not.toBe('empty')
    })

    it('logs source=mongo-hit when ONLY parsedJD returns from Mongo (core fields null) (Codex P2 #304)', async () => {
      // Same bug class as the rubric-only case: a session with a JD
      // but no matching domain/depth/user lookups would log `empty`.
      mockRedisGet.mockResolvedValue(null)
      mockInterviewDomainFindOne.mockReturnValue(makeLeanQuery(null))
      mockInterviewDepthFindOne.mockReturnValue(makeLeanQuery(null))
      mockUserFindById.mockReturnValue(makeLeanQuery(null))
      mockInterviewSessionFindById.mockReturnValue(
        makeLeanQuery({
          parsedJobDescription: {
            rawText: 'PM at Acme',
            company: 'Acme',
            role: 'PM',
            inferredDomain: 'pm',
            requirements: [],
            keyThemes: [],
          },
        }),
      )

      await getOrLoadSessionConfig('sess-jd-only', OPTS)

      const log = findSessionConfigLoadLog() as { source: string }
      expect(log.source).toBe('mongo-hit')
      expect(log.source).not.toBe('empty')
    })

    it('corrupted cache value: emits source=redis-error ONLY, NOT redis-hit (Codex P2 on PR #304)', async () => {
      // A malformed cached JSON must NOT produce a `redis-hit` log.
      // Earlier impl logged redis-hit BEFORE JSON.parse — so a corrupt
      // value would emit redis-hit + then fall through and also emit
      // the Mongo-fallback log, producing contradictory telemetry that
      // breaks the dashboard during the exact failure mode we need to
      // diagnose. Fix: parse first; log only on successful parse.
      mockRedisGet.mockResolvedValue('{ this is not valid json')
      // Mongo fallback path succeeds (so the subsequent log fires).
      mockInterviewDomainFindOne.mockReturnValue(makeLeanQuery(DOMAIN_DOC))
      mockInterviewDepthFindOne.mockReturnValue(makeLeanQuery(DEPTH_DOC))
      mockUserFindById.mockReturnValue(makeLeanQuery(PROFILE_DOC))

      await getOrLoadSessionConfig('sess-log-corrupt', OPTS)

      // Collect all session_config_load logs produced by this call.
      const loadLogs = mockLoggerInfo.mock.calls
        .map(([payload]) => payload as { event?: string; source?: string })
        .filter((p) => p?.event === 'session_config_load')

      // Exactly one log per call — that's the contract. Multiple logs
      // for one call was the bug.
      expect(loadLogs).toHaveLength(1)
      // The sole log must NOT be redis-hit (which would falsely claim
      // the cache served this request). It should be redis-error —
      // the corrupted value is semantically a Redis read failure.
      expect(loadLogs[0].source).not.toBe('redis-hit')
      expect(loadLogs[0].source).toBe('redis-error')
    })
  })

  describe('parsedJD surfacing (Phase 1 of JD overlay wiring)', () => {
    const PARSED_JD = {
      rawText: 'Senior Engineer at Acme...',
      company: 'Acme',
      role: 'Senior Engineer',
      inferredDomain: 'backend',
      requirements: [
        {
          id: 'r1',
          category: 'technical',
          requirement: 'Own incident response rotation',
          importance: 'must-have',
          targetCompetencies: [],
        },
      ],
      keyThemes: ['reliability'],
    }

    it('parsedJD is null in EMPTY_CONFIG when session_config_cache flag is off', async () => {
      vi.mocked(isFeatureEnabled).mockReturnValue(false)

      const result = await getOrLoadSessionConfig('sess-jd-1', OPTS)

      expect(result.parsedJD).toBeNull()
      // Mongo should never have been touched
      expect(mockInterviewSessionFindById).not.toHaveBeenCalled()
    })

    it('parsedJD is populated when Mongo returns a session with parsedJobDescription', async () => {
      mockRedisGet.mockResolvedValue(null)
      mockInterviewDomainFindOne.mockReturnValue(makeLeanQuery(DOMAIN_DOC))
      mockInterviewDepthFindOne.mockReturnValue(makeLeanQuery(DEPTH_DOC))
      mockUserFindById.mockReturnValue(makeLeanQuery(PROFILE_DOC))
      mockInterviewSessionFindById.mockReturnValue(
        makeLeanQuery({ parsedJobDescription: PARSED_JD }),
      )

      const result = await getOrLoadSessionConfig('sess-jd-2', OPTS)

      expect(result.parsedJD).toEqual(PARSED_JD)
      expect(mockInterviewSessionFindById).toHaveBeenCalledWith('sess-jd-2')
    })

    it('parsedJD is null when Mongo returns a session without parsedJobDescription', async () => {
      mockRedisGet.mockResolvedValue(null)
      mockInterviewDomainFindOne.mockReturnValue(makeLeanQuery(DOMAIN_DOC))
      mockInterviewDepthFindOne.mockReturnValue(makeLeanQuery(DEPTH_DOC))
      mockUserFindById.mockReturnValue(makeLeanQuery(PROFILE_DOC))
      // Session exists but has no JD attached yet (fire-and-forget parse
      // still running, or session was created without a JD at all).
      mockInterviewSessionFindById.mockReturnValue(makeLeanQuery({}))

      const result = await getOrLoadSessionConfig('sess-jd-3', OPTS)

      expect(result.parsedJD).toBeNull()
      // Core fields still populated — JD absence should not affect them
      expect(result.domain).toEqual(DOMAIN_DOC)
    })

    it('parsedJD is null when InterviewSession.findById rejects (allSettled semantics)', async () => {
      mockRedisGet.mockResolvedValue(null)
      mockInterviewDomainFindOne.mockReturnValue(makeLeanQuery(DOMAIN_DOC))
      mockInterviewDepthFindOne.mockReturnValue(makeLeanQuery(DEPTH_DOC))
      mockUserFindById.mockReturnValue(makeLeanQuery(PROFILE_DOC))
      mockInterviewSessionFindById.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockRejectedValue(new Error('mongo down for sessions')),
        }),
      })

      const result = await getOrLoadSessionConfig('sess-jd-4', OPTS)

      // JD query failure must not tank the other 4 results
      expect(result.parsedJD).toBeNull()
      expect(result.domain).toEqual(DOMAIN_DOC)
      expect(result.depth).toEqual(DEPTH_DOC)
      expect(result.userProfile).toEqual(PROFILE_DOC)
    })

    it('Redis cache includes parsedJD and returns it on subsequent calls', async () => {
      // First call: Mongo miss → Mongo fetch → Redis write
      mockRedisGet.mockResolvedValueOnce(null)
      mockInterviewDomainFindOne.mockReturnValue(makeLeanQuery(DOMAIN_DOC))
      mockInterviewDepthFindOne.mockReturnValue(makeLeanQuery(DEPTH_DOC))
      mockUserFindById.mockReturnValue(makeLeanQuery(PROFILE_DOC))
      mockInterviewSessionFindById.mockReturnValue(
        makeLeanQuery({ parsedJobDescription: PARSED_JD }),
      )

      const first = await getOrLoadSessionConfig('sess-jd-5', OPTS)
      expect(first.parsedJD).toEqual(PARSED_JD)

      // Verify the value written to Redis includes parsedJD
      expect(mockRedisSetex).toHaveBeenCalledTimes(1)
      const [, , serialized] = mockRedisSetex.mock.calls[0]
      const parsedCache = JSON.parse(serialized as string)
      expect(parsedCache.parsedJD).toEqual(PARSED_JD)

      // Second call: Redis hit → should return parsedJD from cache without
      // a second Mongo round trip
      mockRedisGet.mockResolvedValueOnce(serialized as string)
      mockInterviewSessionFindById.mockClear()
      const second = await getOrLoadSessionConfig('sess-jd-5', OPTS)
      expect(second.parsedJD).toEqual(PARSED_JD)
      expect(mockInterviewSessionFindById).not.toHaveBeenCalled()
    })
  })
})
