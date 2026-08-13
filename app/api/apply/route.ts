import { NextRequest, NextResponse } from 'next/server'
import { isIP } from 'node:net'
import { z } from 'zod'
import { AppError } from '@shared/errors'
import { logger } from '@shared/logger'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'
import { isSupportedDocumentType } from '@shared/services/documentParser'
import { resolveApplyToken } from '@hire/services/applyPageService'
import { enqueuePublicApplyIntake } from '@hire/services/intakeQueueService'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MAX_FILE_SIZE = 5 * 1024 * 1024
const MAX_BODY_SIZE = MAX_FILE_SIZE + 512 * 1024
const CAPABILITY = /^[a-f0-9]{24}\.[a-f0-9]{64}$/i
const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }

const ApplicantSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  phone: z.string().trim().max(32).optional(),
})

const ACCEPTED = {
  ok: true,
  message: 'Your application has been submitted.',
} as const

function response(body: object, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS })
}

function noStore(responseToProtect: NextResponse): NextResponse {
  responseToProtect.headers.set('Cache-Control', 'private, no-store')
  return responseToProtect
}

/** The public apply route is deliberately bound to the request IP only.
 * It must never ask whether the candidate has a B2C session or account. */
function requestIp(req: NextRequest): string {
  const firstValidIp = (header: string | null): string | undefined => {
    const candidate = header?.split(',')[0]?.trim()
    return candidate && isIP(candidate) ? candidate : undefined
  }
  // Prefer an ingress-owned single-client header. Vercel supplies its own
  // forwarded header; the Cloudflare/Coolify route supplies CF-Connecting-IP.
  // `x-forwarded-for` remains only a deployment fallback: the origin must not
  // accept direct traffic, otherwise any proxy header can be forged.
  const ip = process.env.VERCEL === '1'
    ? firstValidIp(req.headers.get('x-vercel-forwarded-for'))
      ?? firstValidIp(req.headers.get('x-real-ip'))
      ?? firstValidIp(req.headers.get('x-forwarded-for'))
    : firstValidIp(req.headers.get('cf-connecting-ip'))
      ?? firstValidIp(req.headers.get('x-real-ip'))
      ?? firstValidIp(req.headers.get('x-forwarded-for'))
  // Missing or malformed identity enters one bounded bucket rather than
  // becoming an attacker-controlled Redis key namespace.
  return ip ?? 'unknown-client'
}

async function checkPublicApplyRateLimits(ip: string): Promise<NextResponse | null> {
  const perMinute = await checkRateLimit(ip, {
    windowMs: 60_000,
    maxRequests: 5,
    keyPrefix: 'rl:apply-submit',
    // This route accepts anonymous data and queues paid parsing/scoring work.
    failClosed: true,
  })
  if (perMinute) return noStore(perMinute)

  const daily = await checkRateLimit(ip, {
    windowMs: 24 * 60 * 60 * 1_000,
    maxRequests: 20,
    // Preserve the former anonymous daily-key shape without consulting B2C auth.
    keyPrefix: 'rl:apply-submit:anon-day',
    failClosed: true,
  })
  return daily ? noStore(daily) : null
}

async function checkPublicApplyJobRateLimit(jobId: string): Promise<NextResponse | null> {
  const perJob = await checkRateLimit(jobId, {
    windowMs: 24 * 60 * 60 * 1_000,
    maxRequests: 300,
    keyPrefix: 'rl:apply-job-day',
    failClosed: true,
  })
  return perJob ? noStore(perJob) : null
}

async function handleApply(req: NextRequest): Promise<NextResponse> {
  const ip = requestIp(req)
  const ipBlocked = await checkPublicApplyRateLimits(ip)
  if (ipBlocked) return ipBlocked

  const capability = req.headers.get('x-hire-apply-capability')?.trim() ?? ''
  if (!CAPABILITY.test(capability)) {
    return response({ error: 'This application link is no longer active' }, 404)
  }

  // Resolve only to apply the per-job abuse cap. The queue resolves it again
  // inside its fenced transaction, so link rotation/closure races cannot
  // enqueue work after this public preflight succeeds.
  const view = await resolveApplyToken(capability)
  if (!view) {
    return response({ error: 'This application link is no longer active' }, 404)
  }

  const jobBlocked = await checkPublicApplyJobRateLimit(view.job._id.toString())
  if (jobBlocked) return jobBlocked

  const declaredLength = Number(req.headers.get('content-length') ?? Number.NaN)
  if (!Number.isFinite(declaredLength)) {
    return response({ error: 'Missing Content-Length', code: 'LENGTH_REQUIRED' }, 411)
  }
  if (declaredLength > MAX_BODY_SIZE) {
    return response({ error: 'File too large (max 5MB)', code: 'FILE_TOO_LARGE' }, 413)
  }

  const formData = await req.formData()
  const fields = ApplicantSchema.safeParse({
    name: stringField(formData.get('name')),
    email: stringField(formData.get('email')),
    phone: stringField(formData.get('phone')) || undefined,
  })
  if (!fields.success) {
    return response(
      { error: 'Please check your name and email address', code: 'INVALID_FIELDS' },
      422,
    )
  }

  const file = formData.get('file')
  if (!(file instanceof File)) {
    return response({ error: 'Please attach your résumé' }, 400)
  }
  if (file.size > MAX_FILE_SIZE) {
    return response({ error: 'File too large (max 5MB)', code: 'FILE_TOO_LARGE' }, 400)
  }
  if (!isSupportedDocumentType(file.name)) {
    return response(
      { error: 'Please upload a PDF, DOCX or TXT file', code: 'UNSUPPORTED_TYPE' },
      415,
    )
  }

  const queued = await enqueuePublicApplyIntake({
    capability,
    name: fields.data.name,
    email: fields.data.email,
    phone: fields.data.phone,
    fileName: file.name,
    // Browsers are allowed to omit a MIME type for a file picker selection.
    contentType: file.type || 'application/octet-stream',
    payload: Buffer.from(await file.arrayBuffer()),
  })
  if (!queued) {
    return response({ error: 'This application link is no longer active' }, 404)
  }

  // The public response intentionally contains neither the task id nor any
  // candidate/application state. Both are workspace-only data.
  return response(ACCEPTED, 202)
}

function stringField(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : ''
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    return await handleApply(req)
  } catch (error) {
    if (error instanceof AppError) {
      return response({ error: error.message, code: error.code }, error.statusCode)
    }
    logger.error({ errorName: error instanceof Error ? error.name : 'unknown' }, 'apply: queue failed')
    return response({ error: 'We could not submit your application. Please try again.' }, 500)
  }
}
