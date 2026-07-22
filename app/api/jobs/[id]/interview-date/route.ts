import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import mongoose from 'mongoose'
import { dateForChoice, setInterviewDate, type InterviewDateStateToken } from '@jobs'
import { checkJobsRateLimit } from '@jobs/services/rateLimit'
import { JobsAccountInactiveError } from '@shared/services/jobsAccountFence'
import type { InterviewDateCapture } from '@jobs/config/prepPlan'

export const dynamic = 'force-dynamic'

/**
 * POST /api/jobs/[id]/interview-date — the §4c sheet's capture. Body is
 * EITHER {choice: tomorrow|this-week|next-week|not-sure} (server owns the
 * date math) or {date: ISO} for the picker, plus the outcome state token
 * displayed with that control. Deliberately emits NO event:
 * jobs.interview_scheduled has one emitter — the status route, on the
 * transition edge (Codex on #525) — and daysUntil is derivable from the
 * stored interviewDate.
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
  let capture: InterviewDateCapture | null = null
  let expectedState: InterviewDateStateToken | null = null
  try {
    const body = await req.json() as Record<string, unknown>
    if (
      Number.isSafeInteger(body?.expectedCompletedRounds) &&
      Number(body.expectedCompletedRounds) >= 0 && Number(body.expectedCompletedRounds) <= 100 &&
      Number.isSafeInteger(body?.expectedOutcomeRevision) &&
      Number(body.expectedOutcomeRevision) >= 0
    ) {
      expectedState = {
        interviewRounds: Number(body.expectedCompletedRounds),
        outcomeRevision: Number(body.expectedOutcomeRevision),
      }
    }
    if (['tomorrow', 'this-week', 'next-week', 'not-sure'].includes(String(body?.choice))) {
      capture = dateForChoice(body.choice as 'tomorrow' | 'this-week' | 'next-week' | 'not-sure')
    } else if (typeof body?.date === 'string') {
      // The control submits a calendar date, not an instant. Reject permissive
      // Date.parse inputs (timestamps and normalized impossible dates) so an
      // API caller cannot manufacture timing precision the user did not set.
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(body.date)
      if (match) {
        const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
        if (date.toISOString().slice(0, 10) === body.date) {
          capture = { date, confidence: 'exact' }
        }
      }
    }
  } catch { /* fallthrough */ }
  if (!capture || !expectedState) {
    return NextResponse.json({ error: 'choice or date and current outcome state required' }, { status: 400 })
  }

  await connectDB()
  let result: Awaited<ReturnType<typeof setInterviewDate>>
  try {
    result = await setInterviewDate(userId, params.id, capture, expectedState)
  } catch (error) {
    if (error instanceof JobsAccountInactiveError) {
      return NextResponse.json(
        { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
        { status: 401 },
      )
    }
    throw error
  }
  if (!result.ok) {
    if (result.reason === 'state-conflict') {
      return NextResponse.json({
        error: 'interview state changed; refresh and try again',
        code: 'INTERVIEW_STATE_CONFLICT',
      }, { status: 409 })
    }
    return NextResponse.json({ error: 'no application, or the date looks off' }, { status: 400 })
  }
  return NextResponse.json({ ok: true, daysUntil: result.daysUntil })
}
