import { gunzipSync } from 'zlib'
import { createHash, randomBytes } from 'crypto'
import type mongoose from 'mongoose'
import { JobApplication, JobPosting, type IJobPosting } from '@shared/db/models'
import { getActiveInterviewDomainCatalog, parseJobDescription } from '@interview'
import type { IParsedJobDescription } from '@shared/types'
import { interviewSlugForDomain } from '../config/domains'
import { jobPostingStateOf } from './postingAccess'
import { isJobsAccountActive } from '@shared/services/jobsAccountFence'
import { redis } from '@shared/redis'
import { logger } from '@shared/logger'

/**
 * Interview X-ray (PRODUCT_FLOW §2 detail route, Wave 3.1b) — ONE persisted
 * JD parse per posting, keyed by the normalized body hash (standing trap:
 * "one JD parse per job: key by JD hash on JobPosting, pass through the
 * hand-off — never two parsers"). The parser is the interview module's own
 * parseJobDescription (billed via the existing interview.jd-extract slot),
 * imported through the barrel — jobs never grows a second parser.
 *
 * Lazy + cached: the first authed detail view pays the parse; every later
 * view (and the Wave-4 practice hand-off) reads JobPosting.parsedJD. A
 * merge that replaces the JD changes the hash and the next view re-parses.
 * A Redis owner-token lock serializes cache misses across app instances.
 * The JD-version-bound Mongo CAS remains the persisted first-write fence.
 */

/**
 * Dedicated X-ray key — NOT bodyHashOf: that one carries mass-repost
 * semantics (null under 100 chars, 2000-char slice). Reusing it here meant
 * short-JD postings re-parsed on EVERY view (unbounded LLM spend) and JD
 * edits beyond char 2000 never re-parsed. This hash is unconditional and
 * covers the full body the parser actually sees.
 */
export function xrayHashOf(jd: string): string {
  // Whitespace-insensitive (PR-C, founder item 7): the display-formatted
  // JD (jdDisplayCompressed — newlines preserved) and the hash-canonical
  // collapsed body are the SAME JD version. Every input this hash has
  // ever stored was already whitespace-collapsed, so the collapse below
  // is a no-op for all existing parsedJDHash / atsResult.jdHash /
  // evidence xrayHash values (pinned by test) — while sessions that
  // capture display-shaped text via the practice hand-off keep hashing
  // equal to the posting's parse. Version detection is about CONTENT,
  // not whitespace shape.
  return createHash('sha1').update(jd.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 20)
}

/** The pre-collapse hash form (raw bytes). Stored atsResult.resumeHash
 *  values predate the whitespace collapse and were computed on RAW resume
 *  text — resumes carry newlines, unlike stored JD bodies where the
 *  collapse is a no-op (Codex #541). Comparison sites accept BOTH forms so
 *  legacy ATS results stay valid; every new WRITE uses xrayHashOf, so the
 *  corpus converges and this stays comparison-only. */
export function legacyXrayHashOf(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 20)
}

/** rawText is deliberately ABSENT: persisting the parser's echo of the full
 *  JD would duplicate every posting's body uncompressed inside parsedJD and
 *  survive retention slimming after jdCompressed is stripped (Codex on
 *  #518). Consumers that need the JD text read jdCompressed. */
export type XrayParsed = Omit<IParsedJobDescription, 'rawText'>

export interface XrayResult {
  parsed: XrayParsed
  cached: boolean
  /** Practice role authority is temporarily unresolved; evidence may still be stable. */
  retryable?: boolean
}

const XRAY_PARSE_LOCK_TTL_MS = 120_000
const XRAY_PARSE_LOCK_WAIT_MS = 30_000
const XRAY_PARSE_LOCK_RETRY_MS = 500
const XRAY_PARSE_LOCK_RENEW_MS = 30_000
const XRAY_PARSE_LOCK_PREFIX = 'jobs:xray:parse:'

interface XrayParseLock {
  lockKey: string
  lockValue: string
}

type XrayParseLockAcquisition =
  | { status: 'acquired'; lock: XrayParseLock; contended: boolean }
  | { status: 'timeout' | 'unavailable' }

function retryableXrayResult(parsed?: XrayParsed): XrayResult {
  return {
    parsed: parsed ?? {
      company: '',
      role: '',
      inferredDomain: '',
      requirements: [],
      keyThemes: [],
    },
    cached: !!parsed,
    retryable: true,
  }
}

async function acquireXrayParseLock(
  jobPostingId: string,
  jdHash: string,
): Promise<XrayParseLockAcquisition> {
  const lockKey = `${XRAY_PARSE_LOCK_PREFIX}${jobPostingId}:${jdHash}`
  const lockValue = randomBytes(16).toString('hex')
  const deadline = Date.now() + XRAY_PARSE_LOCK_WAIT_MS
  let contended = false

  while (true) {
    try {
      const result = await redis.set(
        lockKey,
        lockValue,
        'PX',
        XRAY_PARSE_LOCK_TTL_MS,
        'NX',
      )
      if (result === 'OK') {
        return { status: 'acquired', lock: { lockKey, lockValue }, contended }
      }
    } catch (err) {
      logger.warn(
        { err, jobPostingId },
        'acquireXrayParseLock: Redis unavailable; declining duplicate-risk parse',
      )
      return { status: 'unavailable' }
    }

    contended = true
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) return { status: 'timeout' }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(XRAY_PARSE_LOCK_RETRY_MS, remainingMs))
    })
  }
}

async function releaseXrayParseLock(lock: XrayParseLock): Promise<void> {
  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `
  try {
    await redis.eval(script, 1, lock.lockKey, lock.lockValue)
  } catch (err) {
    logger.warn(
      { err, lockKey: lock.lockKey },
      'releaseXrayParseLock: Redis unavailable; lock will expire',
    )
  }
}

function startXrayParseLockHeartbeat(lock: XrayParseLock): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const schedule = () => {
    timer = setTimeout(() => {
      void (async () => {
        try {
          const renewed = await redis.eval(
            `
              if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("pexpire", KEYS[1], ARGV[2])
              else
                return 0
              end
            `,
            1,
            lock.lockKey,
            lock.lockValue,
            XRAY_PARSE_LOCK_TTL_MS,
          )
          if (renewed !== 1) {
            stopped = true
            logger.warn(
              { lockKey: lock.lockKey },
              'startXrayParseLockHeartbeat: lock ownership lost while parsing',
            )
          }
        } catch (err) {
          logger.warn(
            { err, lockKey: lock.lockKey },
            'startXrayParseLockHeartbeat: Redis renewal failed',
          )
        }
        if (!stopped) schedule()
      })()
    }, XRAY_PARSE_LOCK_RENEW_MS)
    timer.unref?.()
  }

  schedule()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}

export async function getOrParseXray(
  jobPostingId: string,
  userId?: string | null,
): Promise<XrayResult | null> {
  return getOrParseXrayVersion(jobPostingId, true, userId)
}

function inflateCanonicalJd(value: unknown): string {
  try {
    const buf = value as Buffer | undefined
    return buf?.length
      ? gunzipSync(Buffer.isBuffer(buf)
        ? buf
        : Buffer.from((buf as { buffer: ArrayBufferLike }).buffer as ArrayBuffer)).toString('utf8')
      : ''
  } catch {
    return ''
  }
}

function hasDeclaredDomain(value: unknown): boolean {
  return value !== undefined && value !== null && value !== ''
}

function exactRoleVersionCondition(
  value: unknown,
): mongoose.QueryFilter<IJobPosting>['parsedJDRoleVersion'] {
  if (value === undefined) return { $exists: false }
  if (value === null) {
    return { $eq: null, $exists: true } as mongoose.QueryFilter<IJobPosting>['parsedJDRoleVersion']
  }
  return String(value)
}

function exactXraySnapshotFilter(doc: {
  _id: unknown
  status: unknown
  closedReason?: unknown
  domain?: unknown
  jdCompressed?: unknown
  parsedJDHash?: unknown
  parsedJDRoleVersion?: unknown
  parsedJD?: unknown
}): Record<string, unknown> {
  return {
    _id: doc._id,
    status: doc.status,
    closedReason: doc.closedReason ?? null,
    domain: doc.domain ?? null,
    jdCompressed: doc.jdCompressed,
    parsedJDHash: doc.parsedJDHash ?? null,
    parsedJDRoleVersion: doc.parsedJDRoleVersion ?? null,
    parsedJD: doc.parsedJD == null
      ? null
      : { $exists: true, $ne: null },
  }
}

async function getOrParseXrayVersion(
  jobPostingId: string,
  allowVersionRetry: boolean,
  userId?: string | null,
): Promise<XrayResult | null> {
  const doc = await JobPosting.findById(jobPostingId)
    .select('domain jdCompressed parsedJD parsedJDHash parsedJDRoleVersion status closedReason')
    .lean()
  if (!doc || (doc.status !== 'open' && doc.status !== 'closed')) return null
  const postingState = jobPostingStateOf(doc)
  if (postingState === 'restricted') return null
  // Archived X-rays are owner-only historical evidence. Never invoke the
  // parser or refresh taxonomy on a closed row: if the exact retained JD was
  // not parsed while live, there is no saved X-ray to serve.
  if (postingState === 'archived') {
    if (!userId) return null
    const application = await JobApplication.exists({ userId, jobPostingId })
    if (!application) return null
  }

  const jd = inflateCanonicalJd(doc.jdCompressed)
  if (!jd) return null

  const hash = xrayHashOf(jd)
  if (postingState === 'archived') {
    if (!doc.parsedJD || doc.parsedJDHash !== hash) return null
    // Ownership and posting authority are separate mutable claims. Recheck
    // both after the first owner lookup before returning cached evidence; a
    // revoke or tracker deletion during that await must beat stale content.
    const [sameApplication, samePosting] = await Promise.all([
      JobApplication.exists({ userId, jobPostingId }),
      JobPosting.exists(exactXraySnapshotFilter(doc)),
    ])
    return sameApplication && samePosting
      ? { parsed: doc.parsedJD as XrayParsed, cached: true }
      : null
  }
  const activeCatalog = await getActiveInterviewDomainCatalog()
  const hasCurrentBodyParse = !!doc.parsedJD && doc.parsedJDHash === hash
  if (hasCurrentBodyParse) {
    const stableParsed = doc.parsedJD as XrayParsed
    if (!activeCatalog.authoritative) {
      // Preserve useful evidence during a CMS outage, but never refresh or
      // authorize a role from the seeded availability fallback.
      return await JobPosting.exists(exactXraySnapshotFilter(doc))
        ? { parsed: stableParsed, cached: true, retryable: true }
        : null
    }
    // An explicit posting domain is the Practice classification authority.
    // Whether active (ready) or inactive/malformed (unsupported), there is no
    // reason to spend an LLM call refreshing a lower-precedence inferred role.
    if (hasDeclaredDomain(doc.domain)) {
      return await JobPosting.exists(exactXraySnapshotFilter(doc))
        ? { parsed: stableParsed, cached: true }
        : null
    }
    if (doc.parsedJDRoleVersion === activeCatalog.revision) {
      return await JobPosting.exists(exactXraySnapshotFilter(doc))
        ? { parsed: stableParsed, cached: true }
        : null
    }
  }

  // Catalog lookup and cache reconciliation can yield while a legal source
  // revoke closes the posting. Re-authorize the exact live JD immediately
  // before the external parser call; a committed revoke or body replacement
  // therefore blocks stale JD egress. The provider boundary itself cannot be
  // made transactional with Mongo, so the post-parse CAS remains mandatory.
  const authorizeParserProvider = async () => {
    const postingStillAuthorized = Boolean(await JobPosting.exists({
      _id: jobPostingId,
      status: 'open',
      jdCompressed: doc.jdCompressed,
    }))
    if (!postingStillAuthorized) return false
    return !userId || isJobsAccountActive(userId)
  }
  const stillAuthorized = await authorizeParserProvider()
  if (!stillAuthorized) {
    return allowVersionRetry
      ? getOrParseXrayVersion(jobPostingId, false, userId)
      : null
  }

  const retryableFallback = retryableXrayResult(
    hasCurrentBodyParse ? doc.parsedJD as XrayParsed : undefined,
  )
  const acquisition = await acquireXrayParseLock(jobPostingId, hash)
  if (acquisition.status !== 'acquired') {
    return reconcileCurrentXray(
      jobPostingId,
      hash,
      allowVersionRetry,
      userId,
      retryableFallback,
    )
  }

  // A waiter never starts a second provider call for the same cold wave.
  // Once the holder releases, reconcile its durable winner; if it failed
  // before persisting, return the existing retryable state for a later view.
  if (acquisition.contended) {
    await releaseXrayParseLock(acquisition.lock)
    return reconcileCurrentXray(
      jobPostingId,
      hash,
      allowVersionRetry,
      userId,
      retryableFallback,
    )
  }

  let lockReleased = false
  let stopLockHeartbeat: (() => void) | undefined
  const releaseAcquiredLock = async () => {
    if (lockReleased) return
    lockReleased = true
    await releaseXrayParseLock(acquisition.lock)
  }
  const stopAndReleaseAcquiredLock = async () => {
    stopLockHeartbeat?.()
    stopLockHeartbeat = undefined
    await releaseAcquiredLock()
  }
  try {
    // The cache decision happened before Redis acquisition. A prior holder
    // may have persisted and released in that gap, so bind the provider call
    // to the exact snapshot we originally authorized.
    if (!(await JobPosting.exists(exactXraySnapshotFilter(doc)))) {
      await stopAndReleaseAcquiredLock()
      return reconcileCurrentXray(
        jobPostingId,
        hash,
        allowVersionRetry,
        userId,
        retryableFallback,
      )
    }

    stopLockHeartbeat = startXrayParseLockHeartbeat(acquisition.lock)

  let parsedByModel: Awaited<ReturnType<typeof parseJobDescription>>
  try {
    parsedByModel = await parseJobDescription(
      jd,
      activeCatalog,
      authorizeParserProvider,
    )
  } catch (err) {
    // A provider-boundary denial means the exact posting snapshot lost
    // authority after the precheck. Re-enter the existing bounded lifecycle
    // reconciliation once so a replacement version can win; a committed
    // close/revoke returns null. Ordinary parser errors keep their established
    // behavior and are never hidden here.
    if (!(err instanceof Error) || err.name !== 'ModelProviderPreconditionError') {
      throw err
    }
    await stopAndReleaseAcquiredLock()
    return allowVersionRetry
      ? getOrParseXrayVersion(jobPostingId, false, userId)
      : null
  }
  if (userId && !(await isJobsAccountActive(userId))) return null
  const { rawText: _omit, ...extracted } = parsedByModel
  const parserFallback = extracted.requirements.length === 0 && extracted.keyThemes.length === 0

  if (hasCurrentBodyParse) {
    // The JD requirements are already evidence-bound. A taxonomy/prompt/CMS
    // revision refreshes ONLY the inferred role, never requirement IDs.
    const stableParsed = doc.parsedJD as XrayParsed
    const refreshed = { ...stableParsed, inferredDomain: extracted.inferredDomain }
    if (!extracted.inferredDomain) {
      await stopAndReleaseAcquiredLock()
      return reconcileCurrentXray(
        jobPostingId,
        hash,
        allowVersionRetry,
        userId,
        { parsed: stableParsed, cached: false, retryable: true },
      )
    }
    const write = await JobPosting.updateOne(
      {
        _id: jobPostingId,
        status: 'open',
        jdCompressed: doc.jdCompressed,
        parsedJDHash: hash,
        // Bind the CAS to the exact catalog revision read. A slower request
        // using catalog A must not overwrite a newer catalog-B winner.
        parsedJDRoleVersion: exactRoleVersionCondition(doc.parsedJDRoleVersion),
      },
      {
        $set: {
          'parsedJD.inferredDomain': extracted.inferredDomain,
          parsedJDRoleVersion: activeCatalog.revision,
        },
      },
    )
    if (write.modifiedCount > 0) return { parsed: refreshed, cached: false }
    await stopAndReleaseAcquiredLock()
    return reconcileCurrentXray(
      jobPostingId,
      hash,
      allowVersionRetry,
      userId,
      { parsed: stableParsed, cached: false, retryable: true },
    )
  }

  // The parser NEVER throws — model/JSON failures return an all-empty
  // fallback (no requirements, no themes). Caching that would pin a blank
  // X-ray to this hash forever; serve it for THIS view but leave the row
  // unparsed so a later view retries (Codex on #518). A genuine parse of a
  // real JD always carries at least one requirement or theme.
  if (!parserFallback) {
    const canPersistInferredRole = activeCatalog.authoritative && !!extracted.inferredDomain
    const persistedParse = canPersistInferredRole
      ? extracted
      : { ...extracted, inferredDomain: '' }
    // FIRST-WRITE-WINS per hash (READINESS.md §1, panel R11): evidence
    // rows bind to this parse's requirement ids — a same-hash re-parse
    // (cache-miss race) must never replace the ids they point at.
    const $set: Record<string, unknown> = {
      parsedJD: persistedParse,
      parsedJDHash: hash,
      ...(canPersistInferredRole
        ? { parsedJDRoleVersion: activeCatalog.revision }
        : {}),
    }
    const write = await JobPosting.updateOne(
      {
        _id: jobPostingId,
        status: 'open',
        jdCompressed: doc.jdCompressed,
        $or: [
          { parsedJDHash: { $ne: hash } },
          { parsedJD: { $exists: false } },
          { parsedJD: null },
        ],
      },
      {
        $set,
        ...(!canPersistInferredRole ? { $unset: { parsedJDRoleVersion: 1 } } : {}),
      }
    )
    if (write.modifiedCount > 0) {
      const roleRetryable = !activeCatalog.authoritative ||
        (!hasDeclaredDomain(doc.domain) && !extracted.inferredDomain)
      return {
        parsed: persistedParse,
        cached: false,
        ...(roleRetryable ? { retryable: true } : {}),
      }
    }
  }
  await stopAndReleaseAcquiredLock()
  return reconcileCurrentXray(
    jobPostingId,
    hash,
    allowVersionRetry,
    userId,
    {
      parsed: activeCatalog.authoritative ? extracted : { ...extracted, inferredDomain: '' },
      cached: false,
      retryable: true,
    },
  )
  } finally {
    await stopAndReleaseAcquiredLock()
  }
}

async function reconcileCurrentXray(
  jobPostingId: string,
  expectedHash: string,
  allowVersionRetry: boolean,
  userId: string | null | undefined,
  sameVersionFallback: XrayResult,
): Promise<XrayResult | null> {
  // A concurrent parser, close, or JD replacement may win while the model is
  // running. Prefer the persisted winner, including over an empty fallback.
  const current = await JobPosting.findById(jobPostingId)
    .select('domain jdCompressed parsedJD parsedJDHash parsedJDRoleVersion status closedReason')
    .lean()
  if (!current || current.status !== 'open') return null
  const currentJd = inflateCanonicalJd(current.jdCompressed)
  if (!currentJd) return null
  const currentHash = xrayHashOf(currentJd)
  if (currentHash !== expectedHash) {
    return allowVersionRetry
      ? getOrParseXrayVersion(jobPostingId, false, userId)
      : null
  }
  if (current.parsedJD && current.parsedJDHash === currentHash) {
    // Re-read the live catalog after a lost CAS. This both recognizes a newer
    // taxonomy winner and prevents the losing request's snapshot from being
    // treated as current. Evidence is independently useful and always wins
    // over an empty same-hash fallback.
    const latestCatalog = await getActiveInterviewDomainCatalog()
    const parsed = current.parsedJD as XrayParsed
    const inferredRole = interviewSlugForDomain(
      parsed.inferredDomain,
      latestCatalog.slugSet,
    )
    const roleRetryable = !latestCatalog.authoritative || (
      !hasDeclaredDomain(current.domain) && (
        current.parsedJDRoleVersion !== latestCatalog.revision || !inferredRole
      )
    )
    // The catalog re-read above can yield. Do not return its stale winner if a
    // source revoke, closure-policy edit, or JD replacement committed while
    // taxonomy was resolving.
    if (!(await JobPosting.exists(exactXraySnapshotFilter(current)))) return null
    return {
      parsed,
      cached: true,
      ...(roleRetryable ? { retryable: true } : {}),
    }
  }
  return sameVersionFallback
}
