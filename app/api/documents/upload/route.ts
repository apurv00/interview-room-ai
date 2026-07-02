import { NextRequest, NextResponse } from 'next/server'
import { parseDocument, UnsupportedFileTypeError } from '@shared/services/documentParser'
import { logger } from '@shared/logger'
import { uploadToR2, documentKey, isR2Configured } from '@shared/storage/r2'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'

export const dynamic = 'force-dynamic'

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

export async function POST(req: NextRequest) {
  try {
    // Auth required to prevent anonymous storage exhaustion and compute abuse
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
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

    // Store original file in R2 if configured
    let r2Key: string | undefined
    if (isR2Configured()) {
      try {
        const userId = session.user.id
        const key = documentKey(userId, docType, file.name)
        await uploadToR2(key, buffer, file.type || 'application/octet-stream')
        r2Key = key
      } catch (uploadErr) {
        logger.warn({ err: uploadErr }, 'Failed to store original document in R2 — parsed text still available')
      }
    }

    return NextResponse.json({
      text: result.text,
      fileName: file.name,
      wordCount: result.wordCount,
      docType,
      r2Key,
    })
  } catch (err) {
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
