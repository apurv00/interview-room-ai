import { createHash, createHmac, timingSafeEqual } from 'crypto'
import { gunzipSync } from 'zlib'
import { isValidObjectId } from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { JobApplication, JobPosting, type IJobPosting } from '@shared/db/models'
import {
  INTERVIEW_JOB_DESCRIPTION_MAX_CHARS,
  INTERVIEW_TARGET_COMPANY_MAX_CHARS,
} from '@shared/interviewContract'
import { getActiveInterviewDomainCatalog } from '@interview/services/persona/domainCatalogService'
import { interviewSlugForDomain } from '../config/domains'
import { xrayHashOf } from './xrayService'
import { jobPostingStateOf } from './postingAccess'

const TOKEN_TYPE = 'jobs-practice'
const TOKEN_VERSION = 1
export const PRACTICE_HANDOFF_TTL_SECONDS = 30 * 60

interface PracticeHandoffPayload {
  v: typeof TOKEN_VERSION
  typ: typeof TOKEN_TYPE
  uid: string
  jid: string
  jdh: string
  iat: number
  exp: number
}

export interface ResolvedPracticeHandoff {
  jobId: string
  jobDescription: string
  jdHash: string
  company: string
  role?: string
  applicationId?: string
}

interface PracticePostingSnapshot {
  status?: IJobPosting['status']
  closedReason?: IJobPosting['closedReason']
  domain?: string | null
  parsedJD?: unknown
  parsedJDHash?: string | null
  parsedJDRoleVersion?: string | null
  jdCompressed?: unknown
  jdDisplayCompressed?: unknown
}

export interface PreparedPracticeHandoff {
  /** Safe text for both the detail page and the interview runtime. */
  jobDescription: string
  /** Present only when the canonical JD is readable. */
  jdHash?: string
  /** Present only when the canonical snapshot resolves through the closed taxonomy. */
  role?: string
}

/** Full-strength identity for the signed trust boundary (cache hashes stay SHA-1). */
export function practiceHandoffHashOf(jd: string): string {
  return createHash('sha256').update(jd.replace(/\s+/g, ' ').trim()).digest('hex')
}

function secret(): string {
  const value = process.env.NEXTAUTH_SECRET
  if (!value) throw new Error('NEXTAUTH_SECRET not configured — refusing to mint Jobs practice handoff')
  return value
}

function signature(payloadB64: string): Buffer {
  return createHmac('sha256', secret())
    .update(`jobs-practice-handoff:v1:${payloadB64}`)
    .digest()
}

function inflate(value: unknown): string {
  if (!value) return ''
  try {
    const buffer = Buffer.isBuffer(value)
      ? value
      : Buffer.from((value as { buffer: ArrayBufferLike }).buffer as ArrayBuffer)
    return gunzipSync(buffer).toString('utf8')
  } catch {
    return ''
  }
}

/**
 * One preparation contract for detail rendering, token minting, and token
 * resolution. The canonical gzip is the version authority; a display twin
 * may preserve formatting only when it normalizes to the same full hash.
 */
export async function preparePracticeHandoffPosting(
  posting: PracticePostingSnapshot,
): Promise<PreparedPracticeHandoff> {
  const canonicalJd = inflate(posting.jdCompressed)
  const displayJd = inflate(posting.jdDisplayCompressed)

  // A readable display twin remains useful for the job detail when the
  // canonical body is corrupt, but Practice stays unavailable because no
  // canonical version can be signed and re-resolved safely.
  if (!canonicalJd.trim()) return { jobDescription: displayJd || canonicalJd }

  const jdHash = practiceHandoffHashOf(canonicalJd)
  const matchingDisplay = displayJd && practiceHandoffHashOf(displayJd) === jdHash
  const jobDescription = matchingDisplay && displayJd.length <= INTERVIEW_JOB_DESCRIPTION_MAX_CHARS
    ? displayJd
    : canonicalJd
  // Detail may still show an oversized source document, but readiness is
  // withheld unless the exact text sent to the lobby passes its API schema.
  // Keep the canonical identity: Tailor and ATS accept larger inputs and
  // must not lose their exact-version binding merely because Practice has a
  // narrower transport contract.
  if (jobDescription.length > INTERVIEW_JOB_DESCRIPTION_MAX_CHARS) {
    return { jobDescription, jdHash }
  }
  const activeCatalog = await getActiveInterviewDomainCatalog()
  // Seed data remains useful for rendering selectors during a CMS outage,
  // but it cannot prove that an operator has not deactivated a role. Practice
  // therefore fails closed until a live CMS snapshot is available.
  if (!activeCatalog.authoritative) return { jobDescription, jdHash }

  const postingState = posting.status === 'closed'
    ? jobPostingStateOf({ status: posting.status, closedReason: posting.closedReason })
    : 'live'
  // Safety/legal closures never gain a role through a stale cached parse,
  // even when a caller accidentally reaches this shared preparation helper.
  if (postingState === 'restricted') return { jobDescription, jdHash }

  const hasDeclaredDomain = posting.domain !== undefined &&
    posting.domain !== null &&
    posting.domain !== ''
  const parsedDomain = (
    !hasDeclaredDomain &&
    posting.parsedJDHash === xrayHashOf(canonicalJd) &&
    (
      posting.parsedJDRoleVersion === activeCatalog.revision ||
      // Closed normal archives cannot refresh their X-ray without mutating
      // historical evidence. A same-JD inferred role may survive catalog
      // revision drift only while today's authoritative catalog still maps
      // that slug; interviewSlugForDomain below is the closed-set check.
      postingState === 'archived'
    )
  )
    ? (posting.parsedJD as { inferredDomain?: unknown } | null | undefined)?.inferredDomain
    : undefined
  const cachedParsedRole = typeof parsedDomain === 'string' ? parsedDomain : undefined
  // A declared domain is an explicit classification. If it is malformed or
  // CMS-inactive, do not bypass that operator decision with an inferred role.
  const role = hasDeclaredDomain
    ? interviewSlugForDomain(posting.domain, activeCatalog.slugSet)
    : interviewSlugForDomain(cachedParsedRole, activeCatalog.slugSet)

  return {
    jobDescription,
    jdHash,
    ...(role ? { role } : {}),
  }
}

/** Minted only from the authenticated full-detail projection. */
export function mintPracticeHandoffToken(
  input: { userId: string; jobId: string; jdHash: string },
  now = new Date()
): string {
  const iat = Math.floor(now.getTime() / 1000)
  const payload: PracticeHandoffPayload = {
    v: TOKEN_VERSION,
    typ: TOKEN_TYPE,
    uid: input.userId,
    jid: input.jobId,
    jdh: input.jdHash,
    iat,
    exp: iat + PRACTICE_HANDOFF_TTL_SECONDS,
  }
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${payloadB64}.${signature(payloadB64).toString('base64url')}`
}

function verifyPracticeHandoffToken(
  token: string,
  expectedUserId: string,
  now: Date
): PracticeHandoffPayload | null {
  if (!token || token.length > 2048) return null
  const dot = token.indexOf('.')
  if (dot <= 0 || dot !== token.lastIndexOf('.') || dot === token.length - 1) return null
  const payloadB64 = token.slice(0, dot)
  const signatureB64 = token.slice(dot + 1)

  let supplied: Buffer
  let payload: PracticeHandoffPayload
  try {
    supplied = Buffer.from(signatureB64, 'base64url')
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as PracticeHandoffPayload
  } catch {
    return null
  }
  const expected = signature(payloadB64)
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null

  const nowSeconds = Math.floor(now.getTime() / 1000)
  if (
    payload?.v !== TOKEN_VERSION ||
    payload.typ !== TOKEN_TYPE ||
    payload.uid !== expectedUserId ||
    typeof payload.jid !== 'string' ||
    !isValidObjectId(payload.jid) ||
    typeof payload.jdh !== 'string' ||
    !payload.jdh ||
    typeof payload.iat !== 'number' ||
    typeof payload.exp !== 'number' ||
    payload.iat > nowSeconds + 60 ||
    payload.exp <= nowSeconds ||
    payload.exp - payload.iat !== PRACTICE_HANDOFF_TTL_SECONDS
  ) return null
  return payload
}

/**
 * Verify the user-bound intent, then re-resolve JD and application identity
 * from server state. Browser job/JD/application fields are never authority.
 */
export async function resolvePracticeHandoff(
  token: string,
  userId: string,
  now = new Date()
): Promise<ResolvedPracticeHandoff | null> {
  let payload: PracticeHandoffPayload | null
  try {
    payload = verifyPracticeHandoffToken(token, userId, now)
  } catch {
    return null
  }
  if (!payload) return null

  await connectDB()
  const posting = await JobPosting.findById(payload.jid)
    .select('company domain status closedReason parsedJD parsedJDHash parsedJDRoleVersion jdCompressed jdDisplayCompressed')
    .lean()
  if (!posting || (posting.status !== 'open' && posting.status !== 'closed')) return null
  const postingState = jobPostingStateOf(posting)
  if (postingState === 'restricted') return null

  // A token minted while a posting was open must not become an archive
  // entitlement by itself. Once closed, the tracker row is the durable
  // ownership proof; resolve it before returning any saved JD context.
  let application = postingState === 'archived'
    ? await JobApplication.findOne({ userId, jobPostingId: payload.jid })
        .select('_id')
        .lean()
    : null
  if (postingState === 'archived' && !application) return null

  const prepared = await preparePracticeHandoffPosting(posting)
  if (!prepared.jdHash || prepared.jdHash !== payload.jdh) return null

  if (postingState === 'live') {
    application = await JobApplication.findOne({ userId, jobPostingId: payload.jid })
      .select('_id')
      .lean()
  }
  return {
    jobId: payload.jid,
    jobDescription: prepared.jobDescription,
    jdHash: payload.jdh,
    company: String(posting.company ?? '').slice(0, INTERVIEW_TARGET_COMPANY_MAX_CHARS),
    ...(prepared.role ? { role: prepared.role } : {}),
    applicationId: application ? String(application._id) : undefined,
  }
}
