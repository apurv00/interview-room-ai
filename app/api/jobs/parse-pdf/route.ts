import { NextRequest, NextResponse } from 'next/server'
import { parseDocument, UnsupportedFileTypeError } from '@shared/services/documentParser'
import { logger } from '@shared/logger'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'

export const dynamic = 'force-dynamic'

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB — matches /api/documents/upload

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
    const session = await getServerSession(authOptions)
    const ip = (req.headers.get('x-forwarded-for') ?? 'unknown').split(',')[0].trim()
    const blocked = await checkRateLimit(session?.user?.id ?? `ip:${ip}`, {
      windowMs: 3600_000,
      maxRequests: 10,
      keyPrefix: 'rl:jobs-parse-pdf',
    })
    if (blocked) return blocked

    const formData = await req.formData()
    const file = formData.get('file') as File | null
    if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    // PDF only (founder directive) — .txt/.docx are not offered here.
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
    if (!isPdf) {
      return NextResponse.json({ error: 'Upload a PDF — or paste your resume text instead.' }, { status: 400 })
    }
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'File too large. Maximum size is 10MB.' }, { status: 400 })
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
      return NextResponse.json(
        {
          error: 'No readable text in this PDF — it looks like a scanned image. Paste your resume text instead.',
          code: 'EMPTY_TEXT',
        },
        { status: 422 }
      )
    }
    return NextResponse.json({ text: result.text })
  } catch (err) {
    if (err instanceof UnsupportedFileTypeError) {
      return NextResponse.json({ error: 'Upload a PDF — or paste your resume text instead.' }, { status: 400 })
    }
    logger.error({ err }, 'jobs parse-pdf failed')
    return NextResponse.json({ error: 'Could not read that PDF. Paste your resume text instead.' }, { status: 500 })
  }
}
