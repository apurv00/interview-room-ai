import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { getXpHistory } from '@learn/services/xpService'
import { XpHistoryQuerySchema } from '@learn/validators/engagement'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(req.url)
    const requestedLimit = searchParams.get('limit')
    const parsed = XpHistoryQuerySchema.safeParse({
      limit: requestedLimit === null || requestedLimit === ''
        ? undefined
        : requestedLimit,
    })
    if (!parsed.success) {
      return NextResponse.json({ error: 'limit must be between 1 and 100' }, { status: 400 })
    }

    const history = await getXpHistory(session.user.id, parsed.data.limit)
    return NextResponse.json({ events: history })
  } catch {
    return NextResponse.json({ events: [] })
  }
}
