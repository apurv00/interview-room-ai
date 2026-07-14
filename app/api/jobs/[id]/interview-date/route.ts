import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import mongoose from 'mongoose'
import { ProductEvent } from '@shared/db/models'
import { dateForChoice, setInterviewDate } from '@jobs'
import { logger } from '@shared/logger'

export const dynamic = 'force-dynamic'

/**
 * POST /api/jobs/[id]/interview-date — the §4c sheet's capture. Body is
 * EITHER {choice: tomorrow|this-week|next-week|not-sure} (server owns the
 * date math) or {date: ISO} for the picker. Emits
 * jobs.interview_scheduled{daysUntil, inferredFromPrep} server-side.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  const userId = (session?.user as { id?: string } | undefined)?.id
  if (!userId) return NextResponse.json({ error: 'sign in required' }, { status: 401 })
  if (!mongoose.Types.ObjectId.isValid(params.id)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  let capture: { date: Date | null; confidence: 'exact' | 'week' | 'unknown' } | null = null
  let inferredFromPrep = false
  try {
    const body = await req.json()
    inferredFromPrep = body?.inferredFromPrep === true
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
  try {
    await ProductEvent.create({
      name: 'jobs.interview_scheduled',
      userId,
      jobPostingId: params.id,
      props: { daysUntil: result.daysUntil, inferredFromPrep },
      ts: new Date(),
    })
  } catch (err) {
    logger.warn({ err }, 'interview_scheduled telemetry write failed')
  }
  return NextResponse.json({ ok: true, daysUntil: result.daysUntil })
}
