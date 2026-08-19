import type { FacialSegment, ProsodySegment } from '@shared/types/multimodal'
import { HireMultimodalAnalysis } from '../models'
import type {
  HireMultimodalAnalysisStatus,
  HireMultimodalAnalysisSummary,
  HireMultimodalAnalysisTimelineEvent,
} from '../models/HireMultimodalAnalysis'

/**
 * Additive recruiter-facing contract. It deliberately carries every derived
 * Hire report artifact that was generated for the recorded interview, while
 * omitting raw landmark object keys, raw transcript/word transport payloads,
 * checksum values, media asset identifiers, and provider accounting fields.
 *
 * Mount this under an existing application-detail response as, for example,
 * `multimodalAnalysis`. It is independent of the recording-player DTO.
 */
export interface HireMultimodalAnalysisView {
  id: string
  roundId: string
  attemptId: string
  status: HireMultimodalAnalysisStatus
  capturedAt: string
  completedAt?: string
  retryAt?: string
  retryAttemptCount: number
  durationMs: number
  facialFrameCount: number | null
  report?: {
    metrics: {
      bodyLanguageScore: number | null
      eyeContactScore: number | null
      facialFrameCount: number | null
    }
    prosodySegments: ProsodySegment[]
    facialSegments: FacialSegment[]
    facialTimeseries: FacialSegment[]
    timeline: HireMultimodalAnalysisTimelineEvent[]
    summary: HireMultimodalAnalysisSummary
  }
}

interface AnalysisViewDocument {
  _id: { toString(): string }
  roundId: { toString(): string }
  attemptId: { toString(): string }
  status: HireMultimodalAnalysisStatus
  capturedAt: Date
  completedAt?: Date
  retryAt?: Date
  retryAttemptCount?: number
  durationMs: number
  facialFrameCount?: number
  prosodySegments?: ProsodySegment[]
  facialSegments?: FacialSegment[]
  facialTimeseries?: FacialSegment[]
  timeline?: HireMultimodalAnalysisTimelineEvent[]
  summary?: HireMultimodalAnalysisSummary
}

export function presentHireMultimodalAnalysis(
  analysis: AnalysisViewDocument,
): HireMultimodalAnalysisView {
  const facialFrameCount = typeof analysis.facialFrameCount === 'number'
    ? analysis.facialFrameCount
    : null
  const base: HireMultimodalAnalysisView = {
    id: analysis._id.toString(),
    roundId: analysis.roundId.toString(),
    attemptId: analysis.attemptId.toString(),
    status: analysis.status,
    capturedAt: analysis.capturedAt.toISOString(),
    ...(analysis.completedAt ? { completedAt: analysis.completedAt.toISOString() } : {}),
    ...(analysis.retryAt ? { retryAt: analysis.retryAt.toISOString() } : {}),
    retryAttemptCount: analysis.retryAttemptCount ?? 0,
    durationMs: analysis.durationMs,
    facialFrameCount,
  }
  if (analysis.status !== 'completed' || !analysis.summary) return base
  return {
    ...base,
    report: {
      metrics: {
        bodyLanguageScore: analysis.summary.bodyLanguageScore,
        eyeContactScore: analysis.summary.eyeContactScore,
        facialFrameCount,
      },
      prosodySegments: analysis.prosodySegments ?? [],
      facialSegments: analysis.facialSegments ?? [],
      facialTimeseries: analysis.facialTimeseries ?? [],
      timeline: analysis.timeline ?? [],
      summary: analysis.summary,
    },
  }
}

/** Returns the latest report attempt for the application, regardless of
 * processing state, so the recruiter can see pending/failed/completed state. */
export async function getHireMultimodalAnalysisView(input: {
  workspaceId: string
  applicationId: string
}): Promise<HireMultimodalAnalysisView | null> {
  const analysis = await HireMultimodalAnalysis.findOne({
    workspaceId: input.workspaceId,
    applicationId: input.applicationId,
  })
    .sort({ capturedAt: -1, createdAt: -1, _id: -1 })
    .select(
      '_id roundId attemptId status capturedAt completedAt retryAt retryAttemptCount durationMs facialFrameCount prosodySegments facialSegments facialTimeseries timeline summary',
    )
    .lean() as AnalysisViewDocument | null
  return analysis ? presentHireMultimodalAnalysis(analysis) : null
}

/**
 * Round-keyed application view for retakes/multiple AI rounds. The array is
 * newest-round first and contains only the latest analysis revision for each
 * round, so callers can attach `analysisByRoundId[round.id]` without mixing a
 * prior attempt into the current round card.
 */
export async function getHireMultimodalAnalysisViews(input: {
  workspaceId: string
  applicationId: string
}): Promise<HireMultimodalAnalysisView[]> {
  const analyses = await HireMultimodalAnalysis.find({
    workspaceId: input.workspaceId,
    applicationId: input.applicationId,
  })
    .sort({ capturedAt: -1, createdAt: -1, _id: -1 })
    .select(
      '_id roundId attemptId status capturedAt completedAt retryAt retryAttemptCount durationMs facialFrameCount prosodySegments facialSegments facialTimeseries timeline summary',
    )
    .lean() as AnalysisViewDocument[]
  const roundIds = new Set<string>()
  const views: HireMultimodalAnalysisView[] = []
  for (const analysis of analyses) {
    const roundId = analysis.roundId.toString()
    if (roundIds.has(roundId)) continue
    roundIds.add(roundId)
    views.push(presentHireMultimodalAnalysis(analysis))
  }
  return views
}
