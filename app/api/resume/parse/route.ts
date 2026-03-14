import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { parseResumeToStructured } from '@resume/services/resumeAIService'
import { ParseResumeSchema } from '@resume/validators/resume'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const parsed = ParseResumeSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid data' }, { status: 400 })
  }

  try {
    const result = await parseResumeToStructured(parsed.data.text)
    if (!result) {
      return NextResponse.json({ error: 'Failed to parse resume' }, { status: 500 })
    }
    return NextResponse.json(result)
  } catch {
    return NextResponse.json({ error: 'Failed to parse resume' }, { status: 500 })
  }
}
