import { createHash, createHmac, timingSafeEqual } from 'crypto'
import { gunzipSync } from 'zlib'
import { isValidObjectId } from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { JobApplication, JobPosting } from '@shared/db/models'
import { interviewSlugForDomain } from '../config/domains'
import { xrayHashOf } from './xrayService'

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
  const buffer = Buffer.isBuffer(value)
    ? value
    : Buffer.from((value as { buffer: ArrayBufferLike }).buffer as ArrayBuffer)
  return gunzipSync(buffer).toString('utf8')
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
    .select('company domain status parsedJD parsedJDHash jdCompressed jdDisplayCompressed')
    .lean()
  if (!posting || posting.status !== 'open') return null

  let canonicalJd = ''
  let displayJd = ''
  try {
    canonicalJd = inflate(posting.jdCompressed)
    displayJd = inflate(posting.jdDisplayCompressed) || canonicalJd
  } catch {
    return null
  }
  if (!canonicalJd || practiceHandoffHashOf(canonicalJd) !== payload.jdh) return null
  // A malformed/stale display twin must never change what the candidate
  // practices. Canonical remains the signed source of truth.
  if (practiceHandoffHashOf(displayJd) !== payload.jdh) displayJd = canonicalJd

  const application = await JobApplication.findOne({ userId, jobPostingId: payload.jid })
    .select('_id')
    .lean()
  const cachedParsedRole = posting.parsedJDHash === xrayHashOf(canonicalJd)
    ? (posting.parsedJD as { inferredDomain?: string } | undefined)?.inferredDomain
    : undefined
  // The cached parse is LLM-produced. Run it through the same closed Jobs
  // taxonomy as the persisted posting domain before it becomes runtime
  // InterviewConfig; an arbitrary string must never become a server-approved
  // role merely because it was cached against the right JD hash.
  const role = interviewSlugForDomain(posting.domain) ?? interviewSlugForDomain(cachedParsedRole)
  return {
    jobId: payload.jid,
    jobDescription: displayJd,
    jdHash: payload.jdh,
    company: String(posting.company ?? '').slice(0, 200),
    ...(role ? { role } : {}),
    applicationId: application ? String(application._id) : undefined,
  }
}
