import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import mongoose from 'mongoose'
import { dismissConfirmCard, saveNotes } from '@jobs'
import { checkJobsRateLimit } from '@jobs/services/rateLimit'
import { JobsAccountInactiveError } from '@shared/services/jobsAccountFence'

export const dynamic = 'force-dynamic'

/**
 * POST /api/jobs/[id]/nudge-dismiss — spends one unit of the anti-nag ask
 * budget (§4b: return-sheet was ask #1, the confirm card is ask #2; after
 * the budget the row reads "Clicked · not confirmed" forever, one-tap flip).
 * Also carries the tracker's inline notes save ({notes} body) — one small
 * authed mutation surface for the page.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  const userId = (session?.user as { id?: string } | undefined)?.id
  if (!userId) return NextResponse.json({ error: 'sign in required' }, { status: 401 })
  const rateLimitBlock = await checkJobsRateLimit(userId)
  if (rateLimitBlock) return rateLimitBlock
  if (!mongoose.Types.ObjectId.isValid(params.id)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  let notes: string | undefined
  try {
    const body = await req.json()
    if (typeof body?.notes === 'string') notes = body.notes
  } catch { /* plain dismiss */ }
  await connectDB()
  try {
    if (notes !== undefined) {
      const ok = await saveNotes(userId, params.id, notes)
      return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'no application' }, { status: 404 })
    }
    await dismissConfirmCard(userId, params.id)
  } catch (error) {
    if (error instanceof JobsAccountInactiveError) {
      return NextResponse.json(
        { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
        { status: 401 },
      )
    }
    throw error
  }
  return NextResponse.json({ ok: true })
}
