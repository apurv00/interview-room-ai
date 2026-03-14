import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { getHireUser, isRecruiter, createInvite, listPendingInvites } from '@b2b/services/hireService'
import { InviteSchema } from '@b2b/validators/hire'

export const dynamic = 'force-dynamic'

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
  const parsed = InviteSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid data', details: parsed.error.flatten() }, { status: 400 })
  }

  const result = await createInvite(user._id, user.organizationId, parsed.data)
  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  return NextResponse.json(result)
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await getHireUser(session.user.id)
  if (!user || !isRecruiter(user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const data = await listPendingInvites(user.organizationId)
  return NextResponse.json(data)
}
