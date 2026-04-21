import { TASK_SLOT_DEFAULTS, type TaskSlot } from '@shared/services/taskSlots'
import { aiLogger } from '@shared/logger'
import { connectDB } from '@shared/db/connection'
import { ModelConfig } from '@shared/db/models/ModelConfig'
import { redis } from '@shared/redis'

// HISTORY: This module previously used `eval('require')('@shared/redis')`
// and `eval('require')('@shared/db/connection')` to dodge webpack
// bundling, because client code (app/interview/page.tsx) dynamically
// imported codingProblemGenerator → modelRouter, which pulled ioredis
// into the client chunk and broke `next build` (ioredis needs node's
// net/tls/dns). The eval pattern hid the import from webpack — but it
// ALSO failed at runtime in Vercel's serverless build because Node's
// native require doesn't resolve TypeScript path aliases (`@shared/*`).
// Result: loadConfig silently fell back to TASK_SLOT_DEFAULTS forever,
// CMS-driven model config was never read in production, and PR A's L2
// cache had nothing to cache. Discovered via the telemetry log added in
// PR A: every cold Lambda fired `MODULE_NOT_FOUND: '@shared/db/connection'`
// in production logs.
//
// FIX: codingProblemGenerator's call site moved behind a fetch boundary
// (`/api/code/generate-problem`), so client code no longer imports
// modelRouter — webpack's client builder never sees this file. Static
// imports below are now safe.
//
// Minimal subset of ioredis methods we need — matches the real client
// so tests and runtime see the same contract. Kept as a typed interface
// (instead of `typeof redis`) so the test override below can satisfy it
// without pulling ioredis into vitest.
interface RedisLike {
  get(key: string): Promise<string | null>
  setex(key: string, ttl: number, value: string): Promise<unknown>
  del(key: string): Promise<unknown>
  incr(key: string): Promise<number>
  mget(...keys: string[]): Promise<Array<string | null>>
  eval(script: string, numKeys: number, ...keysAndArgs: Array<string | number>): Promise<unknown>
}

// Test override hatch — see `__setRedisClientForTesting` below.
let _redisOverride: RedisLike | null = null

function getRedisClient(): RedisLike | null {
  if (_redisOverride) return _redisOverride
  // Short-circuit on the client side. Static imports above are tree-
  // shaken out of client bundles because nothing client-side imports
  // this module after the codingProblemGenerator fetch refactor — but
  // this guard remains as a defensive belt-and-suspenders.
  if (typeof window !== 'undefined') return null
  return redis as unknown as RedisLike
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

/**
 * Test-only: await the in-flight background config refresh (if any).
 * `ensureConfig()` used to `await _loadPromise` on every call, which
 * made it trivial for tests to assert on the telemetry log or the
 * resolved cache right after `await resolveModel(...)`. The 2026-04-21
 * refactor made that refresh fire-and-forget so user requests never
 * block on L2/L3 — tests that need to observe the background load
 * completing now call this helper.
 */
export async function __awaitBackgroundLoadForTesting(): Promise<void> {
  if (_loadPromise) await _loadPromise
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

/**
 * Atomic compare-and-set Lua script: SETEX the cache key ONLY if the
 * current epoch matches the captured one. Runs server-side as a single
 * operation — an invalidate INCR between "GET epoch" and "SETEX cache"
 * (the gap Codex flagged) is not possible because Redis executes the
 * whole script atomically with no interleaving. Returns 1 on write,
 * 0 on skip (epoch changed).
 *
 * KEYS[1] = cache key         (model-config:v1)
 * KEYS[2] = epoch key         (model-config:epoch:v1)
 * ARGV[1] = captured epoch    (string — may be the literal "nil" sentinel if the epoch didn't exist at load-start)
 * ARGV[2] = serialized value
 * ARGV[3] = TTL seconds
 */
const CAS_WRITE_LUA = `
local current = redis.call('get', KEYS[2])
local captured = ARGV[1]
if captured == 'nil' then captured = false end
if current == captured or (current == false and captured == false) then
  redis.call('setex', KEYS[1], ARGV[3], ARGV[2])
  return 1
end
return 0
`.trim()
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
  | 'L2-Redis'                 // Redis cache hit — the happy path this PR was scoped for
  | 'L3-Mongo'                 // Redis miss + Mongo read succeeded — expected on first cold Lambda after cache bust / deploy
  | 'L3-Mongo-error'           // Mongo read failed — defaults used, alert-worthy
  | 'cold-defaults-synthetic'  // 2026-04-21: cold Lambda served TASK_SLOT_DEFAULTS synchronously while background refresh loads (see ensureConfig)
  | 'defaults-client'          // typeof window !== 'undefined' branch — should never show in server logs
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
 * paying BOTH the Redis timeout AND the Mongo round-trip.
 *
 * Raised 200→500ms on 2026-04-21 after Vercel logs showed the 200ms cap
 * tripping on every cold Lambda: actual Upstash p50 from us-east-1 →
 * global replica was ~216ms over the measured window (Deepgram session
 * diagnostic run, logs tagged `event:model_config_load`). 500ms keeps
 * us well below the Mongo baseline (~1000ms cold) while no longer
 * hiding healthy L2 hits behind timeout-triggered Mongo reads.
 */
const REDIS_READ_TIMEOUT_MS = 500

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
 * Write the successfully-loaded cache to Redis with an atomic
 * compare-and-set epoch guard. Uses a Lua script so the epoch-check
 * and the SETEX happen as ONE operation on the Redis server — no
 * interleaving is possible, even under a concurrent invalidate
 * INCR+DEL on another Lambda.
 *
 * Earlier version had separate GET+SETEX commands with a racy window
 * between them (Codex re-flagged: "writeToRedis() now does an epoch
 * GET before a later SETEX, but those are separate Redis commands. If
 * invalidateModelConfigCache() interleaves between them, the stale
 * writer can still repopulate the cache"). Lua closes that window.
 *
 * Cost: 1 Redis EVAL per L3-Mongo success path (same round-trip count
 * as the previous GET+SETEX but atomic). Never throws — a Redis write
 * failure must not fail the request that just succeeded against Mongo.
 */
async function writeToRedis(cache: CachedConfig, capturedEpoch: string | null): Promise<void> {
  const client = getRedisClient()
  if (!client) return
  try {
    // `eval` KEYS: cache + epoch; ARGS: captured epoch, payload, TTL.
    // Lua treats `null` as absence; we pass the literal string 'nil'
    // as a sentinel so the script can distinguish "no captured epoch"
    // from "captured empty string". See CAS_WRITE_LUA for details.
    const result = await client.eval(
      CAS_WRITE_LUA,
      2,
      REDIS_CACHE_KEY,
      REDIS_EPOCH_KEY,
      capturedEpoch ?? 'nil',
      JSON.stringify(serializeForRedis(cache)),
      REDIS_TTL_SECONDS,
    )
    if (result === 0) {
      aiLogger.info(
        {
          event: 'model_config_write_skip_stale_cross_lambda',
          capturedEpoch,
        },
        'ModelRouter: skipped Redis write — cross-Lambda invalidation during load (atomic CAS)',
      )
    }
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
  const now = Date.now()
  const startMs = now

  // L1 fresh hit — return immediately. Steady-state path.
  if (_cache && now - _cache.loadedAt < CACHE_TTL_MS) {
    return _cache
  }

  // 2026-04-21 non-blocking refactor, Codex P2 follow-up on PR #308.
  //
  // The rule: NEVER block the user request on the connectDB + Mongo
  // round-trip (that's what caused the original 1-2.5s cold-path
  // regression documented below). BUT we still attempt L2 Redis
  // synchronously, because:
  //   a) tryLoadFromRedis is already bounded by withTimeout at
  //      REDIS_READ_TIMEOUT_MS (500ms), so the worst-case wait is
  //      safely inside the 5s client abort on /api/evaluate-answer.
  //   b) An L2 hit means Redis has the REAL CMS config — serving
  //      defaults instead would silently use the wrong model for any
  //      slot where CMS diverges from TASK_SLOT_DEFAULTS (e.g. after
  //      an operator swaps gpt-5.4-mini for claude-sonnet-4-6 in the
  //      CMS admin, or toggles routingEnabled). The initial version of
  //      this refactor skipped L2 on the user thread entirely and
  //      always returned TASK_SLOT_DEFAULTS on any cache miss — Codex
  //      flagged that as a correctness regression for the first call
  //      after invalidateModelConfigCache(), which is exactly when a
  //      fresh CMS save must take effect.
  //
  // So: try L2 synchronously (fast + correct). Fall through to a
  // background Mongo refresh + defaults ONLY when L2 misses / errors
  // / times out. The expensive path (connectDB TLS+SCRAM + Mongo read)
  // is never on the user thread.
  //
  // Historical context (original regression): pre-2026-04-21 this
  // function awaited `loadConfig()`, which on cold Lambdas with empty
  // Redis did tryLoadFromRedis + connectDB (~600ms-2s) + ModelConfig
  // .getConfig, adding ~1-2.5s of overhead before the LLM call. That
  // overhead reliably pushed /api/evaluate-answer past its 5s client
  // abort (useInterviewAPI.ts:148) — the client silently wrote fake
  // 50/50/50/50 scores into the evaluations array, and interviews
  // dead-ended at Q2/Q3. Session DB records on 2026-04-21 show 5 of
  // 8 sessions that day failed in exactly this pattern.
  const redisResult = await tryLoadFromRedis()
  if (redisResult.hit && _cache) {
    _lastLoadSource = 'L2-Redis'
    aiLogger.info(
      {
        event: 'model_config_load',
        source: _lastLoadSource,
        durationMs: Date.now() - startMs,
      },
      'ModelRouter: config loaded',
    )
    return _cache
  }

  // L2 miss (empty, bad shape, error, or timeout). Kick off a Mongo
  // refresh if none is already in flight — off the user thread.
  if (!_loadPromise) {
    const refreshStart = Date.now()
    _loadPromise = loadConfig()
      .then(() => {
        aiLogger.info(
          {
            event: 'model_config_load',
            source: _lastLoadSource,
            durationMs: Date.now() - refreshStart,
          },
          'ModelRouter: background config refresh complete',
        )
      })
      .catch((err) => {
        aiLogger.warn({ err }, 'ModelRouter: background config refresh threw unexpectedly')
      })
      .finally(() => { _loadPromise = null })
  }

  // Stale L1 (if any) is still usable while the refresh runs.
  if (_cache) return _cache

  // Genuine cold with empty L2. Return a synthetic disabled-routing
  // snapshot so `resolveModel()` falls through to TASK_SLOT_DEFAULTS
  // natively. This path is now narrow: only fires when _cache is null
  // AND L2 produced no data AND no L1-stale was available. Under
  // normal operation (post-deploy, once any one Lambda has populated
  // Redis), subsequent cold Lambdas hit the L2 branch above.
  _lastLoadSource = 'cold-defaults-synthetic'
  aiLogger.info(
    {
      event: 'model_config_load',
      source: _lastLoadSource,
      durationMs: Date.now() - startMs,
    },
    'ModelRouter: cold Lambda with empty L2, serving TASK_SLOT_DEFAULTS while background Mongo refresh loads',
  )
  return { routingEnabled: false, slots: new Map(), loadedAt: now }
}

/**
 * Invalidate both the in-memory L1 cache (this process) and the Redis L2
 * cache (all processes). Retained for tests and any non-CMS caller that
 * wants to force a cold reload.
 *
 * Production code path (CMS PUT) should prefer `replaceModelConfigCache`
 * below — it populates L1/L2 directly with the fresh doc instead of
 * clearing L2 and waiting for a background Mongo refresh. That closes
 * the window flagged by Codex P2 on PR #308 where cold Lambdas would
 * see L2 empty and serve TASK_SLOT_DEFAULTS between the DEL and the
 * next request's Mongo fetch.
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

/**
 * Replace the cache with a known-fresh config doc (the one just saved
 * by the CMS PUT handler). Closes the window Codex P2 flagged on PR
 * #308: the prior `invalidateModelConfigCache()` DEL'd L2, leaving
 * cold Lambdas in the gap between DEL and the next request's Mongo
 * refresh. During that gap, `ensureConfig()` saw L2 empty and served
 * `TASK_SLOT_DEFAULTS` while background Mongo loaded — so any CMS
 * change that diverged from defaults (routing toggle, provider swap,
 * non-default model) was silently ignored on the first request post-
 * save. This function writes L1/L2 directly, never leaving L2 empty.
 *
 * Atomicity:
 *   1. L1 update in-process: synchronous, no failure mode.
 *   2. Bump `_invalidationEpoch` so any in-flight `loadConfig()` that
 *      finishes after us refuses to overwrite L2 (its CAS check
 *      against `loadStartEpoch` now fails).
 *   3. `INCR` the Redis shared epoch — signals other Lambdas that
 *      their L1 is stale and must re-read L2 on next ensureConfig.
 *   4. `EVAL CAS_WRITE_LUA` with the post-INCR epoch as the captured
 *      value — atomically writes L2 iff the current Redis epoch still
 *      matches. A racing admin save would INCR past us; the CAS fails
 *      and the newer save wins. "Last save wins" is the correct
 *      semantic for concurrent admin edits.
 *
 * Failure mode: if Redis is unreachable, we still update L1 — the
 * admin's own Lambda sees the new config. Other Lambdas fall back to
 * the pre-fix behavior (cold → defaults briefly). That's strictly
 * better than the old code which ALSO failed the DEL silently AND had
 * the empty-L2 window. Admin caller should await to get best-effort
 * sync propagation but tolerate an eventual-consistency window.
 */
export async function replaceModelConfigCache(doc: {
  routingEnabled: boolean
  slots: Array<{
    taskSlot: string
    model: string
    provider: string
    fallbackModel?: string
    fallbackProvider?: string
    maxTokens: number
    temperature?: number
    isActive: boolean
    useToonInput?: boolean
  }>
}): Promise<void> {
  const slotMap = new Map<TaskSlot, SlotConfig>()
  for (const slot of doc.slots) {
    if (slot.isActive) {
      // Hydrate to the internal SlotConfig shape — useToonInput is
      // optional on the input (Zod/Mongoose may omit it) but required
      // on the internal SlotConfig. Default to false to match schema.
      slotMap.set(slot.taskSlot as TaskSlot, {
        taskSlot: slot.taskSlot,
        model: slot.model,
        provider: slot.provider,
        fallbackModel: slot.fallbackModel,
        fallbackProvider: slot.fallbackProvider,
        maxTokens: slot.maxTokens,
        temperature: slot.temperature,
        isActive: slot.isActive,
        useToonInput: slot.useToonInput ?? false,
      })
    }
  }
  const cache: CachedConfig = {
    routingEnabled: doc.routingEnabled,
    slots: slotMap,
    loadedAt: Date.now(),
  }
  _cache = cache
  _invalidationEpoch++
  _lastLoadSource = 'L3-Mongo'

  const client = getRedisClient()
  if (!client) return
  try {
    const newEpoch = await client.incr(REDIS_EPOCH_KEY)
    const result = await client.eval(
      CAS_WRITE_LUA,
      2,
      REDIS_CACHE_KEY,
      REDIS_EPOCH_KEY,
      String(newEpoch),
      JSON.stringify(serializeForRedis(cache)),
      REDIS_TTL_SECONDS,
    )
    if (result === 0) {
      aiLogger.info(
        { event: 'model_config_replace_skip_stale', newEpoch },
        'ModelRouter: skipped Redis write — concurrent admin save bumped epoch',
      )
    }
  } catch (err) {
    aiLogger.warn({ err }, 'ModelRouter: replaceModelConfigCache Redis write failed')
  }
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
