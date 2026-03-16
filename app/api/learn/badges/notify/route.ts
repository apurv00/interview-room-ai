import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { markBadgeNotified } from '@learn/services/badgeService'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json()
    const { badgeId } = body

    if (!badgeId || typeof badgeId !== 'string') {
      return NextResponse.json({ error: 'Missing badgeId' }, { status: 400 })
    }

    await markBadgeNotified(session.user.id, badgeId)
    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Failed to mark badge notified' }, { status: 500 })
  }
}
