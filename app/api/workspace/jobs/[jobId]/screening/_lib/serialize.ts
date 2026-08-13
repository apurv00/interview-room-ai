import type { IHireInvitationBatch, IHireScreeningGate } from '@hire'

export function serializeInvitationBatch(batch: IHireInvitationBatch) {
  return {
    id: batch._id.toString(),
    screeningGateId: batch.screeningGateId.toString(),
    wave: batch.wave,
    sendAfter: batch.sendAfter,
    status: batch.status,
    plannedCount: batch.plannedCount,
    sentCount: batch.sentCount,
    failedCount: batch.failedCount,
    lastError: batch.lastError ?? null,
    completedAt: batch.completedAt ?? null,
    cancelledAt: batch.cancelledAt ?? null,
    createdByName: batch.createdByName,
    createdAt: batch.createdAt,
  }
}

/** Explicit member-facing shape: no User references, recipient PII, or hidden worker claims. */
export function serializeScreeningGate(
  gate: IHireScreeningGate,
  batches: IHireInvitationBatch[] = [],
) {
  // Privacy cleanup removes whole snapshot entries rather than retaining
  // dangling identity coordinates. Filter defensively as well so a legacy or
  // partially-redacted record cannot stringify an absent ID into the member
  // response while a transaction is retried.
  const rankedApplications = gate.rankedApplications.filter(
    (entry) => Boolean(entry.applicationId && entry.candidateId),
  )
  const exceptions = gate.exceptions.filter((exception) => Boolean(exception.applicationId))

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
      applicationId: gate.cutLine.applicationId?.toString() ?? null,
      rank: gate.cutLine.rank ?? null,
      score: gate.cutLine.score ?? null,
    },
    counts: {
      evaluated: gate.evaluatedCount,
      eligible: gate.eligibleCount,
      automaticallySelected: gate.automaticallySelectedCount,
      selected: gate.selectedCount,
    },
    rankedApplications: rankedApplications.map((entry) => ({
      applicationId: entry.applicationId.toString(),
      candidateId: entry.candidateId.toString(),
      applicationCreatedAt: entry.applicationCreatedAt,
      rank: entry.rank ?? null,
      score: entry.score,
      scoreState: entry.scoreState,
      knockoutReasons: entry.knockoutReasons,
      automaticallySelected: entry.automaticallySelected,
      selected: entry.selected,
      selectionReason: entry.selectionReason,
    })),
    exceptions: exceptions.map((exception) => ({
      applicationId: exception.applicationId.toString(),
      action: exception.action,
      actorName: exception.actorName,
      note: exception.note,
      at: exception.at,
    })),
    confirmedByName: gate.confirmedByName,
    confirmedAt: gate.confirmedAt,
    cancelledAt: gate.cancelledAt ?? null,
    cancelNote: gate.cancelNote ?? null,
    createdAt: gate.createdAt,
    batches: batches.map(serializeInvitationBatch),
  }
}
