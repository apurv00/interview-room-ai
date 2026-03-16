import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { getXpSummary } from '@learn/services/xpService'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const summary = await getXpSummary(session.user.id)
    return NextResponse.json(summary)
  } catch {
    return NextResponse.json(
      { xp: 0, level: 1, title: 'Novice', xpToNextLevel: 100, xpThisWeek: 0, xpForCurrentLevel: 0, xpForNextLevel: 100 },
    )
  }
}
