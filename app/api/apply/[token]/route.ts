import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { logger } from '@shared/logger'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'
import { composeApiRoute, type ApiContext } from '@shared/middleware/composeApiRoute'
import { parseDocument, UnsupportedFileTypeError } from '@shared/services/documentParser'
import {
  resolveApplyToken,
  resolveWorkspaceWriteAuthority,
  intakeFromApplyPage,
  analyzeResumeForJob,
  sha256,
  type IHireResumeMatch,
} from '@hire'

export const dynamic = 'force-dynamic'

/**
 * PUBLIC application submission — the only unauthenticated WRITE surface in
 * the hire module. Everything here is written on the assumption that the
 * caller is hostile.
 *
 * Identity/tenancy: the hashed apply token in the path IS the credential.
 * It resolves to exactly one job (and through it, one workspace); no
 * client-supplied workspace or job id is ever trusted.
 *
 * Uniform responses: success, duplicate application, and "this email
 * already belongs to someone else in the pool" all return the SAME body.
 * Any difference would turn this endpoint into an oracle for who is in an
 * employer's candidate pool.
 *
 * Abuse: composeApiRoute's anon rails (IP-keyed per-minute + daily caps)
 * plus a per-JOB daily ceiling, because the expensive part is a document
 * parse and one model call per submission. Auth-gated /api/documents/upload
 * exists precisely to keep parsing off anonymous hands; opening it here is
 * deliberate and must stay tightly bounded.
 */

const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB — stricter than the member path
const RESUME_TEXT_CAP = 50000

const ApplicantSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  phone: z.string().trim().max(32).optional(),
})

/** One body for every outcome — see "Uniform responses" above. */
const ACCEPTED = {
  ok: true,
  message: 'Your application has been submitted.',
} as const

async function handleApply(
  req: NextRequest,
  { params }: ApiContext,
): Promise<NextResponse> {
  const view = await resolveApplyToken(params.token)
  // 404 for bad/disabled/closed alike — never distinguish them.
  if (!view) {
    return NextResponse.json({ error: 'This application link is no longer active' }, { status: 404 })
  }
  const { job } = view

  // Per-job daily ceiling: one viral or scripted link must not drain the
  // workspace's parse+model budget (which the member path also draws on).
  // Resolve the live workspace authority BEFORE parsing or scoring: if the
  // workspace has no member whose account still exists, this link cannot
  // accept applications, and the applicant must learn that immediately
  // rather than after we have paid for a parse + model call (Codex P1 on
  // #615). Same generic 404 as every other dead-link case — no oracle.
  const authorityUserId = await resolveWorkspaceWriteAuthority(job.workspaceId)
  if (!authorityUserId) {
    return NextResponse.json({ error: 'This application link is no longer active' }, { status: 404 })
  }

  const formData = await req.formData()
  const fields = ApplicantSchema.safeParse({
    name: str(formData.get('name')),
    email: str(formData.get('email')),
    phone: str(formData.get('phone')) || undefined,
  })
  if (!fields.success) {
    return NextResponse.json(
      { error: 'Please check your name and email address', code: 'INVALID_FIELDS' },
      { status: 422 },
    )
  }

  const file = formData.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Please attach your résumé' }, { status: 400 })
  }
  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: 'File too large (max 5MB)', code: 'FILE_TOO_LARGE' },
      { status: 400 },
    )
  }

  // Job-wide daily ceiling — deliberately AFTER the cheap checks. Charging
  // malformed requests (no file, bad email) against it lets a caller
  // exhaust a job's whole allowance with junk that never costs a parse or
  // a model call, 429'ing every real applicant for the rest of the window
  // (Codex P2 on #615). It gates EXPENSIVE work, so it is spent only when
  // expensive work is about to happen.
  const jobCap = await checkRateLimit(job._id.toString(), {
    windowMs: 24 * 60 * 60 * 1000,
    maxRequests: 300,
    keyPrefix: 'rl:apply-job-day',
    // Fail CLOSED, unlike the authed paths: this endpoint is anonymous AND
    // spends money per request, so a limiter outage must pause
    // applications rather than remove the only bound on spend.
    failClosed: true,
  })
  if (jobCap) return jobCap

  let parsed
  try {
    parsed = await parseDocument(Buffer.from(await file.arrayBuffer()), file.name)
  } catch (err) {
    if (err instanceof UnsupportedFileTypeError) {
      return NextResponse.json({ error: err.message, code: 'UNSUPPORTED_TYPE' }, { status: 415 })
    }
    logger.warn({ jobId: job._id.toString() }, 'apply: parse failed')
    return NextResponse.json(
      { error: 'We could not read that file — please upload a PDF, DOCX or TXT', code: 'PARSE_FAILED' },
      { status: 422 },
    )
  }
  if (parsed.wordCount === 0 || (parsed.docType === 'pdf' && parsed.wordCount < 20)) {
    return NextResponse.json(
      {
        error: 'That file has no readable text — scanned images are not supported',
        code: 'EMPTY_TEXT',
      },
      { status: 422 },
    )
  }
  const resumeText = parsed.text.slice(0, RESUME_TEXT_CAP)

  // Advisory as everywhere else: a model outage yields an UNSCORED
  // application, never a rejected candidate. Identity here comes from the
  // typed form, so extraction is not needed — only the JD match.
  const analysis = await analyzeResumeForJob({
    resumeText,
    jdText: job.jdText,
    // Fail-closed precondition, re-evaluated before EVERY provider attempt:
    // the transactional job guard only stops the later WRITE, while parsing
    // takes seconds during which the link can be rotated/disabled or the
    // workspace's last live member can start deleting their account.
    // Without this, a revoked link still ships the applicant's résumé to an
    // external model — cost plus personal-data disclosure past the privacy
    // boundary (Codex P2 on #615, same class as the member intake route).
    beforeProviderCall: async () => {
      if (!(await resolveApplyToken(params.token))) return false
      return !!(await resolveWorkspaceWriteAuthority(job.workspaceId))
    },
  })
  const resumeMatch: IHireResumeMatch | undefined = analysis
    ? {
        score: analysis.matchScore,
        strengths: analysis.strengths,
        gaps: analysis.gaps,
        scoredAt: new Date(),
        jdHash: sha256(job.jdText),
        resumeHash: sha256(resumeText),
      }
    : undefined

  // Re-resolve the authority for the WRITE. beforeProviderCall accepts any
  // live member, so pinning persistence to the one chosen before parsing
  // meant a mid-flight deletion of THAT member failed the transaction after
  // the paid analysis, even though another member was live and the model
  // call had been allowed on that basis (Codex on #615). Both fences now
  // ask the same question at the moment they act.
  const writeAuthorityUserId = await resolveWorkspaceWriteAuthority(job.workspaceId)
  if (!writeAuthorityUserId) {
    return NextResponse.json({ error: 'This application link is no longer active' }, { status: 404 })
  }

  await intakeFromApplyPage(
    job,
    {
      name: fields.data.name,
      email: fields.data.email,
      phone: fields.data.phone,
      resumeText,
      resumeFileName: file.name.slice(0, 255),
      resumeMatch,
    },
    { authorityUserId: writeAuthorityUserId, applyTokenHash: sha256(params.token) },
  )

  // Deliberately NOT returning ids, seenBefore, dedupe state or match
  // scores — the applicant learns nothing about the employer's pipeline.
  return NextResponse.json(ACCEPTED)
}

function str(v: FormDataEntryValue | null): string {
  return typeof v === 'string' ? v.trim() : ''
}

export const POST = composeApiRoute({
  // No `schema`: multipart body, parsed in the handler (the sanctioned
  // pattern — the middleware still supplies auth rails, rate limiting and
  // AppError mapping).
  authOptional: true,
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 5,
    keyPrefix: 'rl:apply-submit',
    // IP-keyed 24h cap for anonymous callers — the real abuse bound on
    // parse + model compute.
    anonDailyLimit: 20,
  },
  handler: handleApply,
})
