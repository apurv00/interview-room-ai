import { NextRequest, NextResponse } from 'next/server'
import { parseDocument, UnsupportedFileTypeError } from '@shared/services/documentParser'
import { logger } from '@shared/logger'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'

export const dynamic = 'force-dynamic'

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB — matches /api/documents/upload
const MAX_MULTIPART_BODY_BYTES = MAX_FILE_SIZE + 512 * 1024
const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
} as const

function privateJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS })
}

function privateResponse(response: Response): Response {
  response.headers.set('Cache-Control', PRIVATE_HEADERS['Cache-Control'])
  response.headers.set('Pragma', PRIVATE_HEADERS.Pragma)
  return response
}

/**
 * POST /api/jobs/parse-pdf — STATELESS PDF → text for the /jobs/start
 * attach flow (founder directive 2026-07-16: upload is PDF-only; paste is
 * the failure fallback, nothing else).
 *
 * Deliberately NOT /api/documents/upload: that route requires auth and
 * persists the file to R2 — the jobs start flow serves ANONYMOUS strangers
 * whose resume must never persist server-side (PRODUCT_FLOW §1 Stage 1:
 * sessionStorage only, dies with the tab). This route extracts text and
 * returns it; nothing is stored. Anonymous callers are IP-rate-limited
 * (the /api/resume/parse anon precedent).
 */
export async function POST(req: NextRequest) {
  try {
    const declaredLength = Number(req.headers.get('content-length') ?? 0)
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MULTIPART_BODY_BYTES) {
      return privateJson({ error: 'File too large. Maximum size is 10MB.' }, 413)
    }
    const session = await getServerSession(authOptions)
    const ip = (req.headers.get('x-forwarded-for') ?? 'unknown').split(',')[0].trim()
    const blocked = await checkRateLimit(session?.user?.id ?? `ip:${ip}`, {
      windowMs: 3600_000,
      maxRequests: 10,
      keyPrefix: 'rl:jobs-parse-pdf',
    })
    if (blocked) return privateResponse(blocked)

    const formData = await req.formData()
    const file = formData.get('file') as File | null
    if (!file) return privateJson({ error: 'No file provided' }, 400)
    // PDF only (founder directive) — .txt/.docx are not offered here.
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
    if (!isPdf) {
      return privateJson({ error: 'Upload a PDF — or paste your resume text instead.' }, 400)
    }
    if (file.size > MAX_FILE_SIZE) {
      return privateJson({ error: 'File too large. Maximum size is 10MB.' }, 400)
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    // Constant name, never file.name (Codex #540 ×2): (1) resume filenames
    // routinely carry the user's REAL name and parseDocument logs the
    // filename — the route's contract is "nothing stored", logs included;
    // (2) parseDocument picks its parser from the EXTENSION, so a
    // MIME-accepted PDF without a .pdf name would throw
    // UnsupportedFileTypeError despite being valid.
    const result = await parseDocument(buffer, 'resume.pdf')
    // Scanned-image signature (same heuristic as /api/documents/upload).
    if (result.wordCount === 0 || result.wordCount < 20) {
      return privateJson(
        {
          error: 'No readable text in this PDF — it looks like a scanned image. Paste your resume text instead.',
          code: 'EMPTY_TEXT',
        },
        422,
      )
    }
    return privateJson({
      text: result.text,
      extractionWarnings: result.truncated
        ? ['Only the first 8,000 words were extracted from the PDF — review anything near the end of the resume.']
        : [],
    })
  } catch (err) {
    if (err instanceof UnsupportedFileTypeError) {
      return privateJson({ error: 'Upload a PDF — or paste your resume text instead.' }, 400)
    }
    logger.error({ err }, 'jobs parse-pdf failed')
    return privateJson({ error: 'Could not read that PDF. Paste your resume text instead.' }, 500)
  }
}
