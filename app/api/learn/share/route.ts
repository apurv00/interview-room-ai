import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { generateShareToken, revokeShareToken } from '@learn/services/shareService'
import { connectDB } from '@shared/db/connection'
import { isJobsAccountActive } from '@shared/services/jobsAccountFence'

export const dynamic = 'force-dynamic'

function accountUnavailable() {
  return NextResponse.json(
    { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
    { status: 401 },
  )
}

export async function POST(req: Request) {
  let requesterUserId: string | undefined
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    requesterUserId = session.user.id

    await connectDB()
    if (!(await isJobsAccountActive(session.user.id))) {
      return accountUnavailable()
    }

    const { sessionId } = await req.json()
    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId required' }, { status: 400 })
    }

    const result = await generateShareToken(session.user.id, sessionId)
    if (!result) {
      if (!(await isJobsAccountActive(requesterUserId))) {
        return accountUnavailable()
      }
      return NextResponse.json({ error: 'Session not found or not completed' }, { status: 404 })
    }

    if (!(await isJobsAccountActive(session.user.id))) {
      return accountUnavailable()
    }

    return NextResponse.json(result)
  } catch {
    if (requesterUserId) {
      try {
        if (!(await isJobsAccountActive(requesterUserId))) {
          return accountUnavailable()
        }
      } catch {
        // Preserve the original route failure if the diagnostic check fails.
      }
    }
    return NextResponse.json({ error: 'Failed to generate share link' }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { sessionId } = await req.json()
    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId required' }, { status: 400 })
    }

    const success = await revokeShareToken(session.user.id, sessionId)
    return NextResponse.json({ success })
  } catch {
    return NextResponse.json({ error: 'Failed to revoke share link' }, { status: 500 })
  }
}
