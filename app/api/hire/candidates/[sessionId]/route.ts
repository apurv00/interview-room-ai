import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { getHireUser, isRecruiter, getCandidateById } from '@b2b/services/hireService'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: { sessionId: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await getHireUser(session.user.id)
  if (!user || !isRecruiter(user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const candidate = await getCandidateById(user.organizationId, params.sessionId)
  if (!candidate) {
    return NextResponse.json({ error: 'Candidate not found' }, { status: 404 })
  }

  return NextResponse.json({ candidate })
}
