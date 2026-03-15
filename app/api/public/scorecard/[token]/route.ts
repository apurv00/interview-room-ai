import { NextResponse } from 'next/server'
import { getPublicScorecard } from '@learn/services/shareService'

export const dynamic = 'force-dynamic'

export async function GET(
  req: Request,
  { params }: { params: { token: string } },
) {
  try {
    const { token } = params
    if (!token || token.length < 8) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 400 })
    }

    const scorecard = await getPublicScorecard(token)
    if (!scorecard) {
      return NextResponse.json({ error: 'Scorecard not found or expired' }, { status: 404 })
    }

    return NextResponse.json(scorecard)
  } catch {
    return NextResponse.json({ error: 'Failed to load scorecard' }, { status: 500 })
  }
}
