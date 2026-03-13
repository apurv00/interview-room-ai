import { NextRequest, NextResponse } from 'next/server'
import { parseDocument } from '@shared/services/documentParser'
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
    logger.error({ err }, 'Document upload/parse error')
    return NextResponse.json({ error: 'Failed to parse document' }, { status: 400 })
  }
}
