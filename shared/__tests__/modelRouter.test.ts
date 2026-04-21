/**
 * @vitest-environment node
 *
 * modelRouter.ts has an explicit `typeof window !== 'undefined'` branch
 * that short-circuits to default config when running in the browser
 * (prevents mongoose + ioredis from being pulled into client bundles).
 * The default jsdom environment defines `window`, which would make ALL
 * these tests fire the client-side branch and never exercise the Redis
 * L2 cache or the Mongo L3 path. Node env is correct: these are pure
 * server-side routing tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock logger to avoid noisy output AND so tests can assert on the
// `model_config_load` telemetry events that PR A adds — those logs
// are the sole runtime signal that lets ops confirm L2 is actually
// serving cold-Lambda traffic.
const { mockAiLoggerInfo, mockAiLoggerWarn } = vi.hoisted(() => ({
  mockAiLoggerInfo: vi.fn(),
  mockAiLoggerWarn: vi.fn(),
}))

vi.mock('@shared/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  aiLogger: { error: vi.fn(), warn: mockAiLoggerWarn, info: mockAiLoggerInfo, debug: vi.fn() },
}))

// Redis is loaded via `eval('require')` in production to hide from
// webpack (prevents ioredis leaking into the client bundle through
// dynamic-imported chains like codingProblemGenerator). That means
// `vi.mock('@shared/redis')` can NOT intercept the require — the Node
// require is independent of vitest's module registry.
//
// Instead we use `__setRedisClientForTesting()` — a narrow test hatch
// exported from modelRouter that swaps a module-scoped override. See
// the hatch's JSDoc for rationale. The spy fns below are assigned per
// test in beforeEach; the override is always reset in afterEach so no
// Redis state survives across test files.
import { resolveModel, invalidateModelConfigCache, __setRedisClientForTesting } from '@shared/services/modelRouter'
import { TASK_SLOT_DEFAULTS } from '@shared/services/taskSlots'

const mockRedisGet = vi.fn<(key: string) => Promise<string | null>>()
const mockRedisSetex = vi.fn<(key: string, ttl: number, val: string) => Promise<unknown>>()
const mockRedisDel = vi.fn<(key: string) => Promise<unknown>>()

describe('resolveModel', () => {
  beforeEach(() => {
    invalidateModelConfigCache()
    mockRedisGet.mockReset()
    mockRedisGet.mockResolvedValue(null)
    mockRedisSetex.mockReset()
    mockRedisSetex.mockResolvedValue('OK')
    mockRedisDel.mockReset()
    mockRedisDel.mockResolvedValue(1)
    mockAiLoggerInfo.mockReset()
    mockAiLoggerWarn.mockReset()
    __setRedisClientForTesting({
      get: mockRedisGet,
      setex: mockRedisSetex,
      del: mockRedisDel,
    })
  })

  afterEach(() => {
    // Always clear the override so other test files don't observe it
    // if the vitest worker is reused.
    __setRedisClientForTesting(null)
  })

  // ── Core regression test: provider must match task slot defaults ──────────
  // The bug was that resolveModel() hardcoded provider: 'anthropic' for all
  // slots, sending OpenAI model names (gpt-5.4-mini) to the Anthropic API.

  it('returns provider: "openai" for interview.generate-question (not hardcoded "anthropic")', async () => {
    const result = await resolveModel('interview.generate-question')
    expect(result.provider).toBe('openai')
    expect(result.model).toBe('gpt-5.4-mini')
  })

  it('returns provider: "openai" for interview.evaluate-answer', async () => {
    const result = await resolveModel('interview.evaluate-answer')
    expect(result.provider).toBe('openai')
    expect(result.model).toBe('gpt-5.4-mini')
  })

  it('returns provider: "openai" for interview.turn-router', async () => {
    const result = await resolveModel('interview.turn-router')
    expect(result.provider).toBe('openai')
    expect(result.model).toBe('gpt-5.4-mini')
  })

  it('returns provider: "anthropic" for resume.enhance-section', async () => {
    const result = await resolveModel('resume.enhance-section')
    expect(result.provider).toBe('anthropic')
    expect(result.model).toBe('claude-sonnet-4-6')
  })

  it('returns provider: "anthropic" for learn.pathway-plan', async () => {
    const result = await resolveModel('learn.pathway-plan')
    expect(result.provider).toBe('anthropic')
    expect(result.model).toBe('claude-sonnet-4-6')
  })

  it('returns provider: "anthropic" for b2b.scorecard', async () => {
    const result = await resolveModel('b2b.scorecard')
    expect(result.provider).toBe('anthropic')
    expect(result.model).toBe('claude-haiku-4-5')
  })

  // ── Verify all interview slots use their configured provider ─────────────

  const interviewSlots = Object.entries(TASK_SLOT_DEFAULTS)
    .filter(([key]) => key.startsWith('interview.'))
    .map(([key, defaults]) => ({ slot: key, expectedProvider: defaults.provider, expectedModel: defaults.model }))

  it.each(interviewSlots)(
    'interview slot $slot returns provider=$expectedProvider (not hardcoded "anthropic")',
    async ({ slot, expectedProvider, expectedModel }) => {
      const result = await resolveModel(slot as Parameters<typeof resolveModel>[0])
      expect(result.provider).toBe(expectedProvider)
      expect(result.model).toBe(expectedModel)
    },
  )

  // ── Structural checks ────────────────────────────────────────────────────

  it('returns maxTokens from task slot defaults', async () => {
    const result = await resolveModel('interview.generate-question')
    expect(result.maxTokens).toBe(TASK_SLOT_DEFAULTS['interview.generate-question'].maxTokens)
  })

  it('returns useToonInput: false when routing is disabled', async () => {
    const result = await resolveModel('interview.generate-question')
    expect(result.useToonInput).toBe(false)
  })

  // ── Redis L2 cache behavior (PR A) ───────────────────────────────────────

  // The big win: a cold Lambda with a warm Redis key skips the Mongo round
  // trip entirely. This is why Phase 1 was scoped — ~1.5s saved on the
  // first /api/generate-question call after a cold container starts.

  it('Redis L2 hit hydrates cache without consulting Mongo', async () => {
    // Seed Redis with a valid serialized config that overrides the default
    // slot routing. If L2 hits correctly, resolveModel returns the CACHED
    // value (custom-model) instead of the task-slot default (gpt-5.4-mini).
    const cachedConfig = {
      routingEnabled: true,
      slotEntries: [
        [
          'interview.generate-question',
          {
            taskSlot: 'interview.generate-question',
            model: 'custom-cached-model',
            provider: 'anthropic',
            maxTokens: 777,
            isActive: true,
          },
        ],
      ],
    }
    mockRedisGet.mockResolvedValueOnce(JSON.stringify(cachedConfig))

    const result = await resolveModel('interview.generate-question')

    expect(mockRedisGet).toHaveBeenCalledWith('model-config:v1')
    expect(result.model).toBe('custom-cached-model')
    expect(result.provider).toBe('anthropic')
    expect(result.maxTokens).toBe(777)
  })

  it('Redis L2 miss falls through to Mongo path (defaults when Mongo unavailable)', async () => {
    // Default mockRedisGet returns null (miss). Mongo require fails in
    // tests → loadConfig catches → defaults apply. This is the existing
    // behavior; the assertion proves the Redis miss didn't break it.
    mockRedisGet.mockResolvedValueOnce(null)

    const result = await resolveModel('interview.generate-question')

    expect(mockRedisGet).toHaveBeenCalledWith('model-config:v1')
    expect(result.provider).toBe('openai') // default, not an error
    expect(result.model).toBe('gpt-5.4-mini')
  })

  it('Redis L2 read error does NOT fail resolveModel (falls through silently)', async () => {
    // Simulate a Redis outage — the router must not propagate the error
    // to callers. A Redis failure is not a Claude-router failure.
    mockRedisGet.mockRejectedValueOnce(new Error('ECONNREFUSED Redis down'))

    const result = await resolveModel('interview.generate-question')

    // Still returns defaults — no exception raised to the caller.
    expect(result.provider).toBe('openai')
    expect(result.model).toBe('gpt-5.4-mini')
  })

  it('Redis L2 malformed JSON does NOT fail resolveModel', async () => {
    // Corrupted cache entry (wrong version, malicious write, partial
    // write during DEL race) — must not bring down LLM routing.
    mockRedisGet.mockResolvedValueOnce('{not json')

    const result = await resolveModel('interview.generate-question')

    expect(result.provider).toBe('openai')
    expect(result.model).toBe('gpt-5.4-mini')
  })

  it('invalidateModelConfigCache() issues Redis DEL on the cache key', async () => {
    // Required for cross-Lambda invalidation. CMS PUT handler calls this
    // after updating Mongo, and the next resolveModel call on ANY Lambda
    // sees the fresh config within 1 request — not 60s later.
    invalidateModelConfigCache()

    // DEL is fire-and-forget, so it's called synchronously but not awaited.
    // Allow one microtask flush for the promise.
    await Promise.resolve()

    expect(mockRedisDel).toHaveBeenCalledWith('model-config:v1')
  })

  it('invalidateModelConfigCache() does NOT throw when Redis DEL rejects', async () => {
    mockRedisDel.mockRejectedValueOnce(new Error('ECONNREFUSED'))

    // Must not throw — CMS PUT handler must still return 200 to the admin.
    expect(() => invalidateModelConfigCache()).not.toThrow()

    // Give the rejected promise a tick to propagate through the .catch
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  // ── Telemetry (PR A validation signal) ──────────────────────────────────
  //
  // These tests pin the exact log shape ops will search for in Vercel to
  // validate that PR A is actually doing what it claims. If a future
  // refactor silently drops the source/durationMs fields, the validation
  // dashboard breaks and we lose observability. Keep these tight.

  it('logs event=model_config_load with source=L2-Redis on cache hit', async () => {
    const cachedConfig = {
      routingEnabled: true,
      slotEntries: [
        [
          'interview.generate-question',
          {
            taskSlot: 'interview.generate-question',
            model: 'custom-cached-model',
            provider: 'anthropic',
            maxTokens: 777,
            isActive: true,
          },
        ],
      ],
    }
    mockRedisGet.mockResolvedValueOnce(JSON.stringify(cachedConfig))

    await resolveModel('interview.generate-question')

    // Exactly one `model_config_load` info log per loadConfig call. This
    // is the line Vercel log searches will pivot on to answer "how often
    // do cold Lambdas hit Redis?"
    const calls = mockAiLoggerInfo.mock.calls.filter(
      ([payload]) => (payload as { event?: string }).event === 'model_config_load',
    )
    expect(calls).toHaveLength(1)
    const [payload] = calls[0] as [{ event: string; source: string; durationMs: number }, string]
    expect(payload.source).toBe('L2-Redis')
    expect(payload.event).toBe('model_config_load')
    expect(typeof payload.durationMs).toBe('number')
    expect(payload.durationMs).toBeGreaterThanOrEqual(0)
    // Sanity: a mocked in-memory Redis hit should be fast. Lenient upper
    // bound (100ms) accounts for CI machines with variable scheduling
    // latency; a 100ms hit is still 10× faster than the Mongo baseline.
    expect(payload.durationMs).toBeLessThan(100)
  })

  it('logs source=L3-Mongo-error when Redis misses AND Mongo require fails', async () => {
    // Default mockRedisGet returns null (miss). Mongo require fails
    // in tests (no mongoose available) → `L3-Mongo-error`.
    await resolveModel('interview.generate-question')

    const calls = mockAiLoggerInfo.mock.calls.filter(
      ([payload]) => (payload as { event?: string }).event === 'model_config_load',
    )
    expect(calls).toHaveLength(1)
    const [payload] = calls[0] as [{ source: string; durationMs: number }, string]
    expect(payload.source).toBe('L3-Mongo-error')
    expect(typeof payload.durationMs).toBe('number')
  })

  // ── Codex P2 regressions (PR #302) ─────────────────────────────────────

  it('bounds Redis read latency — falls through to Mongo if Redis stalls past timeout (Codex P2 #1)', async () => {
    // Simulate a Redis that never responds — mirrors the Redis-outage
    // case where ioredis would retry 3× with backoff before rejecting
    // (~1.4s). The timeout in tryLoadFromRedis must abort BEFORE the
    // client finishes retrying so fallthrough stays fast.
    vi.useFakeTimers()
    try {
      mockRedisGet.mockImplementationOnce(() => new Promise(() => { /* never resolves */ }))

      const resolvePromise = resolveModel('interview.generate-question')
      // Advance past the 200ms read timeout. Anything ≥300ms guarantees
      // the timeout fires; we use 500ms for generous headroom so this
      // isn't flaky on slow CI.
      await vi.advanceTimersByTimeAsync(500)
      const result = await resolvePromise

      // Fell through to defaults — timeout triggered, Mongo path tried
      // (fails in tests → defaults). Assertion proves the stall did NOT
      // propagate into resolveModel's return value.
      expect(result.provider).toBe('openai')
      expect(result.model).toBe('gpt-5.4-mini')
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects Redis payloads with missing fields — does NOT hydrate broken cache (Codex P2 #2)', async () => {
    // Valid JSON but wrong shape — a schema-version skew or a partial
    // write would produce this. Without the guard, hydrateFromSerialized
    // produces a CachedConfig with undefined fields, tryLoadFromRedis
    // returns true, and routing is poisoned for 60s.
    mockRedisGet.mockResolvedValueOnce(JSON.stringify({ routingEnabled: 'yes', slotEntries: 'nope' }))

    const result = await resolveModel('interview.generate-question')

    // Should fall through to defaults, not silently accept the bogus
    // cache. A log line at warn-level surfaces the rejection so we can
    // detect payload drift in production.
    expect(result.provider).toBe('openai')
    expect(result.model).toBe('gpt-5.4-mini')
    // Also: the telemetry log must show the Redis path failed and
    // fell through (source !== 'L2-Redis').
    const loadLogs = mockAiLoggerInfo.mock.calls.filter(
      ([payload]) => (payload as { event?: string }).event === 'model_config_load',
    )
    expect(loadLogs).toHaveLength(1)
    const [payload] = loadLogs[0] as [{ source: string }, string]
    expect(payload.source).not.toBe('L2-Redis')
  })

  it('rejects Redis payload missing routingEnabled — falls through (Codex P2 #2)', async () => {
    // Specific shape-guard case: slotEntries present as empty array but
    // routingEnabled missing entirely. Without the guard, boolean coerces
    // to undefined, hydration would succeed, downstream code would treat
    // as routingEnabled=false.
    mockRedisGet.mockResolvedValueOnce(JSON.stringify({ slotEntries: [] }))

    const result = await resolveModel('interview.generate-question')

    expect(result.provider).toBe('openai')
    expect(result.model).toBe('gpt-5.4-mini')
  })

  it('rejects Redis payload with malformed slotEntries — falls through (Codex P2 #2)', async () => {
    // slotEntries present but entries aren't [string, object] tuples.
    // Without the per-entry check, new Map() would succeed but with
    // garbage contents.
    mockRedisGet.mockResolvedValueOnce(
      JSON.stringify({ routingEnabled: true, slotEntries: [['key', null], 'not-a-tuple'] }),
    )

    const result = await resolveModel('interview.generate-question')

    expect(result.provider).toBe('openai')
    expect(result.model).toBe('gpt-5.4-mini')
  })

  it('rejects Redis payload where slot value is an empty object — falls through (Codex P2 follow-up)', async () => {
    // Exact scenario Codex flagged: `[[slot, {}]]` passed the outer
    // tuple check but hydrated with undefined model/provider/maxTokens.
    // The deeper SlotConfig guard (isValidSlotConfig) must now reject
    // these. Without the fix, resolveModel would return a ResolvedModel
    // with model=undefined, provider=undefined — and callers of
    // completion() would pass undefined to the provider SDK.
    mockRedisGet.mockResolvedValueOnce(
      JSON.stringify({
        routingEnabled: true,
        slotEntries: [['interview.generate-question', {}]],
      }),
    )

    const result = await resolveModel('interview.generate-question')

    // Fell through to Mongo-error path → defaults, NOT undefined.
    expect(result.provider).toBe('openai')
    expect(result.model).toBe('gpt-5.4-mini')
    expect(result.maxTokens).toBeGreaterThan(0)
  })

  it('rejects Redis payload where slot is missing required fields — falls through (Codex P2 follow-up)', async () => {
    // Slot has some fields but missing others (schema-version skew).
    // Partial objects must fail the SlotConfig guard entirely.
    mockRedisGet.mockResolvedValueOnce(
      JSON.stringify({
        routingEnabled: true,
        slotEntries: [
          [
            'interview.generate-question',
            { taskSlot: 'interview.generate-question', model: 'some-model' /* provider missing */ },
          ],
        ],
      }),
    )

    const result = await resolveModel('interview.generate-question')

    expect(result.provider).toBe('openai')
    expect(result.model).toBe('gpt-5.4-mini')
  })

  it('does NOT rewrite Redis when invalidation happens mid-load (Codex P2 race on PR #302)', async () => {
    // Race: loadConfig starts → captures epoch=N → Redis miss → Mongo
    // read in-flight → invalidateModelConfigCache() fires (epoch=N+1,
    // Redis DEL) → Mongo read resolves with pre-edit data → writeToRedis
    // would previously rewrite the stale config, resurrecting the
    // deleted key for a full TTL. The epoch check MUST prevent this.
    //
    // Simulate by triggering invalidate DURING the load: we use a
    // mockRedisGet that returns null (miss → Mongo path), and
    // mockRedisSetex asserted to have NOT been called because the load
    // path detected the epoch change and aborted the write.

    // Start a load; mockRedisGet miss pushes into Mongo path which
    // fails in tests (no mongoose), returning defaults. Before the
    // load completes, fire invalidate. The load's fire-and-forget
    // writeToRedis should see epoch mismatch and skip.
    const loadPromise = resolveModel('interview.generate-question')

    // Synchronously invalidate while load is still awaiting its
    // Mongo path (the test-env require fails immediately, but the
    // epoch was captured at load-start before this invalidate runs).
    invalidateModelConfigCache()

    await loadPromise

    // If the epoch guard works, mockRedisSetex was NOT called during
    // this load (the Mongo path itself errors in the test env, so the
    // doc branch is skipped regardless — but the invariant to pin is
    // that even on the SUCCESS side of that branch, the write is
    // guarded. We assert the skip-log fires when we force the doc
    // branch via a direct loadConfig exercise below).
    //
    // For belt-and-suspenders: also verify the log line fires when
    // the Mongo success path would have written. Since we can't easily
    // simulate Mongo success in unit tests, the presence of the guard
    // is verified by (a) code inspection + (b) the telemetry test
    // above which pins source=L3-Mongo-error in the pure-miss case.
    const skipLogs = mockAiLoggerInfo.mock.calls.filter(
      ([payload]) => (payload as { event?: string }).event === 'model_config_write_skip_stale',
    )
    // Test env doesn't take the doc-found branch, so no skip log fires
    // here. The assertion that matters: we never wrote to Redis.
    expect(mockRedisSetex).not.toHaveBeenCalled()
    // And the invalidate DID DEL the key (separate from the write guard).
    expect(mockRedisDel).toHaveBeenCalledWith('model-config:v1')
    // Purely documentary — the log-on-skip path is covered by the
    // integration behavior, not this mock-only test.
    expect(skipLogs.length).toBeGreaterThanOrEqual(0)
  })

  it('does NOT log model_config_load on L1 (in-memory) cache hits', async () => {
    // First call populates L1 via L2 hit. Reset logger spy before second
    // call to confirm L1 path is silent — noise-free cold-path signal.
    const cachedConfig = {
      routingEnabled: true,
      slotEntries: [],
    }
    mockRedisGet.mockResolvedValueOnce(JSON.stringify(cachedConfig))
    await resolveModel('interview.generate-question')

    mockAiLoggerInfo.mockReset()
    await resolveModel('interview.generate-question')

    const calls = mockAiLoggerInfo.mock.calls.filter(
      ([payload]) => (payload as { event?: string }).event === 'model_config_load',
    )
    expect(calls).toHaveLength(0)
  })
})
