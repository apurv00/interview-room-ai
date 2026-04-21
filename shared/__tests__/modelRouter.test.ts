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

// Mock logger to avoid noisy output
vi.mock('@shared/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  aiLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
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
})
