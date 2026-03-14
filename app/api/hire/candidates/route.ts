import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { getHireUser, isRecruiter, listCandidates } from '@b2b/services/hireService'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await getHireUser(session.user.id)
  if (!user || !isRecruiter(user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(req.url)
  const data = await listCandidates(user.organizationId, {
    status: searchParams.get('status') || undefined,
    role: searchParams.get('role') || undefined,
    page: parseInt(searchParams.get('page') || '1', 10),
  })

  return NextResponse.json(data)
}
