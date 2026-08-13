import { NextRequest, NextResponse } from 'next/server'
import { isSupportedDocumentType } from '@shared/services/documentParser'
import {
  enqueueMemberResumeIntake,
  HIRE_INTAKE_TASK_MAX_PAYLOAD_BYTES,
  requireMembership,
} from '@hire'
import {
  composeHireApiRoute,
  type HireApiContext,
} from '../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

const PRIVATE_NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }

function formValue(formData: FormData, field: string): string | undefined {
  const value = formData.get(field)
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

/** `Request.formData()` can produce a different File realm in tests/runtime. */
function isUploadedFile(value: FormDataEntryValue | null): value is File {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as File).name === 'string' &&
    typeof (value as File).size === 'number' &&
    typeof (value as File).arrayBuffer === 'function'
  )
}

/**
 * Per-file recruiter upload. The request validates and durably enqueues a
 * Hire-owned task only; document parsing, LLM scoring, dedupe, and candidate
 * writes occur in the worker. This keeps large batches resilient to deploys
 * and makes a missing identity recoverable without uploading the resume again.
 */
async function enqueueIntake(
  req: NextRequest,
  { user, params }: HireApiContext<unknown>,
): Promise<NextResponse> {
  const ctx = await requireMembership({ userId: user.id, email: user.email })
  const formData = await req.formData()
  const file = formData.get('file')

  if (!isUploadedFile(file)) {
    return NextResponse.json(
      { error: 'No file provided', code: 'INVALID_FILE' },
      { status: 400, headers: PRIVATE_NO_STORE_HEADERS },
    )
  }
  if (!file.name || !isSupportedDocumentType(file.name)) {
    return NextResponse.json(
      {
        error: 'Please upload a PDF, DOCX or TXT file',
        code: 'UNSUPPORTED_TYPE',
        fileName: file.name,
      },
      { status: 415, headers: PRIVATE_NO_STORE_HEADERS },
    )
  }
  if (file.size < 1) {
    return NextResponse.json(
      { error: 'A non-empty resume is required', code: 'INVALID_FILE', fileName: file.name },
      { status: 422, headers: PRIVATE_NO_STORE_HEADERS },
    )
  }
  if (file.size > HIRE_INTAKE_TASK_MAX_PAYLOAD_BYTES) {
    return NextResponse.json(
      {
        error: 'Resume file is too large',
        code: 'FILE_TOO_LARGE',
        fileName: file.name,
      },
      { status: 413, headers: PRIVATE_NO_STORE_HEADERS },
    )
  }

  const task = await enqueueMemberResumeIntake(ctx, {
    jobId: params.jobId,
    fileName: file.name,
    // Browsers may not infer a MIME type from an otherwise valid filename.
    contentType: file.type || 'application/octet-stream',
    payload: Buffer.from(await file.arrayBuffer()),
    suppliedName: formValue(formData, 'name'),
    suppliedEmail: formValue(formData, 'email'),
    suppliedPhone: formValue(formData, 'phone'),
  })

  return NextResponse.json(
    { task },
    { status: 202, headers: PRIVATE_NO_STORE_HEADERS },
  )
}

export const POST = composeHireApiRoute({
  // Limits submission fan-out. Worker concurrency, not browser requests,
  // controls parse and model-provider load.
  rateLimit: { windowMs: 60_000, maxRequests: 60, keyPrefix: 'rl:hire-intake' },
  handler: enqueueIntake,
})
