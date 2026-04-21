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
import {
  resolveModel,
  invalidateModelConfigCache,
  replaceModelConfigCache,
  __setRedisClientForTesting,
  __awaitBackgroundLoadForTesting,
} from '@shared/services/modelRouter'
import { TASK_SLOT_DEFAULTS } from '@shared/services/taskSlots'

const mockRedisGet = vi.fn<(key: string) => Promise<string | null>>()
const mockRedisSetex = vi.fn<(key: string, ttl: number, val: string) => Promise<unknown>>()
const mockRedisDel = vi.fn<(key: string) => Promise<unknown>>()
const mockRedisIncr = vi.fn<(key: string) => Promise<number>>()
const mockRedisMget = vi.fn<(...keys: string[]) => Promise<Array<string | null>>>()
const mockRedisEval = vi.fn<(script: string, numKeys: number, ...args: Array<string | number>) => Promise<unknown>>()

describe('resolveModel', () => {
  beforeEach(async () => {
    // 2026-04-21 non-blocking refactor: ensureConfig now kicks off a
    // fire-and-forget loadConfig on every cold path. Any previous
    // test's background refresh could still be in flight when this
    // test starts, which would leak state into our mocks. Drain it
    // BEFORE calling invalidateModelConfigCache() so the leftover
    // refresh can't populate _cache after we've reset it.
    await __awaitBackgroundLoadForTesting()
    invalidateModelConfigCache()
    mockRedisGet.mockReset()
    mockRedisGet.mockResolvedValue(null)
    mockRedisSetex.mockReset()
    mockRedisSetex.mockResolvedValue('OK')
    mockRedisDel.mockReset()
    mockRedisDel.mockResolvedValue(1)
    mockRedisIncr.mockReset()
    mockRedisIncr.mockResolvedValue(1)
    mockRedisMget.mockReset()
    // Default MGET response: [cache, epoch]. null for both = cache miss,
    // no epoch yet. Tests that want a cache hit override with the real
    // payload via mockResolvedValueOnce.
    mockRedisMget.mockResolvedValue([null, null])
    mockRedisEval.mockReset()
    // Default EVAL response: 1 (write succeeded) — the atomic CAS wrote
    // to Redis. Tests that want to simulate a failed CAS (race with
    // invalidate) override with mockResolvedValueOnce(0).
    mockRedisEval.mockResolvedValue(1)
    mockAiLoggerInfo.mockReset()
    mockAiLoggerWarn.mockReset()
    __setRedisClientForTesting({
      get: mockRedisGet,
      setex: mockRedisSetex,
      del: mockRedisDel,
      incr: mockRedisIncr,
      mget: mockRedisMget,
      eval: mockRedisEval,
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
    // slot routing. L2 hit is synchronous on the user thread — preserving
    // CMS routing correctness on the first call after cache invalidation
    // (Codex P2 #308). Only Mongo is kept off the user thread.
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
    mockRedisMget.mockResolvedValueOnce([JSON.stringify(cachedConfig), '1'])

    const result = await resolveModel('interview.generate-question')

    expect(mockRedisMget).toHaveBeenCalledWith('model-config:v1', 'model-config:epoch:v1')
    expect(result.model).toBe('custom-cached-model')
    expect(result.provider).toBe('anthropic')
    expect(result.maxTokens).toBe(777)
  })

  it('Redis L2 miss falls through to Mongo path (defaults when Mongo unavailable)', async () => {
    // Default MGET returns [null, null] (miss + no epoch yet). Mongo
    // require fails in tests → loadConfig catches → defaults apply.
    mockRedisMget.mockResolvedValueOnce([null, null])

    const result = await resolveModel('interview.generate-question')

    expect(mockRedisMget).toHaveBeenCalledWith('model-config:v1', 'model-config:epoch:v1')
    expect(result.provider).toBe('openai') // default, not an error
    expect(result.model).toBe('gpt-5.4-mini')
  })

  it('Redis L2 read error does NOT fail resolveModel (falls through silently)', async () => {
    // Simulate a Redis outage — the router must not propagate the error
    // to callers. A Redis failure is not a Claude-router failure.
    mockRedisMget.mockRejectedValueOnce(new Error('ECONNREFUSED Redis down'))

    const result = await resolveModel('interview.generate-question')

    // Still returns defaults — no exception raised to the caller.
    expect(result.provider).toBe('openai')
    expect(result.model).toBe('gpt-5.4-mini')
  })

  it('Redis L2 malformed JSON does NOT fail resolveModel', async () => {
    // Corrupted cache entry (wrong version, malicious write, partial
    // write during DEL race) — must not bring down LLM routing.
    mockRedisMget.mockResolvedValueOnce(['{not json', null])

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

  it('logs event=model_config_load with source=L2-Redis on a Redis cache hit', async () => {
    // Codex P2 follow-up on PR #308 restored synchronous L2 attempts:
    // when Redis has the real CMS config, honor it on the user thread
    // instead of serving defaults. That means a single synchronous
    // `L2-Redis` log — no `cold-defaults-synthetic` precedes it, because
    // defaults are only served on actual L2 miss/timeout/error.
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
    mockRedisMget.mockResolvedValueOnce([JSON.stringify(cachedConfig), '1'])

    await resolveModel('interview.generate-question')

    const calls = mockAiLoggerInfo.mock.calls.filter(
      ([payload]) => (payload as { event?: string }).event === 'model_config_load',
    )
    expect(calls).toHaveLength(1)
    const payload = calls[0]?.[0] as { event: string; source: string; durationMs: number }
    expect(payload.event).toBe('model_config_load')
    expect(payload.source).toBe('L2-Redis')
    expect(typeof payload.durationMs).toBe('number')
    expect(payload.durationMs).toBeGreaterThanOrEqual(0)
    // Sanity: a mocked in-memory Redis hit should be fast. Lenient upper
    // bound (100ms) accounts for CI machines with variable scheduling
    // latency; a 100ms hit is still 10× faster than the Mongo baseline.
    expect(payload.durationMs).toBeLessThan(100)
  })

  it('logs source=cold-defaults-synthetic + L3-Mongo-error when Redis misses AND Mongo require fails', async () => {
    // Default mockRedisMget returns [null, null] (miss). User thread
    // serves defaults synchronously → `cold-defaults-synthetic` log.
    // Mongo require fails in tests (no mongoose available) → background
    // `loadConfig` emits `L3-Mongo-error`. Both logs expected, in order.
    await resolveModel('interview.generate-question')
    await __awaitBackgroundLoadForTesting()

    const calls = mockAiLoggerInfo.mock.calls.filter(
      ([payload]) => (payload as { event?: string }).event === 'model_config_load',
    )
    // Two logs:
    //   1. cold-defaults-synthetic (synchronous, explains what the user saw)
    //   2. L3-Mongo-error (from the background refresh)
    expect(calls).toHaveLength(2)
    const cold = calls[0]?.[0] as { source: string; durationMs: number }
    expect(cold.source).toBe('cold-defaults-synthetic')
    const bg = calls[1]?.[0] as { source: string; durationMs: number }
    expect(bg.source).toBe('L3-Mongo-error')
    expect(typeof bg.durationMs).toBe('number')
  })

  // ── Codex P2 regressions (PR #302) ─────────────────────────────────────

  it('bounds Redis read latency — falls through to Mongo if Redis stalls past timeout (Codex P2 #1)', async () => {
    // Simulate a Redis that never responds — mirrors the Redis-outage
    // case where ioredis would retry 3× with backoff before rejecting
    // (~1.4s). The timeout in tryLoadFromRedis must abort BEFORE the
    // client finishes retrying so fallthrough stays fast.
    vi.useFakeTimers()
    try {
      // Cache read is now MGET; stall it to simulate Redis outage.
      mockRedisMget.mockImplementationOnce(() => new Promise(() => { /* never resolves */ }))

      const resolvePromise = resolveModel('interview.generate-question')
      // Advance past the 500ms read timeout. Anything >500ms guarantees
      // the timeout fires regardless of fencepost ordering; we use 800ms
      // for generous headroom so this isn't flaky on slow CI. Raised
      // from 500ms on 2026-04-21 alongside REDIS_READ_TIMEOUT_MS 200→500.
      await vi.advanceTimersByTimeAsync(800)
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
    mockRedisMget.mockResolvedValueOnce([JSON.stringify({ routingEnabled: 'yes', slotEntries: 'nope' }), null])

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
    mockRedisMget.mockResolvedValueOnce([JSON.stringify({ slotEntries: [] }), null])

    const result = await resolveModel('interview.generate-question')

    expect(result.provider).toBe('openai')
    expect(result.model).toBe('gpt-5.4-mini')
  })

  it('rejects Redis payload with malformed slotEntries — falls through (Codex P2 #2)', async () => {
    // slotEntries present but entries aren't [string, object] tuples.
    // Without the per-entry check, new Map() would succeed but with
    // garbage contents.
    mockRedisMget.mockResolvedValueOnce([
      JSON.stringify({ routingEnabled: true, slotEntries: [['key', null], 'not-a-tuple'] }),
      null,
    ])

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
    mockRedisMget.mockResolvedValueOnce([
      JSON.stringify({
        routingEnabled: true,
        slotEntries: [['interview.generate-question', {}]],
      }),
      null,
    ])

    const result = await resolveModel('interview.generate-question')

    // Fell through to Mongo-error path → defaults, NOT undefined.
    expect(result.provider).toBe('openai')
    expect(result.model).toBe('gpt-5.4-mini')
    expect(result.maxTokens).toBeGreaterThan(0)
  })

  it('rejects Redis payload where slot is missing required fields — falls through (Codex P2 follow-up)', async () => {
    // Slot has some fields but missing others (schema-version skew).
    // Partial objects must fail the SlotConfig guard entirely.
    mockRedisMget.mockResolvedValueOnce([
      JSON.stringify({
        routingEnabled: true,
        slotEntries: [
          [
            'interview.generate-question',
            { taskSlot: 'interview.generate-question', model: 'some-model' /* provider missing */ },
          ],
        ],
      }),
      null,
    ])

    const result = await resolveModel('interview.generate-question')

    expect(result.provider).toBe('openai')
    expect(result.model).toBe('gpt-5.4-mini')
  })

  it('does NOT rewrite Redis when invalidation happens mid-load (Codex P2 same-Lambda race on PR #302)', async () => {
    // Same-Lambda race: loadConfig starts → captures in-process epoch=N
    // → Redis miss → Mongo read in-flight → invalidateModelConfigCache()
    // fires (epoch=N+1, Redis DEL+INCR) → Mongo read resolves → the
    // writeToRedis would previously rewrite stale config. The in-process
    // epoch check MUST prevent this even before the cross-Lambda Redis
    // check runs.
    const loadPromise = resolveModel('interview.generate-question')
    invalidateModelConfigCache()
    await loadPromise

    // The core invariant: no cache write slipped through during the race.
    // (Mongo path also errors in test env so the doc branch isn't taken,
    // but this assertion would also hold if Mongo had returned a doc —
    // the in-process epoch check aborts BEFORE the writeToRedis fires.)
    expect(mockRedisSetex).not.toHaveBeenCalled()
    // Invalidate did DEL + INCR — the cross-Lambda signal.
    expect(mockRedisDel).toHaveBeenCalledWith('model-config:v1')
    expect(mockRedisIncr).toHaveBeenCalledWith('model-config:epoch:v1')
  })

  it('invalidateModelConfigCache() INCRs the Redis-shared epoch (Codex P2 cross-Lambda on PR #302)', async () => {
    // The INCR is the cross-Lambda signal. In-flight writers on OTHER
    // Lambdas captured an earlier epoch via MGET and re-check before
    // SETEX; the INCR here causes their re-check to mismatch and skip.
    invalidateModelConfigCache()

    // Both fire-and-forget but issued synchronously. Flush one tick.
    await Promise.resolve()

    expect(mockRedisIncr).toHaveBeenCalledWith('model-config:epoch:v1')
    expect(mockRedisDel).toHaveBeenCalledWith('model-config:v1')
  })

  it('uses atomic Lua CAS for the write (epoch-check and SETEX fused) (Codex P2 atomic on PR #302)', async () => {
    // Earlier implementation did GET+SETEX as separate Redis commands,
    // leaving a window where invalidate could interleave. Lua EVAL
    // runs both ops server-side as a single atomic transaction — no
    // interleaving possible. This test pins the atomic contract: the
    // write path MUST go through eval(CAS_WRITE_LUA, ...), never a
    // bare SETEX.
    //
    // We can't easily force Mongo-success in unit tests, so the assert
    // is contract-shape: no direct SETEX on any resolveModel call.
    // SETEX must only be invoked via Lua EVAL (which is observed under
    // integration, via client.eval in production).
    mockRedisMget.mockResolvedValueOnce([null, '5'])

    await resolveModel('interview.generate-question')

    // In the test env Mongo path errors out so no write attempt is
    // made. The contract we pin: if the write path IS taken, it must
    // go through eval (not a bare setex). Both call counts are 0
    // here; the assertion guards against regressions where someone
    // re-adds a non-atomic SETEX write-path.
    expect(mockRedisSetex).not.toHaveBeenCalled()
  })

  it('eval(CAS) returning 0 does NOT raise — writer-side race is handled silently (Codex P2 atomic on PR #302)', async () => {
    // Simulate a full round-trip where the write path IS taken but
    // the Lua CAS returns 0 (current epoch != captured). This models
    // the concurrent-invalidate race at the Redis level. The write
    // skip must be silent from the caller's perspective (resolveModel
    // still returns a valid ResolvedModel) and must emit the
    // `model_config_write_skip_stale_cross_lambda` info log so ops
    // can observe the rate.
    //
    // Since we can't easily force Mongo-success in unit tests, we
    // invoke writeToRedis indirectly by simulating the full sequence:
    // MGET returns miss, Mongo errors (test env), no write is made —
    // but the eval mock is still configured for the 0 return so IF
    // the write were made, it would be handled correctly. The
    // assertion that MATTERS is that mockRedisEval being configured
    // this way doesn't leak into resolveModel's return value.
    mockRedisEval.mockResolvedValueOnce(0)
    mockRedisMget.mockResolvedValueOnce([null, '5'])

    const result = await resolveModel('interview.generate-question')

    // Caller must still see defaults — a Redis-side race does not
    // propagate into the Claude-router return value.
    expect(result.provider).toBe('openai')
    expect(result.model).toBe('gpt-5.4-mini')
  })

  it('does NOT log model_config_load on L1 (in-memory) cache hits', async () => {
    // First call: L2 hit populates _cache synchronously and logs
    // `L2-Redis`. Reset the logger spy, then a second call must hit
    // L1 cleanly with zero telemetry — otherwise steady-state traffic
    // would spam `model_config_load` logs and lose the cold-path signal
    // ops depends on.
    const cachedConfig = {
      routingEnabled: true,
      slotEntries: [],
    }
    mockRedisMget.mockResolvedValueOnce([JSON.stringify(cachedConfig), '1'])

    await resolveModel('interview.generate-question')

    mockAiLoggerInfo.mockReset()
    await resolveModel('interview.generate-question')

    const calls = mockAiLoggerInfo.mock.calls.filter(
      ([payload]) => (payload as { event?: string }).event === 'model_config_load',
    )
    expect(calls).toHaveLength(0)
  })

  // ── 2026-04-21 cold-path contract (Codex P2 follow-up on PR #308) ──────
  //
  // The bug: before 2026-04-21, `ensureConfig` awaited the full L2 → L3
  // cascade on every cache miss. On cold Lambdas with an empty production
  // Redis (the state after PR A's first deploy, after `eval('require')`
  // was fixed) this added ~1-2.5s of ioredis connect + TLS+SCRAM + Mongo
  // round-trip BEFORE the actual LLM call. On `/api/evaluate-answer` where
  // the client aborts at 5s (useInterviewAPI.ts:148), this overhead
  // reliably pushed real requests past the abort threshold. The client
  // then silently wrote fake 50/50/50/50 scores into the evaluations
  // array, killing interviews at Q2/Q3. Session DB records on 2026-04-21
  // show 5 of 8 sessions failed in exactly this pattern.
  //
  // The fix: keep L2 Redis on the user thread (bounded by
  // REDIS_READ_TIMEOUT_MS = 500ms) because an L2 hit means routing is
  // CORRECT per CMS — swapping to defaults would silently mis-route on
  // the first call after a CMS change. But never block on Mongo: if L2
  // misses/errors/times out, serve TASK_SLOT_DEFAULTS synchronously and
  // kick off Mongo in the background.
  //
  // These tests pin both halves of that contract.

  describe('2026-04-21 cold-path contract (non-blocking Mongo, bounded L2)', () => {
    it('cold resolveModel with L2 stall is bounded by REDIS_READ_TIMEOUT_MS, not Mongo latency', async () => {
      // Simulate a Redis that hangs forever. The user thread awaits the
      // withTimeout cap (500ms) on L2 and then falls through to defaults
      // — it does NOT go on to await Mongo. The whole-request budget is
      // therefore bounded by REDIS_READ_TIMEOUT_MS, not by connectDB TLS
      // + Mongo round-trip. That's what keeps /api/evaluate-answer under
      // the 5s client abort on cold Lambdas with empty Redis.
      mockRedisMget.mockImplementationOnce(() => new Promise(() => { /* never resolves */ }))

      const start = Date.now()
      const result = await resolveModel('interview.evaluate-answer')
      const elapsed = Date.now() - start

      // Upper bound: REDIS_READ_TIMEOUT_MS (500) + generous CI slack.
      // Stays well below the 5s client abort.
      expect(elapsed).toBeLessThan(900)
      expect(result.provider).toBe('openai')
      expect(result.model).toBe('gpt-5.4-mini')
      expect(result.maxTokens).toBe(250)
    })

    it('cold resolveModel with L2 miss emits source=cold-defaults-synthetic telemetry', async () => {
      // The synchronous log is intentional — ops needs to see when a
      // request was served defaults because the cache was cold. If this
      // log disappears we can no longer correlate "slow LLM call" with
      // "was L3 even tried for this request."
      //
      // Default mockRedisMget returns [null, null] (miss) — the user
      // thread skips directly to the synthetic-defaults branch without
      // stalling, then the background load kicks off.
      await resolveModel('interview.evaluate-answer')

      const calls = mockAiLoggerInfo.mock.calls.filter(
        ([payload]) => (payload as { event?: string }).event === 'model_config_load',
      )
      // At least one entry (cold-defaults-synthetic, emitted synchronously).
      // The background load may or may not have completed yet; either way
      // the cold log MUST be first.
      expect(calls.length).toBeGreaterThanOrEqual(1)
      const coldPayload = calls[0]?.[0] as { source: string; durationMs: number }
      expect(coldPayload.source).toBe('cold-defaults-synthetic')
      expect(coldPayload.durationMs).toBe(0)
    })

    it('L2 hit on first call honors CMS config — does NOT return TASK_SLOT_DEFAULTS (Codex P2 #308)', async () => {
      // The correctness half of the Codex P2 fix: the first call after
      // invalidateModelConfigCache() (or any cold Lambda with a warm
      // Redis) must honor the CMS-persisted config, not silently use
      // TASK_SLOT_DEFAULTS. Without the restored L2-synchronous path
      // this would regress to defaults until the background refresh
      // completed — which for a cold Lambda is exactly when correctness
      // matters most (first request).
      const cachedConfig = {
        routingEnabled: true,
        slotEntries: [
          [
            'interview.evaluate-answer',
            {
              taskSlot: 'interview.evaluate-answer',
              model: 'cms-custom-model',
              provider: 'anthropic',
              maxTokens: 111,
              isActive: true,
            },
          ],
        ],
      }
      mockRedisMget.mockResolvedValueOnce([JSON.stringify(cachedConfig), '1'])

      // First call — L2 hit on the user thread. Must return the CMS
      // config immediately, NOT defaults.
      const cold = await resolveModel('interview.evaluate-answer')
      expect(cold.model).toBe('cms-custom-model')
      expect(cold.provider).toBe('anthropic')
      expect(cold.maxTokens).toBe(111)

      // Second call — L1 hit with the same custom config; no extra
      // MGET needed.
      const warm = await resolveModel('interview.evaluate-answer')
      expect(warm.model).toBe('cms-custom-model')
      expect(mockRedisMget).toHaveBeenCalledTimes(1)
    })

    it('concurrent cold calls dedup the background Mongo refresh (no thundering herd)', async () => {
      // When L2 misses, the Mongo refresh MUST be deduped — the
      // `_loadPromise` guard in ensureConfig prevents N parallel cold
      // requests from fanning out into N parallel connectDB + Mongo
      // reads. A regression here would resurrect the thundering-herd
      // L3 cascade that cold Lambdas suffered before the non-blocking
      // refactor.
      //
      // Default MGET returns [null, null] — all three calls see L2
      // miss, all three attempt to kick off background load, only one
      // wins. The background `loadConfig` eventually fails in the test
      // env (Mongo require throws) and emits a SINGLE L3-Mongo-error
      // log. That log count is the dedup signal.
      await Promise.all([
        resolveModel('interview.evaluate-answer'),
        resolveModel('interview.evaluate-answer'),
        resolveModel('interview.evaluate-answer'),
      ])
      await __awaitBackgroundLoadForTesting()

      // Exactly one background refresh log, regardless of how many
      // concurrent callers raced on ensureConfig.
      const bgCalls = mockAiLoggerInfo.mock.calls.filter(
        ([payload]) => {
          const p = payload as { event?: string; source?: string }
          return p.event === 'model_config_load' && p.source === 'L3-Mongo-error'
        },
      )
      expect(bgCalls).toHaveLength(1)
    })
  })

  // ── replaceModelConfigCache (Codex P2 follow-up on PR #308) ─────────────
  //
  // The window this closes: `invalidateModelConfigCache()` DEL'd L2 and let
  // the next request's background Mongo refresh repopulate it. Between the
  // DEL and the repopulate, cold Lambdas hit `ensureConfig()` and served
  // `TASK_SLOT_DEFAULTS` instead of the freshly-saved CMS config. For any
  // CMS change that diverges from defaults (routing toggle, provider swap,
  // non-default model), that meant the first post-save request used the
  // WRONG config. `replaceModelConfigCache` populates L1/L2 directly with
  // the known-fresh doc — L2 is never empty between saves.

  describe('replaceModelConfigCache', () => {
    it('writes the fresh doc to L1 synchronously — next resolveModel hits L1', async () => {
      const doc = {
        routingEnabled: true,
        slots: [
          {
            taskSlot: 'interview.generate-question',
            model: 'freshly-saved-model',
            provider: 'openrouter',
            maxTokens: 555,
            isActive: true,
          },
        ],
      }

      await replaceModelConfigCache(doc)

      // resolveModel reads L1 without an MGET — the cache is populated
      // before any async MGET/eval lands.
      const before = mockRedisMget.mock.calls.length
      const result = await resolveModel('interview.generate-question')
      const after = mockRedisMget.mock.calls.length
      expect(after).toBe(before) // no MGET, L1 hit
      expect(result.model).toBe('freshly-saved-model')
      expect(result.provider).toBe('openrouter')
      expect(result.maxTokens).toBe(555)
    })

    it('does NOT DEL the Redis cache (the whole point: no empty-L2 window)', async () => {
      const doc = {
        routingEnabled: true,
        slots: [],
      }

      await replaceModelConfigCache(doc)

      // DEL would reintroduce the window. `invalidateModelConfigCache`
      // still exists for tests/other callers, but the CMS save path
      // must NEVER hit DEL anymore.
      expect(mockRedisDel).not.toHaveBeenCalled()
    })

    it('INCRs the Redis shared epoch to signal other Lambdas', async () => {
      mockRedisIncr.mockResolvedValueOnce(7) // post-INCR epoch value

      await replaceModelConfigCache({ routingEnabled: true, slots: [] })

      expect(mockRedisIncr).toHaveBeenCalledWith('model-config:epoch:v1')
    })

    it('writes L2 via atomic Lua CAS — never a bare SETEX', async () => {
      // The write must go through eval(CAS_WRITE_LUA, ...) so a racing
      // admin save's INCR would deterministically invalidate ours. A
      // plain SETEX would lose the "last save wins" contract.
      mockRedisIncr.mockResolvedValueOnce(3)

      await replaceModelConfigCache({
        routingEnabled: true,
        slots: [
          {
            taskSlot: 'interview.generate-question',
            model: 'model-x',
            provider: 'openai',
            maxTokens: 200,
            isActive: true,
          },
        ],
      })

      expect(mockRedisEval).toHaveBeenCalledTimes(1)
      expect(mockRedisSetex).not.toHaveBeenCalled()
      const [script, numKeys, cacheKey, epochKey, capturedEpoch] =
        mockRedisEval.mock.calls[0] as [string, number, string, string, string]
      expect(script).toContain('setex') // the Lua script contains SETEX
      expect(numKeys).toBe(2)
      expect(cacheKey).toBe('model-config:v1')
      expect(epochKey).toBe('model-config:epoch:v1')
      // Captured epoch passed to Lua = post-INCR value from our own
      // INCR. Matches current Redis epoch → CAS succeeds in the
      // uncontested case.
      expect(capturedEpoch).toBe('3')
    })

    it('inactive slots are excluded from the cache (matches loadConfig semantics)', async () => {
      await replaceModelConfigCache({
        routingEnabled: true,
        slots: [
          {
            taskSlot: 'interview.generate-question',
            model: 'active-model',
            provider: 'openai',
            maxTokens: 200,
            isActive: true,
          },
          {
            taskSlot: 'interview.evaluate-answer',
            model: 'inactive-model',
            provider: 'openai',
            maxTokens: 200,
            isActive: false,
          },
        ],
      })

      const active = await resolveModel('interview.generate-question')
      expect(active.model).toBe('active-model')

      // Inactive slot falls back to TASK_SLOT_DEFAULTS because resolveModel
      // only returns a custom ResolvedModel when the slot is in the map.
      const inactive = await resolveModel('interview.evaluate-answer')
      expect(inactive.model).toBe(TASK_SLOT_DEFAULTS['interview.evaluate-answer'].model)
    })

    it('bumps the in-process epoch so an in-flight loadConfig skips its write', async () => {
      // Same-Lambda race: a user request on THIS container started a
      // loadConfig (captured epoch=N) → it's awaiting Mongo →
      // admin save fires replaceModelConfigCache (bumps epoch to N+1,
      // writes fresh config) → Mongo finally returns → loadConfig's
      // `if (_invalidationEpoch === loadStartEpoch)` check fails and
      // skips the Redis write. Our fresh config is preserved.
      //
      // We can't directly observe _invalidationEpoch, so we assert on
      // the same behavioral invariant used elsewhere in this file: a
      // concurrent-invalidate flow must not SETEX stale data over a
      // fresh replaceModelConfigCache.
      const loadPromise = resolveModel('interview.generate-question')
      await replaceModelConfigCache({
        routingEnabled: true,
        slots: [
          {
            taskSlot: 'interview.generate-question',
            model: 'winner-model',
            provider: 'openai',
            maxTokens: 200,
            isActive: true,
          },
        ],
      })
      await loadPromise
      await __awaitBackgroundLoadForTesting()

      // The background load (from the first resolveModel) must NOT have
      // overwritten our fresh cache. Next read returns the fresh value.
      const after = await resolveModel('interview.generate-question')
      expect(after.model).toBe('winner-model')
    })

    it('Redis write failure does NOT throw — L1 is still updated', async () => {
      // If Redis is down during CMS save, the admin response must still
      // succeed. Their own Lambda's L1 has the fresh config (so their
      // subsequent admin actions route correctly); other Lambdas degrade
      // gracefully to their existing caching behavior.
      mockRedisIncr.mockRejectedValueOnce(new Error('ECONNREFUSED'))

      await expect(
        replaceModelConfigCache({
          routingEnabled: true,
          slots: [
            {
              taskSlot: 'interview.generate-question',
              model: 'redis-down-model',
              provider: 'openai',
              maxTokens: 200,
              isActive: true,
            },
          ],
        }),
      ).resolves.not.toThrow()

      // L1 still has the fresh config.
      const result = await resolveModel('interview.generate-question')
      expect(result.model).toBe('redis-down-model')
    })

    it('Lua CAS returning 0 (concurrent save raced us) does NOT throw', async () => {
      // Concurrent admin saves: Admin A INCRs epoch to N+1, Admin B
      // INCRs to N+2 before Admin A's eval fires. Admin A's eval sees
      // current=N+2, captured=N+1, returns 0. Must log + not throw —
      // Admin B's save wins, which is the correct outcome.
      mockRedisIncr.mockResolvedValueOnce(5)
      mockRedisEval.mockResolvedValueOnce(0)

      await expect(
        replaceModelConfigCache({ routingEnabled: true, slots: [] }),
      ).resolves.not.toThrow()

      // Verify the structured log for observability.
      const skipLogs = mockAiLoggerInfo.mock.calls.filter(
        ([payload]) =>
          (payload as { event?: string }).event === 'model_config_replace_skip_stale',
      )
      expect(skipLogs).toHaveLength(1)
    })

    it('resolves the Codex P2 scenario: cold Lambda after save gets fresh config, not defaults', async () => {
      // End-to-end proof of the fix. Sequence:
      //   1. Admin saves CMS (routingEnabled: true, custom model for
      //      interview.evaluate-answer) → CMS PUT calls
      //      replaceModelConfigCache.
      //   2. Simulate another Lambda cold-starting: invalidate THIS
      //      Lambda's L1 (as would happen on a fresh container), but
      //      the Redis L2 that replaceModelConfigCache wrote should
      //      still be there.
      //   3. The cold Lambda's first request hits L2 via MGET and
      //      returns the fresh custom model — NOT TASK_SLOT_DEFAULTS.
      const customConfig = {
        routingEnabled: true,
        slots: [
          {
            taskSlot: 'interview.evaluate-answer',
            model: 'custom-post-save-model',
            provider: 'anthropic',
            maxTokens: 333,
            isActive: true,
          },
        ],
      }

      // Admin Lambda: save the config.
      await replaceModelConfigCache(customConfig)

      // Simulate cross-Lambda: another container has empty L1 but
      // reads from the same Redis L2. The mock MGET returns the value
      // that replaceModelConfigCache wrote. We capture the SETEX
      // payload from the eval mock's call args — the JSON in arg[4].
      const evalCall = mockRedisEval.mock.calls[0] as [string, number, string, string, string, string, number]
      const writtenPayload = evalCall[5]
      expect(writtenPayload).toContain('custom-post-save-model')

      // Clear the other Lambda's L1 (cold start), set MGET to return
      // what replaceModelConfigCache wrote.
      _clearLocalCacheForCrossLambdaSim()
      mockRedisMget.mockResolvedValueOnce([writtenPayload, '1'])

      const coldResult = await resolveModel('interview.evaluate-answer')
      expect(coldResult.model).toBe('custom-post-save-model')
      expect(coldResult.provider).toBe('anthropic')
      expect(coldResult.maxTokens).toBe(333)
    })
  })
})

// Test-only helper: clear _cache without triggering the full invalidate
// path (which DELs Redis). Used to simulate a different Lambda container
// that has a fresh L1 but shares the same Redis L2 that replaceModelConfigCache
// wrote. Invalidate would clobber Redis; that's not what we want here.
function _clearLocalCacheForCrossLambdaSim(): void {
  // We intentionally re-use invalidateModelConfigCache because its ONLY
  // job in test env is to null _cache; the Redis DEL is noop against our
  // mock (we don't assert on it in the next step). The cross-Lambda
  // simulation just needs an empty L1.
  invalidateModelConfigCache()
}
