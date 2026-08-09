import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { logger } from '@shared/logger'
import { connectDB } from '@shared/db/connection'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'
import { AppError } from '@shared/errors'
import { isJobsAccountActive } from '@shared/services/jobsAccountFence'
import { parseDocument, UnsupportedFileTypeError } from '@shared/services/documentParser'
import {
  requireMembership,
  intakeCandidate,
  analyzeResumeForJob,
  sha256,
  HireJob,
  type IHireResumeMatch,
} from '@hire'

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
 * Hand-rolled (not composeApiRoute) because the body is multipart —
 * same reason as /api/documents/upload, whose guards this mirrors.
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

export async function POST(
  req: NextRequest,
  { params }: { params: { jobId: string } },
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    await connectDB()
    // Account-lifecycle egress fence, re-checked at every trust boundary in
    // this handler (entry → before each model-provider attempt → before
    // writes): parse + LLM make this a long request, and a deletion that
    // starts mid-flight must neither ship documents to a provider nor
    // persist hiring data under the deleted user (Codex P1×2 on #612).
    const accountActive = () => isJobsAccountActive(session.user.id)
    if (!(await accountActive())) {
      return NextResponse.json(
        { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
        { status: 401 },
      )
    }

    // Sized for real batches: 20 files at browser concurrency 3 finishes
    // inside a minute — 60/min leaves headroom without opening a
    // parse-compute hose (each request costs a parse + an LLM call).
    const limited = await checkRateLimit(session.user.id, {
      windowMs: 60_000,
      maxRequests: 60,
      keyPrefix: 'rl:hire-intake',
    })
    if (limited) return limited

    const ctx = await requireMembership({
      userId: session.user.id,
      email: session.user.email,
    })

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

    const buffer = Buffer.from(await file.arrayBuffer())
    const parsed = await parseDocument(buffer, file.name)
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
        {
          error: 'Invalid name or email override',
          code: 'INVALID_OVERRIDE',
          fileName: file.name,
        },
        { status: 422 },
      )
    }
    const overrideName = overrideParse.data.name ?? ''
    const overrideEmail = overrideParse.data.email ?? ''
    const email = overrideEmail || analysis?.email || ''
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
        }
      : undefined

    // Last fence before writes: the parse/LLM phase above is the long part
    // of this request — do not persist hiring data for an account whose
    // deletion completed meanwhile.
    if (!(await accountActive())) {
      return NextResponse.json(
        { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
        { status: 401 },
      )
    }

    const result = await intakeCandidate(ctx, {
      jobId: params.jobId,
      name,
      email,
      phone: analysis?.phone ?? undefined,
      resumeText,
      resumeFileName: file.name.slice(0, 255),
      source: 'bulk_upload',
      resumeMatch,
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
  } catch (err) {
    if (err instanceof UnsupportedFileTypeError) {
      return NextResponse.json(
        { error: err.message, code: 'UNSUPPORTED_TYPE' },
        { status: 415 },
      )
    }
    if (err instanceof AppError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.statusCode },
      )
    }
    logger.error({ err }, 'hire intake failed')
    return NextResponse.json({ error: 'Intake failed' }, { status: 500 })
  }
}

function str(v: FormDataEntryValue | null): string {
  return typeof v === 'string' ? v.trim() : ''
}
