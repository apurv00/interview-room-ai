import { redis } from '@shared/redis'
import { logger } from '@shared/logger'
import { connectDB } from '@shared/db/connection'
import { User, InterviewDomain, InterviewDepth, EvaluationRubric, InterviewSession } from '@shared/db/models'
import { isFeatureEnabled } from '@shared/featureFlags'
import type { IParsedJobDescription } from '@shared/db/models/SavedJobDescription'

// ─── Cache Configuration ────────────────────────────────────────────────────

const TTL_SECONDS = 1800 // 30 min — matches the default session duration cap.

const cfgKey = (sessionId: string) => `session:cfg:${sessionId}`

/**
 * Which layer served the most recent `getOrLoadSessionConfig` call.
 * Surfaced in the `event:session_config_load` telemetry log so ops can
 * answer "are long interviews hitting redis continuously, or thrashing
 * through the Mongo fallback because the TTL expired mid-flow?"
 *
 * PR B (follow-up to PR #303 ModelConfig parity): session cache was
 * already Redis-first but had NO observability and NO TTL refresh,
 * so interviews running longer than 30 minutes silently fell through
 * to Mongo on every Q-turn after the cache expired. Both problems
 * fixed in this module.
 */
type ConfigLoadSource =
  | 'redis-hit'    // cache hit on Redis; TTL refreshed in fire-and-forget. The happy path.
  | 'mongo-hit'    // Redis miss, Mongo read succeeded, wrote to Redis. Expected on Q1 of a session.
  | 'mongo-error'  // Mongo read failed — empty config returned. Alert-worthy.
  | 'feature-off'  // session_config_cache flag disabled — never touched Redis or Mongo.
  | 'empty'        // Redis miss + all 4 parallel Mongo fetches returned null. Bad sessionId?
  | 'redis-error'  // Redis outage on the read. Degraded gracefully; not cached.

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Serialisable snapshot of the four per-session "static" documents:
 * domain, depth, rubric, and user profile. Fields are preserved as plain
 * objects after `.lean()` + `JSON.parse`, so ObjectId fields will be hex
 * strings — callers only access string/number content fields, never ObjectIds.
 */
export interface CachedSessionConfig {
  domain: Record<string, unknown> | null
  depth: Record<string, unknown> | null
  /** null when rubric_registry feature flag is off or no matching rubric exists */
  rubric: Record<string, unknown> | null
  userProfile: Record<string, unknown> | null
  /**
   * Structured parsed job description for this session, if one has been
   * parsed and persisted to InterviewSession.parsedJobDescription. Null when
   * the session has no JD, or when the fire-and-forget parse (see
   * documentContextCache.getOrLoadJDContext) is still in flight.
   *
   * Phase 1 of JD overlay wiring: exposes the field here so downstream
   * callers (flow resolver — Phase 4) can project it into a JDOverlay
   * without a second Mongo round trip. No reader yet.
   */
  parsedJD: IParsedJobDescription | null
}

const EMPTY_CONFIG: CachedSessionConfig = {
  domain: null,
  depth: null,
  rubric: null,
  userProfile: null,
  parsedJD: null,
}

// ─── Cache-First Loader ─────────────────────────────────────────────────────

/**
 * Cache-first session config loader.
 *
 * Fetches InterviewDomain, InterviewDepth, EvaluationRubric, and the user
 * profile in one parallel Mongo round-trip, then caches the result in Redis
 * for the session lifetime (30 min). Subsequent calls for the same sessionId
 * return immediately from Redis without touching Mongo.
 *
 * Resolution order:
 *   1. Feature-flag kill-switch off → return EMPTY_CONFIG (callers fall back
 *      to their existing inline Mongo queries)
 *   2. Redis hit → return parsed config
 *   3. Mongo fetch (4 queries in parallel via Promise.allSettled) → cache → return
 *   4. Any unrecoverable error → return EMPTY_CONFIG (fail-open)
 */
export async function getOrLoadSessionConfig(
  sessionId: string,
  opts: { role: string; interviewType: string; userId: string; experience: string },
): Promise<CachedSessionConfig> {
  const startMs = Date.now()

  if (!isFeatureEnabled('session_config_cache')) {
    logger.info(
      { event: 'session_config_load', sessionId, source: 'feature-off', durationMs: Date.now() - startMs },
      'SessionConfig: feature flag off',
    )
    return EMPTY_CONFIG
  }

  // 1. Redis
  let redisErrored = false
  try {
    const cached = await redis.get(cfgKey(sessionId))
    if (cached) {
      // Parse FIRST, then log + refresh TTL. If the cached value is
      // corrupted JSON (schema drift, partial write, garbage) we must
      // NOT emit `redis-hit` — that would produce contradictory
      // telemetry (one request logging both redis-hit AND the eventual
      // mongo-hit/redis-error fallback). The JSON.parse throw is
      // caught by the outer handler which sets redisErrored=true so
      // the Mongo-path log below correctly reports source=redis-error.
      // Codex P2 on PR #304.
      const parsed = JSON.parse(cached) as CachedSessionConfig
      // Refresh TTL on every hit so interviews running longer than the
      // initial 30-min window don't silently fall through to Mongo
      // mid-flow when the candidate hits Q4/Q5 past the 30-min mark.
      // Fire-and-forget: an EXPIRE failure shouldn't delay the response,
      // and worst case the cache expires normally on TTL later.
      void redis
        .expire(cfgKey(sessionId), TTL_SECONDS)
        .catch((err) =>
          logger.warn({ err, sessionId }, 'getOrLoadSessionConfig: TTL refresh failed (non-fatal)'),
        )
      logger.info(
        {
          event: 'session_config_load',
          sessionId,
          source: 'redis-hit',
          durationMs: Date.now() - startMs,
          ttlExtended: true,
        },
        'SessionConfig: redis hit',
      )
      return parsed
    }
  } catch (err) {
    redisErrored = true
    logger.warn({ err, sessionId }, 'getOrLoadSessionConfig: redis read failed')
  }

  // 2. Mongo — four queries in parallel; individual failures degrade gracefully
  try {
    await connectDB()

    const rubricQuery = isFeatureEnabled('rubric_registry')
      ? EvaluationRubric.findOne({
          $or: [
            { domain: opts.role, interviewType: opts.interviewType, seniorityBand: opts.experience, isActive: true },
            { domain: opts.role, interviewType: opts.interviewType, seniorityBand: '*', isActive: true },
            { domain: '*', interviewType: opts.interviewType, seniorityBand: '*', isActive: true },
            { domain: '*', interviewType: '*', seniorityBand: '*', isActive: true },
          ],
        })
          .sort({ version: -1 })
          .lean()
      : Promise.resolve(null)

    const [domainResult, depthResult, userResult, rubricResult, jdResult] = await Promise.allSettled([
      InterviewDomain.findOne({ slug: opts.role, isActive: true }).lean(),
      InterviewDepth.findOne({ slug: opts.interviewType, isActive: true }).lean(),
      User.findById(opts.userId)
        .select(
          'currentTitle currentIndustry isCareerSwitcher switchingFrom targetCompanyType ' +
          'weakAreas topSkills educationLevel yearsInCurrentRole communicationStyle ' +
          'targetCompanies practiceStats interviewGoal feedbackPreference',
        )
        .lean(),
      rubricQuery,
      InterviewSession.findById(sessionId).select('parsedJobDescription').lean(),
    ])

    const config: CachedSessionConfig = {
      domain: domainResult.status === 'fulfilled' ? (domainResult.value as Record<string, unknown> | null) : null,
      depth: depthResult.status === 'fulfilled' ? (depthResult.value as Record<string, unknown> | null) : null,
      rubric: rubricResult.status === 'fulfilled' ? (rubricResult.value as Record<string, unknown> | null) : null,
      userProfile: userResult.status === 'fulfilled' ? (userResult.value as Record<string, unknown> | null) : null,
      // parsedJD is undefined on sessions whose JD hasn't been parsed yet
      // (fire-and-forget still running) or whose session has no JD at all —
      // coalesce both to null so the cache shape is stable.
      parsedJD:
        jdResult.status === 'fulfilled' && jdResult.value
          ? (jdResult.value as { parsedJobDescription?: IParsedJobDescription }).parsedJobDescription ?? null
          : null,
    }

    // Only cache when at least one of the core fields was successfully populated.
    // An all-null result may reflect transient DB errors — avoid hiding them
    // from retries for 30 minutes. parsedJD is intentionally excluded from the
    // hasData gate: a session with only a parsed JD is exceptional, and caching
    // a config with all core fields null would hide transient DB errors for
    // those fields behind the presence of a JD.
    const hasData = config.domain !== null || config.depth !== null || config.userProfile !== null
    if (hasData) {
      try {
        await redis.setex(cfgKey(sessionId), TTL_SECONDS, JSON.stringify(config))
      } catch (err) {
        logger.warn({ err, sessionId }, 'getOrLoadSessionConfig: redis write failed')
      }
    }

    logger.info(
      {
        event: 'session_config_load',
        sessionId,
        // `redis-error` path takes precedence over `mongo-hit`/`empty`
        // in the log so ops can tell whether the fallthrough was from a
        // clean cache miss (first Q of session) or a Redis outage that
        // degraded the route to always-Mongo for this request.
        source: redisErrored ? 'redis-error' : hasData ? 'mongo-hit' : 'empty',
        durationMs: Date.now() - startMs,
      },
      'SessionConfig: mongo fallback',
    )

    return config
  } catch (err) {
    logger.warn({ err, sessionId }, 'getOrLoadSessionConfig: Mongo fetch failed')
    logger.info(
      {
        event: 'session_config_load',
        sessionId,
        source: 'mongo-error',
        durationMs: Date.now() - startMs,
      },
      'SessionConfig: mongo fetch threw',
    )
    return EMPTY_CONFIG
  }
}

/**
 * Eagerly warms the session config cache. Called as fire-and-forget from
 * `createSession()` immediately after the session document is persisted, so
 * the first `generate-question` call hits Redis instead of Mongo.
 *
 * Failures are non-fatal — route handlers fall back to inline Mongo queries.
 */
export function warmSessionConfigCache(
  sessionId: string,
  opts: { role: string; interviewType: string; userId: string; experience: string },
): void {
  void getOrLoadSessionConfig(sessionId, opts).catch((err) =>
    logger.warn({ err, sessionId }, 'warmSessionConfigCache: failed (non-fatal)'),
  )
}
