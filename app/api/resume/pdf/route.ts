import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { PDFGenerateSchema } from '@resume/validators/resume'
import { generatePDF } from '@resume/services/pdfService'

export const dynamic = 'force-dynamic'
// 60s gives puppeteer headroom on cold starts (@sparticuz/chromium extracts
// a brotli-compressed archive on first invocation, which takes ~3-5s).
export const maxDuration = 60

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
    const pdfBuffer = await generatePDF(parsed.data.resumeData, parsed.data.templateId)
    const fileName = `${parsed.data.resumeData.name || 'resume'}.pdf`.replace(
      /[^a-zA-Z0-9._-]/g,
      '_',
    )

    return new Response(new Uint8Array(pdfBuffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Content-Length': String(pdfBuffer.length),
      },
    })
  } catch (err) {
    // Log full stack so runtime logs surface the root cause (previous
    // truncated "Browser was not found" messages hid the stack trace).
    if (err instanceof Error) {
      console.error('PDF generation error:', err.message)
      console.error('PDF generation stack:', err.stack)
    } else {
      console.error('PDF generation error (non-Error):', err)
    }
    return NextResponse.json(
      {
        error: 'PDF generation failed. Use browser print (Ctrl+P) as an alternative.',
        fallback: 'print',
      },
      { status: 500 },
    )
  }
}
