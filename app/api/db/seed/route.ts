import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { seedDatabase } from '@shared/db/seed'

export const dynamic = 'force-dynamic'

export async function POST() {
  // Only platform_admin can seed
  const session = await getServerSession(authOptions)
  if (!session?.user || (session.user as { role?: string }).role !== 'platform_admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const result = await seedDatabase()
  return NextResponse.json({ message: 'Seed complete', ...result })
}
