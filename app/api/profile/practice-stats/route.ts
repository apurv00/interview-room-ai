import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/authOptions'
import { connectDB } from '@/lib/db/connection'
import { User } from '@/lib/db/models'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const UpdateStatsSchema = z.object({
  domain: z.string().min(1).max(50),
  interviewType: z.string().min(1).max(50),
  score: z.number().min(0).max(100),
  strongDimensions: z.array(z.string().max(50)).max(5).optional(),
  weakDimensions: z.array(z.string().max(50)).max(5).optional(),
})

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const parsed = UpdateStatsSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid data' }, { status: 400 })
  }

  const { domain, interviewType, score, strongDimensions, weakDimensions } = parsed.data
  const key = `${domain}:${interviewType}`

  await connectDB()
  const user = await User.findById(session.user.id).select('practiceStats').lean()
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const existing = user.practiceStats?.get?.(key) || (user.practiceStats as unknown as Record<string, unknown>)?.[key]
  const prev = existing as { totalSessions?: number; avgScore?: number } | undefined

  const totalSessions = (prev?.totalSessions || 0) + 1
  const avgScore = prev?.avgScore
    ? Math.round(((prev.avgScore * (totalSessions - 1)) + score) / totalSessions)
    : score

  await User.findByIdAndUpdate(session.user.id, {
    $set: {
      [`practiceStats.${key}`]: {
        totalSessions,
        avgScore,
        lastScore: score,
        lastPracticedAt: new Date(),
        strongDimensions: strongDimensions || [],
        weakDimensions: weakDimensions || [],
      },
    },
  })

  return NextResponse.json({ success: true })
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await connectDB()
  const user = await User.findById(session.user.id).select('practiceStats').lean()
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  return NextResponse.json({ practiceStats: user.practiceStats || {} })
}
