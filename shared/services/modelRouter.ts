import { TASK_SLOT_DEFAULTS, type TaskSlot } from '@shared/services/taskSlots'
import { aiLogger } from '@shared/logger'

// Redis (PR A) is loaded via `eval('require')` inside the helpers below
// — same pattern mongoose uses. A static `import { redis }` from
// @shared/redis pulled ioredis into the client bundle via the dynamic
// import chain `app/interview/page.tsx → codingProblemGenerator.ts →
// modelRouter.ts → @shared/redis`, breaking `next build` (ioredis needs
// node's net/tls/dns). eval-require is invisible to webpack, so the
// import stays server-only at runtime.
//
// Minimal subset of ioredis methods we need — matches the real client
// so tests and runtime see the same contract.
interface RedisLike {
  get(key: string): Promise<string | null>
  setex(key: string, ttl: number, value: string): Promise<unknown>
  del(key: string): Promise<unknown>
  incr(key: string): Promise<number>
  mget(...keys: string[]): Promise<Array<string | null>>
}

// Test override hatch — see `__setRedisClientForTesting` below.
// Kept module-scoped so production code paths never observe it. Set
// only from test setup; production always resolves the real client via
// `eval('require')('@shared/redis')`.
let _redisOverride: RedisLike | null = null

function getRedisClient(): RedisLike | null {
  if (_redisOverride) return _redisOverride
  if (typeof window !== 'undefined') return null
  try {
    const _require = eval('require') as NodeRequire
    const { redis } = _require('@shared/redis') as typeof import('@shared/redis')
    return redis as unknown as RedisLike
  } catch {
    return null
  }
}

/**
 * Test-only: inject a fake Redis client so modelRouter unit tests can
 * exercise the L2 cache paths without pulling real ioredis (which
 * requires node's net/tls and would hang against localhost:6379 in
 * CI). Production code never calls this. Pass `null` to reset.
 */
export function __setRedisClientForTesting(client: RedisLike | null): void {
  _redisOverride = client
}

// ─── Slot config (inlined to avoid pulling mongoose into client bundles) ────

interface SlotConfig {
  taskSlot: string
  model: string
  fallbackModel?: string
  fallbackProvider?: string
  maxTokens: number
  provider: string
  temperature?: number
  isActive: boolean
  useToonInput?: boolean
}

// ─── In-memory cache (L1) + Redis cache (L2) + Mongo (L3) ─────────────────

interface CachedConfig {
  routingEnabled: boolean
  slots: Map<TaskSlot, SlotConfig>
  loadedAt: number
}

const CACHE_TTL_MS = 60_000
const REDIS_CACHE_KEY = 'model-config:v1'
const REDIS_TTL_SECONDS = 60
/**
 * Monotonic counter, shared across ALL Lambda containers via Redis.
 * Incremented on every `invalidateModelConfigCache()`. Every
 * `loadConfig()` captures its value at start and re-checks it before
 * `writeToRedis` — a mismatch means an invalidate happened (on ANY
 * container) during our load, so we refuse to repopulate Redis with
 * potentially-stale Mongo-read data. Codex P2 follow-up on PR #302.
 * No TTL: the counter is long-lived by design; losing it (Redis flush)
 * just re-resets to 0 and behaves like a fresh install — in-flight
 * writers either see matching values or a natural mismatch that
 * conservatively aborts, both safe.
 */
const REDIS_EPOCH_KEY = 'model-config:epoch:v1'
let _cache: CachedConfig | null = null
let _loadPromise: Promise<void> | null = null

/**
 * Which layer served the most recent `loadConfig()` call. Surfaced in the
 * `ensureConfig` structured log so Vercel can answer two questions at a
 * glance:
 *   1. Are cold Lambdas hitting the Redis L2 cache (claimed ~5ms) or
 *      falling through to Mongo L3 (observed ~1.5s connectDB + read)?
 *   2. When they fall through, why? (empty key → cold Redis key,
 *      error → Redis outage, skipped → running in browser/unreachable)
 *
 * L1 hits do NOT log — every `completion()` call checks L1 first, and
 * logging every call would drown out the cold-path events we actually
 * care about.
 */
type ConfigLoadSource =
  | 'L2-Redis'          // Redis cache hit — the happy path this PR was scoped for
  | 'L3-Mongo'          // Redis miss + Mongo read succeeded — expected on first cold Lambda after cache bust / deploy
  | 'L3-Mongo-error'    // Mongo read failed — defaults used, alert-worthy
  | 'defaults-client'   // typeof window !== 'undefined' branch — should never show in server logs
let _lastLoadSource: ConfigLoadSource = 'defaults-client'

/**
 * Serialisable shape of the config as stored in Redis.
 * Map is not JSON-serialisable so we flatten to an array of entries.
 */
interface SerializedConfig {
  routingEnabled: boolean
  slotEntries: Array<[TaskSlot, SlotConfig]>
}

function hydrateFromSerialized(data: SerializedConfig): CachedConfig {
  return {
    routingEnabled: data.routingEnabled,
    slots: new Map(data.slotEntries),
    loadedAt: Date.now(),
  }
}

function serializeForRedis(cache: CachedConfig): SerializedConfig {
  return {
    routingEnabled: cache.routingEnabled,
    slotEntries: Array.from(cache.slots.entries()),
  }
}

/**
 * In-process invalidation counter. Catches the same-Lambda race: a
 * CMS PUT on this container bumps the counter, any in-flight loadConfig
 * on this container captured the old value, and writeToRedis skips.
 * See also the Redis-shared epoch below for cross-Lambda coverage.
 */
let _invalidationEpoch = 0

/**
 * Hard cap on how long we'll block on a Redis read before giving up and
 * falling through to Mongo. Codex P2 #1 on PR #302: the shared ioredis
 * client uses `maxRetriesPerRequest: 3` with exponential backoff, so a
 * down/unreachable Redis would stall `await client.get(...)` for roughly
 * 200ms + 400ms + 800ms = ~1.4s before the driver rejects. That defeats
 * the whole point of failing open fast — cold Lambdas would end up
 * paying BOTH the Redis timeout AND the Mongo round-trip. 200ms is
 * generous for a same-region Redis p99 (typically <10ms in Upstash /
 * Vercel KV) but still decisively faster than the Mongo baseline, so a
 * timeout never hides a healthy-Redis hit.
 */
const REDIS_READ_TIMEOUT_MS = 200

/**
 * Race a promise against a timeout. On timeout, the returned promise
 * rejects; the caller's try/catch handles fall-through. We clear the
 * timer on either outcome so we don't leak handles when the primary
 * promise wins.
 */
function withTimeout<T>(primary: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([primary, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/**
 * Per-slot guard — checks that every required SlotConfig field is
 * present AND correctly typed. Initial version only asserted the slot
 * value was "some object", which let payloads like `[[slot, {}]]`
 * through; resolveModel then read `undefined` for model/provider/
 * maxTokens and silently degraded to error-fallback behavior for the
 * full TTL. Codex P2 follow-up on PR #302: each entry must pass THIS
 * check, not just the outer tuple shape. Optional fields
 * (fallbackModel, fallbackProvider, temperature, useToonInput) are
 * intentionally NOT validated here — they're optional in the
 * SlotConfig type and a missing optional is correct behavior.
 */
function isValidSlotConfig(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const s = value as Record<string, unknown>
  return (
    typeof s.taskSlot === 'string' &&
    typeof s.model === 'string' &&
    typeof s.provider === 'string' &&
    typeof s.maxTokens === 'number' &&
    typeof s.isActive === 'boolean'
  )
}

/**
 * Structural guard for the JSON blob stored in Redis. `JSON.parse`
 * succeeds on any syntactically-valid JSON — including payloads from a
 * different schema version or a partial/garbled write. Without this
 * guard, `_cache = hydrateFromSerialized(badData)` would produce a
 * CachedConfig with `undefined` fields, `tryLoadFromRedis` would return
 * true, and routing would silently fall back to defaults for a full
 * 60-second TTL even when Mongo has a correct config. Codex P2 #2 on
 * PR #302. Narrow type guard (not Zod) to avoid adding a dep + keep the
 * hot path allocation-free.
 */
function isValidSerializedConfig(data: unknown): data is SerializedConfig {
  if (!data || typeof data !== 'object') return false
  const obj = data as Record<string, unknown>
  if (typeof obj.routingEnabled !== 'boolean') return false
  if (!Array.isArray(obj.slotEntries)) return false
  for (const entry of obj.slotEntries) {
    if (!Array.isArray(entry) || entry.length !== 2) return false
    if (typeof entry[0] !== 'string') return false
    if (!isValidSlotConfig(entry[1])) return false
  }
  return true
}

/**
 * Try to hydrate `_cache` from Redis. Uses MGET so we capture the
 * shared epoch in the SAME round-trip as the cache read — zero added
 * latency on the L2-hit happy path. The returned `capturedEpoch` is
 * handed to `writeToRedis` on the L3 fallback so the eventual write
 * can detect "did an invalidation happen on ANY Lambda during our
 * load?" (Codex P2 follow-up on PR #302).
 *
 * `hit=true` means _cache was successfully hydrated from Redis.
 * `hit=false` with non-null `capturedEpoch` means Redis was reached
 * but had no/bad cache data — the epoch is still usable for the
 * subsequent write's CAS check. `hit=false` with null epoch means
 * Redis was unreachable; the write path will skip entirely in that
 * case (fail-safe).
 */
async function tryLoadFromRedis(): Promise<{ hit: boolean; capturedEpoch: string | null }> {
  const client = getRedisClient()
  if (!client) return { hit: false, capturedEpoch: null }
  try {
    const [rawConfig, rawEpoch] = await withTimeout(
      client.mget(REDIS_CACHE_KEY, REDIS_EPOCH_KEY),
      REDIS_READ_TIMEOUT_MS,
      'Redis L2 read',
    )
    if (!rawConfig) return { hit: false, capturedEpoch: rawEpoch ?? null }
    const parsed: unknown = JSON.parse(rawConfig)
    if (!isValidSerializedConfig(parsed)) {
      // Payload shape mismatch — likely schema-version skew or a garbled
      // write. Treat as a cache miss so the next call rebuilds from
      // Mongo. NOT writing to Redis here on purpose: invalidating on
      // detected corruption risks a DEL-race between multiple Lambdas.
      // The corrupted key will age out at its TTL (≤60s).
      aiLogger.warn(
        { preview: rawConfig.slice(0, 200) },
        'ModelRouter: Redis L2 payload failed shape validation, falling through to Mongo',
      )
      return { hit: false, capturedEpoch: rawEpoch ?? null }
    }
    _cache = hydrateFromSerialized(parsed)
    return { hit: true, capturedEpoch: rawEpoch ?? null }
  } catch (err) {
    aiLogger.warn({ err }, 'ModelRouter: Redis L2 cache read failed, falling through to Mongo')
    return { hit: false, capturedEpoch: null }
  }
}

/**
 * Write the successfully-loaded cache to Redis with a cross-Lambda
 * stale-write guard. Before SETEX, we re-read the shared epoch from
 * Redis; if it differs from `capturedEpoch` (captured at load-start
 * inside `tryLoadFromRedis` via MGET), an invalidation happened on
 * some Lambda during our Mongo read and our data may be pre-edit.
 * We skip the write; the next load sees a Redis miss (the invalidate
 * DEL'd the key) and rebuilds.
 *
 * Cost: 1 extra Redis GET per L3-Mongo success path. The capture side
 * is free (piggybacks on the MGET we already do). Never throws — a
 * Redis write failure must not fail the request that just succeeded
 * against Mongo. Codex P2 follow-up on PR #302.
 */
async function writeToRedis(cache: CachedConfig, capturedEpoch: string | null): Promise<void> {
  const client = getRedisClient()
  if (!client) return
  try {
    const currentEpoch = await withTimeout(
      client.get(REDIS_EPOCH_KEY),
      REDIS_READ_TIMEOUT_MS,
      'Redis epoch re-check',
    )
    if (capturedEpoch !== currentEpoch) {
      aiLogger.info(
        {
          event: 'model_config_write_skip_stale_cross_lambda',
          capturedEpoch,
          currentEpoch,
        },
        'ModelRouter: skipped Redis write — cross-Lambda invalidation during load',
      )
      return
    }
    await client.setex(REDIS_CACHE_KEY, REDIS_TTL_SECONDS, JSON.stringify(serializeForRedis(cache)))
  } catch (err) {
    aiLogger.warn({ err }, 'ModelRouter: Redis L2 cache write failed (L1 still populated)')
  }
}

async function loadConfig(): Promise<void> {
  if (typeof window !== 'undefined') {
    _cache = { routingEnabled: false, slots: new Map(), loadedAt: Date.now() }
    _lastLoadSource = 'defaults-client'
    return
  }

  // Capture the in-process invalidation counter BEFORE any async work
  // — guards the SAME-Lambda race (invalidate fires between here and
  // the writeToRedis below). The cross-Lambda race is guarded
  // separately by the Redis-shared epoch that tryLoadFromRedis
  // captures via MGET in its return value.
  const loadStartEpoch = _invalidationEpoch

  // L2: Redis. Cross-Lambda-container cache — avoids paying Mongo cost
  // every time a cold Lambda's in-memory L1 is empty. 60s TTL matches
  // L1 so expiration feels consistent to callers; invalidation on CMS
  // save DELs the key so updates propagate in ≤1 request.
  const redisResult = await tryLoadFromRedis()
  if (redisResult.hit) {
    _lastLoadSource = 'L2-Redis'
    return
  }
  // Epoch captured from Redis in the SAME round-trip as the cache read
  // (MGET). Threaded into writeToRedis so it can CAS-check before
  // committing a potentially-stale Mongo read.
  const capturedRedisEpoch = redisResult.capturedEpoch

  try {
    const _require = eval('require') as NodeRequire
    const { connectDB } = _require('@shared/db/connection') as typeof import('@shared/db/connection')
    const { ModelConfig } = _require('@shared/db/models/ModelConfig') as typeof import('@shared/db/models/ModelConfig')
    await connectDB()
    const doc = await ModelConfig.getConfig()
    if (doc) {
      const slotMap = new Map<TaskSlot, SlotConfig>()
      for (const slot of doc.slots) {
        if (slot.isActive) {
          slotMap.set(slot.taskSlot, slot)
        }
      }
      _cache = { routingEnabled: doc.routingEnabled, slots: slotMap, loadedAt: Date.now() }
      // Fire-and-forget Redis write guarded by TWO epoch checks:
      //   (1) in-process: same-Lambda invalidate mid-load
      //   (2) Redis-shared: cross-Lambda invalidate mid-load (CAS
      //       against the epoch we captured at load-start)
      // Don't await — a cache-write delay should never extend the
      // response latency of the request that just forced Mongo.
      if (_invalidationEpoch === loadStartEpoch) {
        void writeToRedis(_cache, capturedRedisEpoch)
      } else {
        aiLogger.info(
          { event: 'model_config_write_skip_stale', loadStartEpoch, currentEpoch: _invalidationEpoch },
          'ModelRouter: skipped Redis write — same-Lambda invalidation during load',
        )
      }
    } else {
      // No ModelConfig doc in Mongo — routing disabled. Intentionally
      // NOT written to Redis: caching "no config" would mask a genuine
      // operator misconfiguration and prevent the next ping from
      // re-checking Mongo.
      _cache = { routingEnabled: false, slots: new Map(), loadedAt: Date.now() }
    }
    _lastLoadSource = 'L3-Mongo'
  } catch (err) {
    aiLogger.warn({ err }, 'ModelRouter: failed to load config from DB, using hardcoded defaults')
    if (!_cache) {
      _cache = { routingEnabled: false, slots: new Map(), loadedAt: Date.now() }
    }
    _lastLoadSource = 'L3-Mongo-error'
  }
}

async function ensureConfig(): Promise<CachedConfig> {
  if (_cache && Date.now() - _cache.loadedAt < CACHE_TTL_MS) {
    return _cache
  }
  // Measure total time to populate `_cache` — everything from this line
  // onwards is either an L2 hit (~few ms) or an L3 round-trip (hundreds
  // of ms for Mongo read + connectDB setup on cold Lambda). The log
  // below is THE validation signal for PR A: Vercel `level:info` log
  // searches can pivot on `event:model_config_load` and confirm whether
  // cold Lambdas are actually hitting Redis (source:L2-Redis,
  // durationMs<50) vs. falling through to Mongo (source:L3-Mongo,
  // durationMs>500). Logged at info because it's cold-path only — L1
  // hits short-circuit above and never emit this line.
  const startMs = Date.now()
  if (!_loadPromise) {
    _loadPromise = loadConfig().finally(() => { _loadPromise = null })
  }
  await _loadPromise
  aiLogger.info(
    {
      event: 'model_config_load',
      source: _lastLoadSource,
      durationMs: Date.now() - startMs,
    },
    'ModelRouter: config loaded',
  )
  return _cache!
}

/**
 * Invalidate both the in-memory L1 cache (this process) and the Redis L2
 * cache (all processes). Called from the CMS /api/cms/model-config PUT
 * handler so a config change propagates to every Lambda on the next
 * `ensureConfig()` call — no 60s TTL wait across the cluster.
 *
 * Redis DEL is fire-and-forget: a DEL failure would leave stale data in
 * Redis for up to 60s (TTL floor) — acceptable degradation, since L1 on
 * the PUT-handling Lambda is invalidated synchronously and users hitting
 * other Lambdas experience at most a 60-second stale window.
 */
export function invalidateModelConfigCache(): void {
  _cache = null
  // Bump BEFORE any async Redis ops. Any in-flight loadConfig on THIS
  // container captured the old in-process value at start; its write
  // check will see the mismatch and skip.
  _invalidationEpoch++
  const client = getRedisClient()
  if (!client) return
  // INCR the Redis-shared epoch BEFORE DEL'ing the cache — so in-flight
  // writers on OTHER Lambdas see the new epoch when they re-check even
  // if the DEL hasn't propagated yet. Both ops are fire-and-forget:
  // the CMS PUT handler must return 200 regardless of Redis health.
  void client.incr(REDIS_EPOCH_KEY).catch((err: unknown) => {
    aiLogger.warn({ err }, 'ModelRouter: Redis shared-epoch INCR failed')
  })
  void client.del(REDIS_CACHE_KEY).catch((err: unknown) => {
    aiLogger.warn({ err }, 'ModelRouter: Redis L2 cache invalidation failed')
  })
}

// ─── Resolve model for a task slot ──────────────────────────────────────────

export interface ResolvedModel {
  model: string
  maxTokens: number
  provider: string
  temperature?: number
  fallbackModel?: string
  fallbackProvider?: string
  useToonInput: boolean
}

export async function resolveModel(taskSlot: TaskSlot): Promise<ResolvedModel> {
  const config = await ensureConfig()
  const defaults = TASK_SLOT_DEFAULTS[taskSlot]

  if (!config.routingEnabled) {
    return { model: defaults.model, maxTokens: defaults.maxTokens, provider: defaults.provider, useToonInput: false }
  }

  const slotConfig = config.slots.get(taskSlot)
  if (slotConfig) {
    return {
      model: slotConfig.model,
      maxTokens: slotConfig.maxTokens,
      provider: slotConfig.provider,
      temperature: slotConfig.temperature,
      fallbackModel: slotConfig.fallbackModel,
      fallbackProvider: slotConfig.fallbackProvider ?? 'anthropic',
      useToonInput: slotConfig.useToonInput ?? false,
    }
  }

  return { model: defaults.model, maxTokens: defaults.maxTokens, provider: defaults.provider, useToonInput: false }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface CompletionOptions {
  taskSlot: TaskSlot
  system: string | Array<{ type: 'text'; text: string; cache_control?: { type: string } }>
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  contextData?: Record<string, unknown>
  maxTokens?: number
  temperature?: number
}

export interface CompletionResult {
  text: string
  model: string
  provider: string
  inputTokens: number
  outputTokens: number
  usedFallback: boolean
  /**
   * True when the underlying provider indicated max_tokens was hit
   * mid-generation. Callers that care about complete output (e.g.
   * interview question generation) should inspect this and decide
   * whether to retry with a larger budget or fall back.
   * Undefined/absent when the provider didn't report the signal.
   */
  truncated?: boolean
}

async function prepareMessages(
  opts: CompletionOptions,
  resolved: ResolvedModel,
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  let messages = opts.messages
  if (opts.contextData && Object.keys(opts.contextData).length > 0) {
    const { encodeContextData } = await import('./toonEncoder')
    const suffix = resolved.useToonInput
      ? encodeContextData(opts.contextData)
      : '\n\n' + Object.entries(opts.contextData)
          .filter(([, v]) => v != null)
          .map(([k, v]) => `${k}:\n${JSON.stringify(v, null, 0)}`)
          .join('\n\n')

    messages = [...opts.messages]
    const lastIdx = messages.length - 1
    if (lastIdx >= 0 && messages[lastIdx].role === 'user') {
      messages[lastIdx] = { ...messages[lastIdx], content: messages[lastIdx].content + suffix }
    }
  }
  return messages
}

async function callProvider(
  providerName: string,
  model: string,
  system: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  maxTokens: number,
  temperature?: number,
): Promise<{ text: string; inputTokens: number; outputTokens: number; truncated?: boolean }> {
  // Dynamic import to avoid pulling all provider SDKs into client bundles
  const { getProvider } = await import('./providers/index')
  const provider = getProvider(providerName)
  if (!provider) {
    throw new Error(`Provider "${providerName}" not registered`)
  }
  if (!provider.isConfigured()) {
    throw new Error(`Provider "${providerName}" not configured (missing API key)`)
  }
  return provider.complete({ model, system, messages, maxTokens, temperature })
}

/**
 * Run a completion against the CMS-configured model for this task slot.
 *
 * Fallback chain:
 *   1. Primary model via configured provider
 *   2. Fallback model via fallback provider (can differ from primary)
 *   3. Hardcoded Anthropic default for this slot
 */
export async function completion(opts: CompletionOptions): Promise<CompletionResult> {
  const resolved = await resolveModel(opts.taskSlot)
  const maxTokens = opts.maxTokens ?? resolved.maxTokens
  const temperature = opts.temperature ?? resolved.temperature
  const system = typeof opts.system === 'string' ? opts.system : opts.system.map(b => b.text).join('\n\n')
  const messages = await prepareMessages(opts, resolved)

  // Attempt 1: primary model via configured provider
  try {
    const result = await callProvider(resolved.provider, resolved.model, system, messages, maxTokens, temperature)
    return { ...result, model: resolved.model, provider: resolved.provider, usedFallback: false }
  } catch (primaryErr) {
    aiLogger.warn({ err: primaryErr, taskSlot: opts.taskSlot, model: resolved.model, provider: resolved.provider },
      'ModelRouter: primary failed, trying fallback')
  }

  // Attempt 2: fallback model via fallback provider (may differ from primary)
  if (resolved.fallbackModel) {
    const fbProvider = resolved.fallbackProvider ?? 'anthropic'
    try {
      const result = await callProvider(fbProvider, resolved.fallbackModel, system, messages, maxTokens, temperature)
      return { ...result, model: resolved.fallbackModel, provider: fbProvider, usedFallback: true }
    } catch (fallbackErr) {
      aiLogger.warn({ err: fallbackErr, taskSlot: opts.taskSlot, fallbackModel: resolved.fallbackModel, fallbackProvider: fbProvider },
        'ModelRouter: fallback failed, trying hardcoded Anthropic default')
    }
  }

  // Attempt 3: task slot default (may be any provider — not always Anthropic)
  const defaults = TASK_SLOT_DEFAULTS[opts.taskSlot]
  const defaultProvider = defaults.provider ?? 'anthropic'
  if (resolved.model === defaults.model && resolved.provider === defaultProvider) {
    throw new Error(`ModelRouter: all attempts failed for ${opts.taskSlot}`)
  }

  const result = await callProvider(defaultProvider, defaults.model, system, messages, defaults.maxTokens, temperature)
  return { ...result, model: defaults.model, provider: defaultProvider, usedFallback: true }
}

/**
 * Streaming version of completion. Same fallback chain.
 */
export async function completionStream(opts: CompletionOptions): Promise<CompletionResult> {
  // For non-Anthropic providers, streaming uses the same path as completion
  // since the provider adapter handles the full request/response cycle.
  // For Anthropic specifically, we could use the streaming SDK, but
  // the adapter pattern abstracts this — callers get the same interface.
  return completion(opts)
}

// ─── Re-exports for backward compatibility ──────────────────────────────────

export { getAnthropicClient } from './providers/anthropic'
export { parseClaudeJSON } from './llmClient'
