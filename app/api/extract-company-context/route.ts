import { NextResponse } from 'next/server'
import { extractCompanyContext } from '@interview/services/persona/jdContextExtractor'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const schema = z.object({
  jdText: z.string().min(1).max(50000),
})

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const { jdText } = schema.parse(body)
    const result = await extractCompanyContext(jdText)
    return NextResponse.json(result)
  } catch {
    return NextResponse.json({ company: null, industry: null })
  }
}
