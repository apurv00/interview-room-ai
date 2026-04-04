import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { completeDailyTask } from '@learn/services/dailyPlanService'

export const dynamic = 'force-dynamic'

export async function PATCH(
  _req: NextRequest,
  { params }: { params: { taskId: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const success = await completeDailyTask(session.user.id, params.taskId)

  if (!success) {
    return NextResponse.json({ error: 'Task not found or already completed' }, { status: 404 })
  }

  return NextResponse.json({ success: true })
}
