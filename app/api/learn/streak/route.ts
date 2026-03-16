import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { getStreakCalendar } from '@learn/services/streakService'
import { User } from '@shared/db/models/User'
import { connectDB } from '@shared/db/connection'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    await connectDB()
    const [user, calendar] = await Promise.all([
      User.findById(session.user.id)
        .select('currentStreak longestStreak streakFreezeAvailable')
        .lean(),
      getStreakCalendar(session.user.id, 90),
    ])

    return NextResponse.json({
      currentStreak: user?.currentStreak || 0,
      longestStreak: user?.longestStreak || 0,
      freezeAvailable: user?.streakFreezeAvailable || 0,
      calendar,
    })
  } catch {
    return NextResponse.json({
      currentStreak: 0,
      longestStreak: 0,
      freezeAvailable: 0,
      calendar: [],
    })
  }
}
