import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { getChallengeLeaderboard } from '@learn/services/dailyChallengeService'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const leaderboard = await getChallengeLeaderboard()
    return NextResponse.json({ leaderboard })
  } catch {
    return NextResponse.json({ leaderboard: [] })
  }
}
