import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { markBadgeNotified } from '@learn/services/badgeService'
import { invalidateUnnotifiedBadgesCache } from '@learn/services/badgeCacheUtils'
import { BadgeNotifySchema } from '@learn/validators/engagement'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const parsed = BadgeNotifySchema.safeParse(await req.json())
    if (!parsed.success) {
      const overLimit = parsed.error.issues.some((issue) => issue.code === 'too_big')
      return NextResponse.json(
        { error: overLimit ? 'badgeId must be at most 50 characters' : 'Missing badgeId' },
        { status: 400 },
      )
    }
    const { badgeId } = parsed.data

    await markBadgeNotified(session.user.id, badgeId)
    await invalidateUnnotifiedBadgesCache(session.user.id)
    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Failed to mark badge notified' }, { status: 500 })
  }
}
