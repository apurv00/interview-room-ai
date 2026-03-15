import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { generateShareToken, revokeShareToken } from '@learn/services/shareService'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { sessionId } = await req.json()
    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId required' }, { status: 400 })
    }

    const result = await generateShareToken(session.user.id, sessionId)
    if (!result) {
      return NextResponse.json({ error: 'Session not found or not completed' }, { status: 404 })
    }

    return NextResponse.json(result)
  } catch {
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
