import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { getHireUser, isRecruiter, listTemplates, createTemplate } from '@b2b/services/hireService'
import { CreateTemplateSchema } from '@b2b/validators/hire'

export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await getHireUser(session.user.id)
  if (!user || !isRecruiter(user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const data = await listTemplates(user.organizationId)
  return NextResponse.json(data)
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await getHireUser(session.user.id)
  if (!user || !isRecruiter(user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json()
  const parsed = CreateTemplateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid data' }, { status: 400 })
  }

  const result = await createTemplate(user.organizationId, user._id, parsed.data)
  return NextResponse.json(result)
}
