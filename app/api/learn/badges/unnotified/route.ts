import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { getUnnotifiedBadges } from '@learn/services/badgeService'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const badges = await getUnnotifiedBadges(session.user.id)
    return NextResponse.json({ badges })
  } catch {
    return NextResponse.json({ badges: [] })
  }
}
