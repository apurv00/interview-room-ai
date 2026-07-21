import { NextRequest, NextResponse } from 'next/server'
import { parseDocument, UnsupportedFileTypeError } from '@shared/services/documentParser'
import { logger } from '@shared/logger'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'
import { connectDB } from '@shared/db/connection'
import { isJobsAccountActive } from '@shared/services/jobsAccountFence'

export const dynamic = 'force-dynamic'

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

const accountUnavailableResponse = () => NextResponse.json(
  { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
  { status: 401 },
)

export async function POST(req: NextRequest) {
  let requesterUserId: string | undefined
  try {
    // Auth required to prevent anonymous document-parsing compute abuse.
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    requesterUserId = session.user.id

    const originUserId = req.headers.get('x-origin-user-id')
    if (originUserId !== null && originUserId !== session.user.id) {
      return NextResponse.json(
        { error: 'sign-in session changed', code: 'SESSION_CHANGED' },
        { status: 409 },
      )
    }

    await connectDB()
    if (!(await isJobsAccountActive(session.user.id))) {
      return accountUnavailableResponse()
    }

    // Rate limit: 10 uploads per user per hour
    const rateLimited = await checkRateLimit(session.user.id, {
      windowMs: 3600_000,
      maxRequests: 10,
      keyPrefix: 'rl:doc-upload',
    })
    if (rateLimited) return rateLimited

    const formData = await req.formData()
    const file = formData.get('file') as File | null
    const docType = formData.get('docType') as string | null

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }

    if (!docType || !['jd', 'resume'].includes(docType)) {
      return NextResponse.json({ error: 'docType must be "jd" or "resume"' }, { status: 400 })
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB.` },
        { status: 400 }
      )
    }

    const arrayBuffer = await file.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    const result = await parseDocument(buffer, file.name)
    // Parsing may take long enough for account deletion to commit. Never
    // return extracted resume/JD text to the stale authenticated tab after
    // that privacy boundary.
    if (!(await isJobsAccountActive(session.user.id))) {
      return accountUnavailableResponse()
    }

    // Truly empty extraction fails for EVERY file type; the near-empty
    // heuristic applies to PDFs ONLY — that is the scanned-image signature.
    // Short-but-real .txt/.docx uploads must pass: the interview setup
    // legitimately accepts pasted JDs from 20 CHARACTERS, so a concise JD
    // file must not 422 as a "scanned image" (Codex P2 on #489). Failing
    // here with an actionable message beats returning 200 and letting
    // downstream consumers die with a misleading "Validation failed".
    const looksScanned = result.docType === 'pdf' && result.wordCount < 20
    if (result.wordCount === 0 || looksScanned) {
      return NextResponse.json(
        {
          error: looksScanned
            ? 'No readable text found in this PDF — it looks like a scanned image. Export a text-based PDF, or paste the text directly.'
            : 'This file contains no readable text. Paste the text directly or upload a different file.',
          code: 'EMPTY_TEXT',
        },
        { status: 422 }
      )
    }

    return NextResponse.json({
      text: result.text,
      fileName: file.name,
      wordCount: result.wordCount,
      docType,
    })
  } catch (err) {
    if (requesterUserId) {
      try {
        if (!(await isJobsAccountActive(requesterUserId))) {
          return accountUnavailableResponse()
        }
      } catch {
        // Preserve the original parser/input failure if this check fails.
      }
    }
    // Surface the actionable unsupported-type message (drag-and-drop bypasses
    // the client's accept filter, so .doc/.rtf/.odt land here) — everything
    // else stays generic.
    if (err instanceof UnsupportedFileTypeError) {
      return NextResponse.json({ error: err.message, code: 'UNSUPPORTED_TYPE' }, { status: 415 })
    }
    logger.error({ err }, 'Document upload/parse error')
    return NextResponse.json({ error: 'Failed to parse document' }, { status: 400 })
  }
}
