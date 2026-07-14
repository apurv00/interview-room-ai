import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import mongoose from 'mongoose'
import { dateForChoice, setInterviewDate } from '@jobs'

export const dynamic = 'force-dynamic'

/**
 * POST /api/jobs/[id]/interview-date — the §4c sheet's capture. Body is
 * EITHER {choice: tomorrow|this-week|next-week|not-sure} (server owns the
 * date math) or {date: ISO} for the picker. Deliberately emits NO event:
 * jobs.interview_scheduled has one emitter — the status route, on the
 * transition edge (Codex on #525) — and daysUntil is derivable from the
 * stored interviewDate.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  const userId = (session?.user as { id?: string } | undefined)?.id
  if (!userId) return NextResponse.json({ error: 'sign in required' }, { status: 401 })
  if (!mongoose.Types.ObjectId.isValid(params.id)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  let capture: { date: Date | null; confidence: 'exact' | 'week' | 'unknown' } | null = null
  try {
    const body = await req.json()
    if (['tomorrow', 'this-week', 'next-week', 'not-sure'].includes(body?.choice)) {
      capture = dateForChoice(body.choice)
    } else if (typeof body?.date === 'string' && !Number.isNaN(Date.parse(body.date))) {
      capture = { date: new Date(body.date), confidence: 'exact' }
    }
  } catch { /* fallthrough */ }
  if (!capture) return NextResponse.json({ error: 'choice or date required' }, { status: 400 })

  await connectDB()
  const result = await setInterviewDate(userId, params.id, capture)
  if (!result.ok) return NextResponse.json({ error: 'no application, or the date looks off' }, { status: 400 })
  return NextResponse.json({ ok: true, daysUntil: result.daysUntil })
}
