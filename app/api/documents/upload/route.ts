import { NextRequest, NextResponse } from 'next/server'
import { parseDocument } from '@/lib/services/documentParser'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

export async function POST(req: NextRequest) {
  try {
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

    return NextResponse.json({
      text: result.text,
      fileName: file.name,
      wordCount: result.wordCount,
      docType,
    })
  } catch (err) {
    logger.error({ err }, 'Document upload/parse error')
    const message = err instanceof Error ? err.message : 'Failed to parse document'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
