import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { checkATS } from '@resume/services/resumeAIService'
import { ATSCheckSchema } from '@resume/validators/resume'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const parsed = ATSCheckSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid data' }, { status: 400 })
  }

  try {
    const result = await checkATS(parsed.data)
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'ATS check failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
