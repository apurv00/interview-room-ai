import { NextResponse } from 'next/server'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models'
import { verifyActionToken } from '@shared/services/signedActionToken'

export const dynamic = 'force-dynamic'

/**
 * RFC 8058 one-click unsubscribe (EMAILS.md §3): mail clients POST here
 * from the List-Unsubscribe header. IMMEDIATE commit, 2xx, zero UI — the
 * caller is a robot; any confirm page breaks Gmail/Yahoo bulk-sender
 * compliance. Suppression is absolute over every send heuristic.
 */
export async function POST(req: Request) {
  const token = new URL(req.url).searchParams.get('token') ?? ''
  const verified = verifyActionToken(token, 'unsub')
  if (!verified.ok) return NextResponse.json({ ok: false }, { status: 400 })
  const scope = verified.payload.action
  if (!['e0', 'e1', 'e2', 'e3', 'e4', 'all'].includes(scope)) {
    return NextResponse.json({ ok: false }, { status: 400 })
  }
  await connectDB()
  await User.updateOne(
    { _id: verified.payload.uid },
    { $addToSet: { 'emailPreferences.jobs.unsubscribedStreams': scope } }
  )
  return NextResponse.json({ ok: true })
}
