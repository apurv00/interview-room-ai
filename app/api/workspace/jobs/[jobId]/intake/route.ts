import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { logger } from '@shared/logger'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'
import { parseDocument, UnsupportedFileTypeError } from '@shared/services/documentParser'
import {
  requireMembership,
  intakeCandidate,
  analyzeResumeForJob,
  extractAllEmails,
  sha256,
  HireJob,
  type IHireResumeMatch,
} from '@hire'
import {
  composeHireApiRoute,
  type HireApiContext,
} from '../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

/**
 * Per-file resume intake for a job (Phase 2 bulk upload).
 *
 * DESIGN: one request = one resume = one atomic unit. The client fans a
 * batch out at small concurrency and retries failures individually — a
 * mid-batch deploy or a corrupt PDF costs exactly one file, never the
 * batch. This deliberately avoids a background-job dependency at bulk
 * sizes ≤ ~100 (founder decision 2026-08-09: no Inngest for intake).
 *
 * ON THE RAILS: composeHireApiRoute without a `schema` never reads the body,
 * so multipart routes belong on it like every other workspace route —
 * auth, the account-lifecycle egress fence (entry + post-handler +
 * exception-path rechecks), plan-scaled rate limiting, and AppError
 * mapping all come from the middleware. The handler adds ONLY the two
 * fences compose documents as handler responsibility on long mutation
 * requests: before each model-provider attempt and before writes
 * (Codex P1×2 on #612).
 *
 * Pipeline per file: parse (documentParser) → ONE LLM call extracts
 * identity + scores resume-vs-JD (hire.resume-intake slot, advisory) →
 * idempotent intakeCandidate (workspace-email dedupe, merge, seen-before).
 */

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB — matches documents/upload
const RESUME_TEXT_CAP = 50000 // HireCandidate.resumeText maxlength

/**
 * Recruiter-supplied fix-up fields (the NO_EMAIL retry path). Validated to
 * the same standard as model output — an unvalidated override would become
 * the workspace dedupe/identity key (Codex P2 on #612).
 */
const OverrideFieldsSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().toLowerCase().email().max(254).optional(),
})

async function handleIntake(
  req: NextRequest,
  { user, params, isPrincipalActive }: HireApiContext<unknown>,
): Promise<NextResponse> {
  // Long-request fence: entry/egress checks live in composeHireApiRoute; this
  // closure re-checks at the two boundaries the middleware cannot see —
  // before every model-provider attempt and before persistence — so a
  // removal/deletion starting mid-parse neither ships documents to a
  // provider nor releases output. For a Hire principal this re-resolves the
  // Hire member session and never queries User.
  const accountActive = isPrincipalActive

  const ctx = await requireMembership({ userId: user.id, email: user.email })

  // Workspace-level abuse ceiling on the paid parse+LLM path — generous for
  // real hiring (500 CVs/day), fixed-window Redis, fails open like every
  // limiter here. Per-plan product quotas are a separate founder decision.
  const dailyCap = await checkRateLimit(`ws:${ctx.workspace._id.toString()}`, {
    windowMs: 24 * 60 * 60 * 1000,
    maxRequests: 500,
    keyPrefix: 'rl:hire-intake-day',
  })
  if (dailyCap) return dailyCap

  const job = await HireJob.findOne({
    _id: params.jobId,
    workspaceId: ctx.workspace._id,
  })
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }
  if (job.status === 'closed') {
    return NextResponse.json(
      { error: 'This job is closed', code: 'JOB_CLOSED' },
      { status: 409 },
    )
  }

  const formData = await req.formData()
  const file = formData.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 })
  }
  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: 'File too large (max 10MB)', code: 'FILE_TOO_LARGE' },
      { status: 400 },
    )
  }

  let parsed
  try {
    parsed = await parseDocument(Buffer.from(await file.arrayBuffer()), file.name)
  } catch (err) {
    if (err instanceof UnsupportedFileTypeError) {
      return NextResponse.json(
        { error: err.message, code: 'UNSUPPORTED_TYPE', fileName: file.name },
        { status: 415 },
      )
    }
    logger.error({ err, fileName: file.name }, 'hire intake: parse failed')
    return NextResponse.json(
      { error: 'Could not parse this file', code: 'PARSE_FAILED', fileName: file.name },
      { status: 422 },
    )
  }
  if (parsed.wordCount === 0 || (parsed.docType === 'pdf' && parsed.wordCount < 20)) {
    return NextResponse.json(
      {
        error: 'No readable text in this file — scanned image PDFs are not supported',
        code: 'EMPTY_TEXT',
        fileName: file.name,
      },
      { status: 422 },
    )
  }
  const resumeText = parsed.text.slice(0, RESUME_TEXT_CAP)

  // Advisory analysis: identity + JD match in one call. Null → intake
  // still proceeds if the caller can supply identity another way. The
  // fail-closed precondition runs before EVERY provider attempt.
  const analysis = await analyzeResumeForJob({
    resumeText,
    jdText: job.jdText,
    beforeProviderCall: accountActive,
  })

  // Recruiter-supplied overrides (single-file "add with resume" path and
  // the client's fix-up retry after NO_EMAIL) beat extraction — validated
  // to the same standard as model output before becoming the dedupe key.
  const overrideParse = OverrideFieldsSchema.safeParse({
    name: str(formData.get('name')) || undefined,
    email: str(formData.get('email')) || undefined,
  })
  if (!overrideParse.success) {
    return NextResponse.json(
      { error: 'Invalid name or email override', code: 'INVALID_OVERRIDE', fileName: file.name },
      { status: 422 },
    )
  }
  const overrideName = overrideParse.data.name ?? ''
  const overrideEmail = overrideParse.data.email ?? ''
  // The deterministic set of validated email TOKENS actually present in the
  // document. The model's email is trusted only if it is one of these exact
  // tokens — a substring test would accept `victim@x.com` from a document
  // that only contains `notvictim@x.com`, letting an injected instruction
  // steer dedupe onto the wrong candidate (Codex P1 on #613).
  const documentEmails = extractAllEmails(resumeText)
  const modelEmail =
    analysis?.email && documentEmails.includes(analysis.email) ? analysis.email : null
  // Priority: recruiter override → verbatim model extraction → first
  // deterministic token. The token tier keeps a model outage degrading to
  // UNSCORED candidates instead of a stalled NO_EMAIL batch.
  const email = overrideEmail || modelEmail || documentEmails[0] || ''
  if (!email) {
    // Explicit contract for the client: show this file as "needs email",
    // let the recruiter type it, retry with the override field.
    return NextResponse.json(
      {
        error: 'No email address found in this resume',
        code: 'NO_EMAIL',
        fileName: file.name,
        extractedName: analysis?.name ?? null,
      },
      { status: 422 },
    )
  }
  const name =
    overrideName || analysis?.name || file.name.replace(/\.[^.]+$/, '').slice(0, 120)

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

  // No manual pre-write fence here: intakeCandidate runs all writes inside
  // the Hire-owned active-workspace/member transaction. A concurrent
  // workspace tombstone or member removal conflicts or fails closed before
  // any candidate data commits; no B2C User participates in the claim.
  const result = await intakeCandidate(ctx, {
    jobId: params.jobId,
    name,
    email,
    phone: analysis?.phone ?? undefined,
    resumeText,
    resumeFileName: file.name.slice(0, 255),
    source: 'bulk_upload',
    resumeMatch,
    // Recruiter-typed email = explicit identity confirmation; extracted
    // emails go through the identity-conflict guard in intakeCandidate.
    identityConfirmed: !!overrideEmail,
  })

  return NextResponse.json({
    fileName: file.name,
    candidateId: result.candidateId,
    applicationId: result.applicationId,
    createdCandidate: result.createdCandidate,
    createdApplication: result.createdApplication,
    seenBefore: result.seenBefore,
    candidate: { name, email },
    resumeMatch: resumeMatch
      ? { score: resumeMatch.score, strengths: resumeMatch.strengths, gaps: resumeMatch.gaps }
      : null,
  })
}

function str(v: FormDataEntryValue | null): string {
  return typeof v === 'string' ? v.trim() : ''
}

export const POST = composeHireApiRoute({
  // No `schema`: compose never reads the body, the handler parses the
  // multipart form itself — the sanctioned pattern for upload routes.
  // Sized for real batches: 20 files at browser concurrency 3 finishes
  // inside a minute; each request costs a parse + one LLM call.
  rateLimit: { windowMs: 60_000, maxRequests: 60, keyPrefix: 'rl:hire-intake' },
  handler: handleIntake,
})
