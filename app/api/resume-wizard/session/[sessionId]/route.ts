import { NextRequest, NextResponse } from 'next/server'
import { connectDB } from '@shared/db/connection'
import { WizardSession } from '@shared/db/models/WizardSession'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'

export const dynamic = 'force-dynamic'

export const GET = composeApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 20, keyPrefix: 'rl:wiz-get' },
  handler: async (req: NextRequest, { user, params }) => {
    await connectDB()

    const sessionId = params.sessionId
    if (!sessionId) {
      return NextResponse.json({ error: 'Session ID required' }, { status: 400 })
    }

    const session = await WizardSession.findById(sessionId).lean()
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }

    // Ownership check
    if (session.userId.toString() !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    return NextResponse.json({ session })
  },
})
