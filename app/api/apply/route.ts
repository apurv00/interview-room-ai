import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { logger } from '@shared/logger'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import {
  parseDocument,
  isSupportedDocumentType,
  UnsupportedFileTypeError,
} from '@shared/services/documentParser'
import {
  resolveApplyToken,
  resolveWorkspaceWriteAuthority,
  intakeFromApplyPage,
  analyzeResumeForJob,
  sha256,
  type IHireResumeMatch,
} from '@hire'

export const dynamic = 'force-dynamic'

const MAX_FILE_SIZE = 5 * 1024 * 1024
const MAX_BODY_SIZE = MAX_FILE_SIZE + 512 * 1024
const RESUME_TEXT_CAP = 50_000
const CAPABILITY = /^[a-f0-9]{24}\.[a-f0-9]{64}$/i

const ApplicantSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  phone: z.string().trim().max(32).optional(),
})

const ACCEPTED = {
  ok: true,
  message: 'Your application has been submitted.',
} as const

async function handleApply(req: NextRequest): Promise<NextResponse> {
  const capability = req.headers.get('x-hire-apply-capability')?.trim() ?? ''
  if (!CAPABILITY.test(capability)) {
    return NextResponse.json(
      { error: 'This application link is no longer active' },
      { status: 404 },
    )
  }
  const view = await resolveApplyToken(capability)
  if (!view) {
    return NextResponse.json(
      { error: 'This application link is no longer active' },
      { status: 404 },
    )
  }
  const { job } = view

  const authorityMemberId = await resolveWorkspaceWriteAuthority(job.workspaceId)
  if (!authorityMemberId) {
    return NextResponse.json(
      { error: 'This application link is no longer active' },
      { status: 404 },
    )
  }

  const declaredLength = Number(req.headers.get('content-length') ?? Number.NaN)
  if (!Number.isFinite(declaredLength)) {
    return NextResponse.json(
      { error: 'Missing Content-Length', code: 'LENGTH_REQUIRED' },
      { status: 411 },
    )
  }
  if (declaredLength > MAX_BODY_SIZE) {
    return NextResponse.json(
      { error: 'File too large (max 5MB)', code: 'FILE_TOO_LARGE' },
      { status: 413 },
    )
  }

  const formData = await req.formData()
  const fields = ApplicantSchema.safeParse({
    name: stringField(formData.get('name')),
    email: stringField(formData.get('email')),
    phone: stringField(formData.get('phone')) || undefined,
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
  if (!isSupportedDocumentType(file.name)) {
    return NextResponse.json(
      { error: 'Please upload a PDF, DOCX or TXT file', code: 'UNSUPPORTED_TYPE' },
      { status: 415 },
    )
  }

  const jobCap = await checkRateLimit(job._id.toString(), {
    windowMs: 24 * 60 * 60 * 1_000,
    maxRequests: 300,
    keyPrefix: 'rl:apply-job-day',
    failClosed: true,
  })
  if (jobCap) return jobCap

  let parsed
  try {
    parsed = await parseDocument(Buffer.from(await file.arrayBuffer()), file.name)
  } catch (error) {
    if (error instanceof UnsupportedFileTypeError) {
      return NextResponse.json(
        { error: error.message, code: 'UNSUPPORTED_TYPE' },
        { status: 415 },
      )
    }
    logger.warn({ jobId: job._id.toString() }, 'apply: parse failed')
    return NextResponse.json(
      {
        error: 'We could not read that file — please upload a PDF, DOCX or TXT',
        code: 'PARSE_FAILED',
      },
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

  const analysis = await analyzeResumeForJob({
    resumeText,
    jdText: job.jdText,
    beforeProviderCall: async () => {
      if (!(await resolveApplyToken(capability))) return false
      return Boolean(await resolveWorkspaceWriteAuthority(job.workspaceId))
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

  const writeAuthorityMemberId = await resolveWorkspaceWriteAuthority(job.workspaceId)
  if (!writeAuthorityMemberId) {
    return NextResponse.json(
      { error: 'This application link is no longer active' },
      { status: 404 },
    )
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
    {
      authorityMemberId: writeAuthorityMemberId,
      applyTokenHash: view.applyTokenHash,
    },
  )

  return NextResponse.json(ACCEPTED)
}

function stringField(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : ''
}

export const POST = composeApiRoute({
  authOptional: true,
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 5,
    keyPrefix: 'rl:apply-submit',
    anonDailyLimit: 20,
  },
  handler: (req) => handleApply(req),
})
