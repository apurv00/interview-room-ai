import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { MultimodalAnalysis } from '@shared/db/models/MultimodalAnalysis'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  { params }: { params: { sessionId: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { sessionId } = params

  await connectDB()

  const analysis = await MultimodalAnalysis.findOne({
    sessionId,
    userId: session.user.id,
  })

  if (!analysis) {
    return NextResponse.json({ error: 'Analysis not found' }, { status: 404 })
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
}
