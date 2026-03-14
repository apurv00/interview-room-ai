import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { getHireUser, isRecruiter, getDashboardData } from '@b2b/services/hireService'

export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await getHireUser(session.user.id)
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  if (!user.organizationId) {
    return NextResponse.json({ org: null, recentCandidates: [], stats: { totalCandidates: 0, completedInterviews: 0, avgScore: 0, pendingInvites: 0 } })
  }

  if (!isRecruiter(user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const data = await getDashboardData(user.organizationId)
  return NextResponse.json(data)
}
