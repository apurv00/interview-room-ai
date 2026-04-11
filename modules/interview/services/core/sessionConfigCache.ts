import { redis } from '@shared/redis'
import { logger } from '@shared/logger'
import { connectDB } from '@shared/db/connection'
import { User, InterviewDomain, InterviewDepth, EvaluationRubric } from '@shared/db/models'
import { isFeatureEnabled } from '@shared/featureFlags'

// ─── Cache Configuration ────────────────────────────────────────────────────

const TTL_SECONDS = 1800 // 30 min — matches the default session duration cap.

const cfgKey = (sessionId: string) => `session:cfg:${sessionId}`

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
}

const EMPTY_CONFIG: CachedSessionConfig = {
  domain: null,
  depth: null,
  rubric: null,
  userProfile: null,
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
  if (!isFeatureEnabled('session_config_cache')) return EMPTY_CONFIG

  // 1. Redis
  try {
    const cached = await redis.get(cfgKey(sessionId))
    if (cached) return JSON.parse(cached) as CachedSessionConfig
  } catch (err) {
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

    const [domainResult, depthResult, userResult, rubricResult] = await Promise.allSettled([
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
    ])

    const config: CachedSessionConfig = {
      domain: domainResult.status === 'fulfilled' ? (domainResult.value as Record<string, unknown> | null) : null,
      depth: depthResult.status === 'fulfilled' ? (depthResult.value as Record<string, unknown> | null) : null,
      rubric: rubricResult.status === 'fulfilled' ? (rubricResult.value as Record<string, unknown> | null) : null,
      userProfile: userResult.status === 'fulfilled' ? (userResult.value as Record<string, unknown> | null) : null,
    }

    // Only cache when at least one field was successfully populated.
    // An all-null result may reflect transient DB errors — avoid hiding them
    // from retries for 30 minutes.
    const hasData = config.domain !== null || config.depth !== null || config.userProfile !== null
    if (hasData) {
      try {
        await redis.setex(cfgKey(sessionId), TTL_SECONDS, JSON.stringify(config))
      } catch (err) {
        logger.warn({ err, sessionId }, 'getOrLoadSessionConfig: redis write failed')
      }
    }

    return config
  } catch (err) {
    logger.warn({ err, sessionId }, 'getOrLoadSessionConfig: Mongo fetch failed')
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
