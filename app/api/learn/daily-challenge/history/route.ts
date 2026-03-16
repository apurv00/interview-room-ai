import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { getUserChallengeHistory } from '@learn/services/dailyChallengeService'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(req.url)
    const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '20'), 1), 100)

    const history = await getUserChallengeHistory(session.user.id, limit)
    return NextResponse.json({ history })
  } catch {
    return NextResponse.json({ history: [] })
  }
}
