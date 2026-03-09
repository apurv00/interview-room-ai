import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/authOptions'
import { UpdateSessionSchema } from '@/lib/validators/interview'
import { getSession, updateSession } from '@/lib/services/interviewService'
import { logger } from '@/lib/logger'
import { AppError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const interviewSession = await getSession(
      params.id,
      session.user.id,
      session.user.role,
      session.user.organizationId
    )

    return NextResponse.json(interviewSession)
  } catch (err) {
    if (err instanceof AppError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.statusCode })
    }
    logger.error({ err, sessionId: params.id }, 'Failed to get interview session')
    return NextResponse.json({ error: 'Failed to get session' }, { status: 500 })
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json()
    const validated = UpdateSessionSchema.parse(body)

    const updated = await updateSession(
      params.id,
      session.user.id,
      session.user.role,
      session.user.organizationId,
      validated
    )

    return NextResponse.json({ success: true, sessionId: updated._id.toString() })
  } catch (err) {
    if (err instanceof AppError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.statusCode })
    }
    logger.error({ err, sessionId: params.id }, 'Failed to update interview session')
    return NextResponse.json({ error: 'Failed to update session' }, { status: 500 })
  }
}
