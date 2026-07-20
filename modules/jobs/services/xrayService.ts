import { gunzipSync } from 'zlib'
import { createHash } from 'crypto'
import type mongoose from 'mongoose'
import { JobApplication, JobPosting, type IJobPosting } from '@shared/db/models'
import { parseJobDescription } from '@interview'
import type { IParsedJobDescription } from '@shared/types'
import {
  getActiveInterviewDomainCatalog,
} from '@interview/services/persona/domainCatalogService'
import { interviewSlugForDomain } from '../config/domains'
import { jobPostingStateOf } from './postingAccess'

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
 * Two concurrent first-viewers may both parse, but a JD-version-bound CAS
 * preserves the first persisted result. The Redis NX lock stays in the
 * deferred backlog with the problem-generation one.
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
    return doc.parsedJD && doc.parsedJDHash === hash
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
      return { parsed: stableParsed, cached: true, retryable: true }
    }
    // An explicit posting domain is the Practice classification authority.
    // Whether active (ready) or inactive/malformed (unsupported), there is no
    // reason to spend an LLM call refreshing a lower-precedence inferred role.
    if (hasDeclaredDomain(doc.domain)) {
      return { parsed: stableParsed, cached: true }
    }
    if (doc.parsedJDRoleVersion === activeCatalog.revision) {
      return { parsed: stableParsed, cached: true }
    }
  }

  const { rawText: _omit, ...extracted } = await parseJobDescription(jd, activeCatalog)
  const parserFallback = extracted.requirements.length === 0 && extracted.keyThemes.length === 0

  if (hasCurrentBodyParse) {
    // The JD requirements are already evidence-bound. A taxonomy/prompt/CMS
    // revision refreshes ONLY the inferred role, never requirement IDs.
    const stableParsed = doc.parsedJD as XrayParsed
    const refreshed = { ...stableParsed, inferredDomain: extracted.inferredDomain }
    if (!extracted.inferredDomain) {
      return reconcileCurrentXray(
        jobPostingId,
        hash,
        allowVersionRetry,
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
    return reconcileCurrentXray(
      jobPostingId,
      hash,
      allowVersionRetry,
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
  return reconcileCurrentXray(
    jobPostingId,
    hash,
    allowVersionRetry,
    {
      parsed: activeCatalog.authoritative ? extracted : { ...extracted, inferredDomain: '' },
      cached: false,
      retryable: true,
    },
  )
}

async function reconcileCurrentXray(
  jobPostingId: string,
  expectedHash: string,
  allowVersionRetry: boolean,
  sameVersionFallback: XrayResult,
): Promise<XrayResult | null> {
  // A concurrent parser, close, or JD replacement may win while the model is
  // running. Prefer the persisted winner, including over an empty fallback.
  const current = await JobPosting.findById(jobPostingId)
    .select('domain jdCompressed parsedJD parsedJDHash parsedJDRoleVersion status')
    .lean()
  if (!current || current.status !== 'open') return null
  const currentJd = inflateCanonicalJd(current.jdCompressed)
  if (!currentJd) return null
  const currentHash = xrayHashOf(currentJd)
  if (currentHash !== expectedHash) {
    return allowVersionRetry
      ? getOrParseXrayVersion(jobPostingId, false)
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
    return {
      parsed,
      cached: true,
      ...(roleRetryable ? { retryable: true } : {}),
    }
  }
  return sameVersionFallback
}
