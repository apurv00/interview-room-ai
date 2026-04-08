import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { PDFGenerateSchema } from '@resume/validators/resume'
import { generatePDF, generatePDFFromHTML } from '@resume/services/pdfService'

export const dynamic = 'force-dynamic'
export const maxDuration = 30 // Allow up to 30s for PDF generation

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const parsed = PDFGenerateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid data' }, { status: 400 })
  }

  try {
    const pdfBuffer = parsed.data.previewHtml
      ? await generatePDFFromHTML(parsed.data.previewHtml)
      : await generatePDF(parsed.data.resumeData, parsed.data.templateId)
    const fileName = `${parsed.data.resumeData.name || 'resume'}.pdf`.replace(/[^a-zA-Z0-9._-]/g, '_')

    return new Response(new Uint8Array(pdfBuffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Content-Length': String(pdfBuffer.length),
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'PDF generation failed'
    console.error('PDF generation error:', message)
    return NextResponse.json(
      { error: 'PDF generation failed. Use browser print (Ctrl+P) as an alternative.', fallback: 'print' },
      { status: 500 }
    )
  }
}
