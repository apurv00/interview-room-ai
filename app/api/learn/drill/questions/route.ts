import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { getWeakQuestions } from '@learn/services/drillService'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(req.url)
    const limit = Math.min(Number(searchParams.get('limit') || 10), 20)
    const competency = searchParams.get('competency') || undefined

    const questions = await getWeakQuestions(session.user.id, limit, competency)
    return NextResponse.json({ questions })
  } catch {
    return NextResponse.json({ questions: [] })
  }
}
