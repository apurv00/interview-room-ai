import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { MultimodalAnalysis } from '@shared/db/models/MultimodalAnalysis'
import { isJobsAccountActive } from '@shared/services/jobsAccountFence'
import { logger } from '@shared/logger'

export const dynamic = 'force-dynamic'

function accountUnavailable() {
  return NextResponse.json(
    { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
    { status: 401 },
  )
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { sessionId: string } }
) {
  let requesterUserId: string | undefined
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    requesterUserId = session.user.id

    const { sessionId } = params

    await connectDB()
    if (!(await isJobsAccountActive(requesterUserId))) {
      return accountUnavailable()
    }

    const analysis = await MultimodalAnalysis.findOne({
      sessionId,
      userId: requesterUserId,
    })

    if (!analysis) {
      // A deletion sweep can remove the row after the initial account check.
      // Prefer the terminal account signal over a misleading missing-analysis
      // response for the same requester.
      if (!(await isJobsAccountActive(requesterUserId))) {
        return accountUnavailable()
      }
      return NextResponse.json({ error: 'Analysis not found' }, { status: 404 })
    }

    if (!(await isJobsAccountActive(requesterUserId))) {
      return accountUnavailable()
    }

    return NextResponse.json({
      status: analysis.status,
      timeline: analysis.timeline,
      fusionSummary: analysis.fusionSummary,
      prosodySegments: analysis.prosodySegments,
      facialSegments: analysis.facialSegments,
      whisperTranscript: analysis.whisperTranscript,
      whisperCostUsd: analysis.whisperCostUsd,
      claudeCostUsd: analysis.claudeCostUsd,
      totalCostUsd: analysis.totalCostUsd,
      processingDurationMs: analysis.processingDurationMs,
      error: analysis.error,
      completedAt: analysis.completedAt,
      createdAt: analysis.createdAt,
    })
  } catch (err) {
    if (requesterUserId) {
      try {
        if (!(await isJobsAccountActive(requesterUserId))) {
          return accountUnavailable()
        }
      } catch {
        // Preserve the original failure if the diagnostic recheck also fails.
      }
    }
    logger.error({ err, sessionId: params.sessionId }, 'Failed to get multimodal analysis')
    return NextResponse.json({ error: 'Failed to get analysis' }, { status: 500 })
  }
}
