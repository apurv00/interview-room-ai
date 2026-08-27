import type {
  IHireInvitationBatch,
  IHireScreeningGate,
  ScreeningGatePreviewResult,
} from '@hire'
import type {
  JobScreeningMemberReadProjection,
  ScreeningMemberCandidateView,
} from '@hire-operations'

type ScreeningPreview = ScreeningGatePreviewResult['preview']
type ScreeningPreviewEntry = ScreeningPreview['rankedApplications'][number]

export const SCREENING_PREVIEW_PAGE_SIZE = 50
export type ScreeningPreviewPageScope =
  | 'selected'
  | 'evaluated'
  | 'attention'
  | 'knockouts'

export interface ScreeningPreviewPageSlice {
  scope: ScreeningPreviewPageScope
  rows: ScreeningPreviewEntry[]
  total: number
  offset: number
  hasPrevious: boolean
  hasNext: boolean
}

function candidateViewsByApplicationId(
  projection?: JobScreeningMemberReadProjection,
): Map<string, ScreeningMemberCandidateView> {
  return new Map(
    (projection?.candidates ?? []).map((candidate) => [candidate.applicationId, candidate]),
  )
}

export function sliceScreeningPreviewPage(
  preview: ScreeningPreview,
  scope: ScreeningPreviewPageScope,
  offset: number,
): ScreeningPreviewPageSlice {
  const source = scope === 'selected'
    ? preview.rankedApplications.filter((entry) => entry.selected)
    : scope === 'attention'
      ? preview.rankedApplications.filter((entry) => entry.scoreState !== 'scored')
      : scope === 'knockouts'
        ? preview.rankedApplications.filter((entry) => entry.knockoutReasons.length > 0)
        : preview.rankedApplications
  const normalizedOffset = Number.isSafeInteger(offset) && offset >= 0
    ? Math.min(offset, Math.max(0, source.length - (source.length % SCREENING_PREVIEW_PAGE_SIZE || SCREENING_PREVIEW_PAGE_SIZE)))
    : 0
  const rows = source.slice(
    normalizedOffset,
    normalizedOffset + SCREENING_PREVIEW_PAGE_SIZE,
  )
  return {
    scope,
    rows,
    total: source.length,
    offset: normalizedOffset,
    hasPrevious: normalizedOffset > 0,
    hasNext: normalizedOffset + rows.length < source.length,
  }
}

export function serializeScreeningPreview(
  preview: ScreeningPreview,
  page: ScreeningPreviewPageSlice & {
    previousCursor: string | null
    nextCursor: string | null
  },
  projection?: JobScreeningMemberReadProjection,
) {
  const candidates = candidateViewsByApplicationId(projection)
  const scoreStateCounts = preview.rankedApplications.reduce(
    (counts, entry) => {
      counts[entry.scoreState] += 1
      return counts
    },
    { scored: 0, stale: 0, unscored: 0 },
  )
  const cutLineApplicationId = preview.cutLine.applicationId
  return {
    workspaceId: preview.workspaceId,
    jobId: preview.jobId,
    rule: preview.rule,
    generatedAt: preview.generatedAt,
    evaluatedCount: preview.evaluatedCount,
    eligibleCount: preview.eligibleCount,
    automaticallySelectedCount: preview.automaticallySelectedCount,
    selectedCount: preview.selectedCount,
    scoreStateCounts,
    knownKnockoutCount: preview.rankedApplications.filter(
      (entry) => entry.knockoutReasons.length > 0,
    ).length,
    cutLine: {
      ...preview.cutLine,
      candidate: cutLineApplicationId
        ? candidates.get(cutLineApplicationId) ?? null
        : null,
    },
    exceptions: preview.exceptions,
    page: {
      scope: page.scope,
      rows: page.rows.map((entry) => ({
        ...entry,
        candidate: candidates.get(entry.applicationId) ?? null,
      })),
      total: page.total,
      offset: page.offset,
      hasPrevious: page.hasPrevious,
      previousCursor: page.previousCursor,
      hasNext: page.hasNext,
      nextCursor: page.nextCursor,
    },
  }
}

export function serializeInvitationBatch(
  batch: IHireInvitationBatch,
) {
  return {
    id: batch._id.toString(),
    screeningGateId: batch.screeningGateId.toString(),
    wave: batch.wave,
    sendAfter: batch.sendAfter,
    status: batch.status,
    plannedCount: batch.plannedCount,
    sentCount: batch.sentCount,
    failedCount: batch.failedCount,
    // Worker/provider detail may contain operational internals. The recipient
    // ledger carries a stable, controlled issue instead.
    lastError: batch.lastError
      ? 'One or more invitation deliveries need attention.'
      : null,
    completedAt: batch.completedAt ?? null,
    cancelledAt: batch.cancelledAt ?? null,
    createdByName: batch.createdByName,
    createdAt: batch.createdAt,
    // Recipient delivery is intentionally fetched from the bounded,
    // batch-scoped cursor endpoint only when a recruiter expands the ledger.
    recipients: [],
  }
}

/**
 * Explicit member-facing shape. PII is a current, authenticated read-time
 * join; it never comes from or writes back to the immutable gate snapshot.
 */
export function serializeScreeningGate(
  gate: IHireScreeningGate,
  batches: IHireInvitationBatch[] = [],
  hasMoreBatches = false,
) {
  const exceptions = gate.exceptions.filter((exception) => Boolean(exception.applicationId))
  const cutLineApplicationId = gate.cutLine.applicationId?.toString() ?? null

  return {
    id: gate._id.toString(),
    jobId: gate.jobId.toString(),
    status: gate.status,
    requirementVersion: {
      id: gate.requirementVersionId.toString(),
      version: gate.requirementVersion,
      contentHash: gate.requirementContentHash,
    },
    rule: {
      mode: gate.selectionMode,
      topN: gate.topN ?? null,
      scoreThreshold: gate.scoreThreshold ?? null,
      knockoutSettings: {
        location: gate.knockoutSettings.location ?? null,
        experienceFloorYears: gate.knockoutSettings.experienceFloorYears ?? null,
      },
    },
    cutLine: {
      mode: gate.cutLine.mode,
      requestedTopN: gate.cutLine.requestedTopN ?? null,
      scoreThreshold: gate.cutLine.scoreThreshold ?? null,
      applicationId: cutLineApplicationId,
      rank: gate.cutLine.rank ?? null,
      score: gate.cutLine.score ?? null,
    },
    counts: {
      evaluated: gate.evaluatedCount,
      eligible: gate.eligibleCount,
      automaticallySelected: gate.automaticallySelectedCount,
      selected: gate.selectedCount,
    },
    exceptionCount: exceptions.length,
    selectionHandoff: gate.selectionHandoff
      ? {
          actorName: gate.selectionHandoff.actorName,
          note: gate.selectionHandoff.note,
          at: gate.selectionHandoff.at,
        }
      : null,
    confirmedByName: gate.confirmedByName,
    confirmedAt: gate.confirmedAt,
    cancelledAt: gate.cancelledAt ?? null,
    cancelNote: gate.cancelNote ?? null,
    createdAt: gate.createdAt,
    batches: batches.map((batch) => serializeInvitationBatch(batch)),
    hasMoreBatches,
  }
}
