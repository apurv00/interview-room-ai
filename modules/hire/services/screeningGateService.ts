import { createHash } from 'node:crypto'
import mongoose, { type ClientSession } from 'mongoose'
import { AppError, NotFoundError } from '@shared/errors'
import {
  HIRE_SCREENING_GATE_SNAPSHOT_CAP,
  HireApplication,
  HireCandidate,
  HireInvitationBatch,
  HireInvitationBatchItem,
  HireJob,
  HireJobRequirementVersion,
  HirePrivacyRequest,
  HireRound,
  HireScreeningGate,
  TERMINAL_STAGES,
  activeHirePrivacyRequestFilter,
  type IHireApplication,
  type IHireCandidate,
  type IHireInvitationBatch,
  type IHireScreeningGate,
} from '../models'
import { connectHireControlDB } from './hireControlBoundary'
import {
  buildInvitationBatchItemPlan,
  buildScreeningGateConfirmation,
  previewScreeningGate,
  type ScreeningExceptionAction,
  type ScreeningGatePreview,
  type ScreeningGateRule,
  type ScreeningKnockoutSettings,
} from './screeningService'
import type { MembershipContext } from './workspaceService'
import { withActiveHireWorkspaceWriteTransaction } from './hireWorkspaceWriteFence'
import { assertHireOnboardingTestDriveWriteIsolation } from '@hire-onboarding-boundary'
import { readCandidateSelectionSnapshot } from '@hire-operations'

/** Durable, tenant-scoped screening preview and confirmation orchestration. */

const OBJECT_ID = /^[a-f0-9]{24}$/i
const FINGERPRINT = /^[a-f0-9]{64}$/i

/**
 * A confirmed wave intentionally fans out at a bounded, deterministic pace.
 * The batch's `sendAfter` remains its explicit human-selected base time; the
 * nth selected application is eligible exactly n minutes after that base.
 */
export const SCREENING_INVITATION_STAGGER_MS = 60_000

export interface ScreeningGateExceptionRequest {
  applicationId: string
  action: ScreeningExceptionAction
  note: string
}

export interface ScreeningGatePreviewRequest {
  rule: ScreeningGateRule
  exceptions?: ScreeningGateExceptionRequest[]
  selectionSnapshotId?: string
  selectionNote?: string
}

export interface ConfirmScreeningGateRequest extends ScreeningGatePreviewRequest {
  /** Proof that HR is confirming the exact, current preview they reviewed. */
  previewFingerprint: string
  /** Optional planned dispatch time for the future batch worker. */
  sendAfter?: Date | string
}

export interface ScreeningGatePreviewResult {
  preview: ScreeningGatePreview
  /** Active JD/requirements contract used to calculate this preview. */
  requirementVersion: {
    id: string
    version: number
    contentHash: string
  }
  /** SHA-256 of the deterministic, non-PII selection snapshot. */
  previewFingerprint: string
}

export interface ConfirmedScreeningGateResult extends ScreeningGatePreviewResult {
  gate: IHireScreeningGate
  batch: IHireInvitationBatch
  itemCount: number
}

export interface ScreeningGateListItem {
  gate: IHireScreeningGate
  batches: IHireInvitationBatch[]
  hasMoreBatches: boolean
}

export interface ScreeningGateListCursor {
  confirmedAt: Date
  id: string
}

export interface ScreeningGateListPage {
  items: ScreeningGateListItem[]
  nextCursor: ScreeningGateListCursor | null
}

interface ScreeningSource {
  job: {
    _id: mongoose.Types.ObjectId
    workspaceId: mongoose.Types.ObjectId
    status: string
    jdText: string
    screeningSettings?: ScreeningKnockoutSettings
    requirementVersionId: mongoose.Types.ObjectId
    requirementVersion: number
    requirementContentHash: string
  }
  applications: IHireApplication[]
  candidatesById: Map<string, IHireCandidate>
}

interface ResolvedSelectionHandoff {
  source: ScreeningSource
  manualIncludeApplicationIds: string[]
  audit?: Record<'selectionSnapshotId' | 'actorMemberId' | 'actorName' | 'note', string>
}

function requireObjectId(value: string, label: string): mongoose.Types.ObjectId {
  if (!OBJECT_ID.test(value)) {
    throw new AppError(`Invalid ${label}`, 400, 'INVALID_ID')
  }
  return new mongoose.Types.ObjectId(value)
}

function actorName(ctx: MembershipContext): string {
  return ctx.membership.name || ctx.membership.email
}

function idsEqual(
  left: string | mongoose.Types.ObjectId,
  right: string | mongoose.Types.ObjectId,
): boolean {
  return left.toString() === right.toString()
}

function currentProfile(candidate: IHireCandidate): {
  location?: string | null
  experienceYears?: number | null
} {
  const profile = candidate.screeningProfile
  // Every pool-resume writer replaces this profile with analysis bound to the
  // new resume or clears it. Treat an absent profile as UNKNOWN; screening
  // never needs to fetch the underlying resume body to prove that invariant.
  if (!profile) return {}
  return {
    ...(profile.location !== undefined ? { location: profile.location } : {}),
    ...(profile.experienceYears !== undefined
      ? { experienceYears: profile.experienceYears }
      : {}),
  }
}

function currentRanking(
  application: IHireApplication,
  candidate: IHireCandidate,
  currentJdText: string,
): { score?: number | null; stale?: boolean } {
  const match = application.resumeMatch
  if (!match) return {}
  const retainedSourceHashes = [
    candidate.screeningProfile?.resumeHash,
    ...(application.applicantSubmissions ?? []).map(
      (submission) => submission.match?.resumeHash,
    ),
  ].filter((hash): hash is string => Boolean(hash))

  return {
    score: match.score,
    stale:
      !retainedSourceHashes.includes(match.resumeHash) ||
      match.jdHash !== createHash('sha256').update(currentJdText).digest('hex'),
  }
}

function resolvedRule(
  request: ScreeningGatePreviewRequest,
  job: ScreeningSource['job'],
): ScreeningGateRule {
  return {
    ...request.rule,
    // Omitted means “use this job's saved default”; an explicit empty object
    // means HR chose to run this particular gate with no knockout rules.
    knockoutSettings: request.rule.knockoutSettings ?? {
      ...(job.screeningSettings?.location
        ? { location: job.screeningSettings.location }
        : {}),
      ...(job.screeningSettings?.experienceFloorYears !== undefined
        ? { experienceFloorYears: job.screeningSettings.experienceFloorYears }
        : {}),
    },
  }
}

function exceptionInputs(
  ctx: MembershipContext,
  exceptions: ScreeningGateExceptionRequest[] | undefined,
) {
  return (exceptions ?? []).map((exception) => ({
    applicationId: exception.applicationId,
    action: exception.action,
    note: exception.note,
    actorMemberId: ctx.membership._id,
    actorName: actorName(ctx),
  }))
}

async function resolveSelectionHandoff(ctx: MembershipContext, source: ScreeningSource,
  request: ScreeningGatePreviewRequest, now: Date, session?: ClientSession): Promise<ResolvedSelectionHandoff> {
  const selectionSnapshotId = request.selectionSnapshotId?.trim()
  const selectionNote = request.selectionNote?.trim()
  if (Boolean(selectionSnapshotId) !== Boolean(selectionNote)) {
    throw new AppError('A candidate selection and its documented inclusion rationale are required together', 422,
      'SCREENING_SELECTION_INVALID')
  }
  if (!selectionSnapshotId || !selectionNote) {
    return { source, manualIncludeApplicationIds: [] }
  }

  const snapshot = await readCandidateSelectionSnapshot(ctx, {
    jobId: source.job._id.toString(),
    selectionId: selectionSnapshotId,
    now,
    ...(session ? { session } : {}),
  })
  const currentApplications = new Map(source.applications.map((application) => [application._id.toString(), application]))
  const scopedApplications: IHireApplication[] = []
  for (const entry of snapshot.entries) {
    const application = currentApplications.get(entry.applicationId)
    if (!application || application.stage !== entry.expectedStage) {
      throw new AppError('The candidate selection changed or is no longer available for screening; return to Candidates and select again', 409,
        'SCREENING_SELECTION_STALE')
    }
    scopedApplications.push(application)
  }

  return {
    source: { ...source, applications: scopedApplications },
    manualIncludeApplicationIds: snapshot.entries.map((entry) => entry.applicationId),
    audit: { selectionSnapshotId, actorMemberId: ctx.membership._id.toString(), actorName: actorName(ctx), note: selectionNote },
  }
}

function buildPreview(ctx: MembershipContext, source: ScreeningSource, request: ScreeningGatePreviewRequest,
  now: Date, manualIncludeApplicationIds: string[] = []): ScreeningGatePreview {
  return previewScreeningGate({
    workspaceId: source.job.workspaceId,
    jobId: source.job._id,
    rule: resolvedRule(request, source.job),
    applications: source.applications.map((application) => {
      const candidate = source.candidatesById.get(application.candidateId.toString())
      if (!candidate) {
        // This is a hard stop rather than a silent omission. A human must
        // not confirm an invite list that is missing a candidate row.
        throw new AppError(
          'A candidate record changed while preparing this screening gate',
          409,
          'SCREENING_CANDIDATE_UNAVAILABLE',
        )
      }
      return {
        workspaceId: application.workspaceId,
        jobId: application.jobId,
        applicationId: application._id,
        candidateId: application.candidateId,
        createdAt: application.createdAt,
        candidateInfo: currentProfile(candidate),
        ranking: currentRanking(application, candidate, source.job.jdText),
      }
    }),
    manualIncludeApplicationIds,
    exceptions: exceptionInputs(ctx, request.exceptions),
    now,
  })
}

/**
 * Canonical non-PII selection proof. It deliberately excludes generated and
 * exception timestamps so the same still-current review can be confirmed in
 * a later request; it includes every value that can affect selected IDs.
 */
function fingerprintForPreview(
  preview: ScreeningGatePreview,
  source: ScreeningSource,
  selectionHandoff?: ResolvedSelectionHandoff['audit'],
): string {
  const canonical = {
    workspaceId: preview.workspaceId,
    jobId: preview.jobId,
    requirementVersion: {
      id: source.job.requirementVersionId.toString(),
      version: source.job.requirementVersion,
      contentHash: source.job.requirementContentHash,
    },
    rule: preview.rule,
    evaluatedCount: preview.evaluatedCount,
    eligibleCount: preview.eligibleCount,
    automaticallySelectedCount: preview.automaticallySelectedCount,
    selectedCount: preview.selectedCount,
    cutLine: preview.cutLine,
    rankedApplications: preview.rankedApplications.map((entry) => ({
      applicationId: entry.applicationId,
      candidateId: entry.candidateId,
      applicationCreatedAt: entry.applicationCreatedAt.toISOString(),
      rank: entry.rank ?? null,
      score: entry.score,
      scoreState: entry.scoreState,
      knockoutReasons: entry.knockoutReasons,
      automaticallySelected: entry.automaticallySelected,
      selected: entry.selected,
      selectionReason: entry.selectionReason,
    })),
    exceptions: preview.exceptions.map((exception) => ({
      applicationId: exception.applicationId,
      action: exception.action,
      note: exception.note,
    })),
    selectionHandoff: selectionHandoff ?? null,
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

function assertJobOpen(source: ScreeningSource): void {
  if (source.job.status !== 'open') {
    throw new AppError(
      'Screening gates can only be confirmed while the job is open',
      409,
      'JOB_NOT_OPEN',
    )
  }
}

/**
 * Load a complete current screening source. Child collections are always
 * constrained by the workspace; application records are additionally fenced
 * by the job coordinate before any candidate profile is consulted.
 */
async function loadScreeningSource(input: {
  workspaceId: mongoose.Types.ObjectId
  jobId: mongoose.Types.ObjectId
  session?: ClientSession
  now?: Date
}): Promise<ScreeningSource> {
  const now = input.now ?? new Date()
  let jobQuery = HireJob.findOne({
    _id: input.jobId,
    workspaceId: input.workspaceId,
  }).select(
    '_id workspaceId status jdText screeningSettings activeRequirementVersionId activeRequirementVersion',
  )
  if (input.session) jobQuery = jobQuery.session(input.session)
  const job = await jobQuery
  if (!job) throw new NotFoundError('Job')
  if (!job.activeRequirementVersionId || !job.activeRequirementVersion) {
    throw new AppError(
      'This job has no active scoring requirement version',
      409,
      'JOB_REQUIREMENT_VERSION_INVALID',
    )
  }

  let requirementQuery = HireJobRequirementVersion.findOne({
    _id: job.activeRequirementVersionId,
    workspaceId: input.workspaceId,
    jobId: input.jobId,
    version: job.activeRequirementVersion,
    state: 'active',
  }).select('_id version contentHash')
  if (input.session) requirementQuery = requirementQuery.session(input.session)
  const requirement = await requirementQuery
  if (!requirement) {
    throw new AppError(
      'This job no longer has an active scoring requirement version',
      409,
      'JOB_REQUIREMENT_VERSION_INVALID',
    )
  }

  let applicationsQuery = HireApplication.find({
    workspaceId: input.workspaceId,
    jobId: input.jobId,
    stage: { $nin: TERMINAL_STAGES },
  })
    .sort({ createdAt: 1, _id: 1 })
    .limit(HIRE_SCREENING_GATE_SNAPSHOT_CAP + 1)
    .select(
      '_id workspaceId jobId candidateId stage createdAt resumeMatch.score resumeMatch.jdHash resumeMatch.resumeHash applicantSubmissions.match.resumeHash',
    )
  if (input.session) applicationsQuery = applicationsQuery.session(input.session)
  const applications = await applicationsQuery
  if (applications.length > HIRE_SCREENING_GATE_SNAPSHOT_CAP) {
    throw new AppError(
      `Screening gates support up to ${HIRE_SCREENING_GATE_SNAPSHOT_CAP} applications at once`,
      422,
      'SCREENING_SNAPSHOT_TOO_LARGE',
    )
  }

  // A manually-sent or previously-confirmed live round is already an active
  // invitation. Keep it out of a new preview so a confirmed gate represents
  // only candidates its worker can actually invite. Expired links are not
  // filtered: sendAiRound supersedes those explicitly and audibly.
  let liveRoundsQuery = HireRound.find({
    workspaceId: input.workspaceId,
    jobId: input.jobId,
    applicationId: { $in: applications.map((application) => application._id) },
    kind: 'ai',
    live: true,
    status: { $nin: ['completed', 'revoked'] },
    revokedAt: { $exists: false },
    inviteTokenExpiry: { $gt: now },
  }).select('applicationId')
  if (input.session) liveRoundsQuery = liveRoundsQuery.session(input.session)
  const liveRounds = applications.length > 0 ? await liveRoundsQuery : []
  const liveApplicationIds = new Set(liveRounds.map((round) => round.applicationId.toString()))
  const dispatchableApplications = applications.filter(
    (application) => !liveApplicationIds.has(application._id.toString()),
  )

  const dispatchableCandidateIds = dispatchableApplications.map(
    (application) => application.candidateId,
  )
  let privacyRequestsQuery = HirePrivacyRequest.find({
    workspaceId: input.workspaceId,
    candidateId: { $in: dispatchableCandidateIds },
    ...activeHirePrivacyRequestFilter(now),
  }).select('candidateId')
  if (input.session) privacyRequestsQuery = privacyRequestsQuery.session(input.session)
  const privacyRequests = dispatchableApplications.length > 0
    ? await privacyRequestsQuery
    : []
  const privacyProtectedCandidateIds = new Set(
    privacyRequests.map((request) => request.candidateId.toString()),
  )
  const reviewableApplications = dispatchableApplications.filter(
    (application) =>
      !privacyProtectedCandidateIds.has(application.candidateId.toString()),
  )

  const candidateIds = reviewableApplications.map((application) => application.candidateId)
  let candidatesQuery = HireCandidate.find({
    workspaceId: input.workspaceId,
    _id: { $in: candidateIds },
  }).select('_id workspaceId screeningProfile piiAnonymizedAt')
  if (input.session) candidatesQuery = candidatesQuery.session(input.session)
  const candidates = await candidatesQuery
  const candidatesById = new Map(candidates.map((candidate) => [candidate._id.toString(), candidate]))

  for (const application of reviewableApplications) {
    if (
      !idsEqual(application.workspaceId, input.workspaceId) ||
      !idsEqual(application.jobId, input.jobId)
    ) {
      throw new AppError(
        'A screening application was outside the requested job',
        409,
        'SCREENING_SCOPE_MISMATCH',
      )
    }
    const candidate = candidatesById.get(application.candidateId.toString())
    if (candidate && !idsEqual(candidate.workspaceId, input.workspaceId)) {
      throw new AppError(
        'A candidate record was outside the requested workspace',
        409,
        'SCREENING_SCOPE_MISMATCH',
      )
    }
  }
  const availableApplications = reviewableApplications.filter((application) => {
    const candidate = candidatesById.get(application.candidateId.toString())
    return Boolean(candidate && !candidate.piiAnonymizedAt)
  })

  return {
    job: {
      _id: job._id,
      workspaceId: job.workspaceId,
      status: job.status,
      jdText: job.jdText,
      requirementVersionId: requirement._id,
      requirementVersion: requirement.version,
      requirementContentHash: requirement.contentHash,
      ...(job.screeningSettings
        ? {
            screeningSettings: {
              ...(job.screeningSettings.location
                ? { location: job.screeningSettings.location }
                : {}),
              ...(job.screeningSettings.experienceFloorYears !== undefined
                ? { experienceFloorYears: job.screeningSettings.experienceFloorYears }
                : {}),
            },
          }
        : {}),
    },
    applications: availableApplications,
    candidatesById,
  }
}

function normalizeSendAfter(value: Date | string | undefined, now: Date): Date {
  if (value === undefined) return new Date(now.getTime())
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new AppError('sendAfter must be a valid date', 422, 'INVALID_SEND_AFTER')
  }
  return date
}

function objectIdFromPreview(value: string): mongoose.Types.ObjectId {
  return requireObjectId(value, 'screening snapshot id')
}

function isDuplicateKey(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: number }).code === 11000
}

export async function previewJobScreeningGate(ctx: MembershipContext, jobId: string,
  request: ScreeningGatePreviewRequest): Promise<ScreeningGatePreviewResult> {
  await connectHireControlDB()
  const previewedAt = new Date()
  try {
    const source = await loadScreeningSource({
      workspaceId: ctx.workspace._id,
      jobId: requireObjectId(jobId, 'job id'),
      now: previewedAt,
    })
    assertJobOpen(source)
    const resolved = await resolveSelectionHandoff(ctx, source, request, previewedAt)
    const preview = buildPreview(ctx, resolved.source, request, previewedAt, resolved.manualIncludeApplicationIds)
    return {
      preview,
      requirementVersion: {
        id: resolved.source.job.requirementVersionId.toString(),
        version: resolved.source.job.requirementVersion,
        contentHash: resolved.source.job.requirementContentHash,
      },
      previewFingerprint: fingerprintForPreview(preview, resolved.source, resolved.audit),
    }
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'SCREENING_UNKNOWN_APPLICATION') {
      throw new AppError(
        'The ranked queue changed — refresh the screening preview',
        409,
        'SCREENING_PREVIEW_STALE',
      )
    }
    throw error
  }
}

/** Confirm inside the job-fenced workspace write transaction. */
export async function confirmJobScreeningGate(ctx: MembershipContext, jobId: string,
  request: ConfirmScreeningGateRequest): Promise<ConfirmedScreeningGateResult> {
  await connectHireControlDB()
  const normalizedJobId = requireObjectId(jobId, 'job id')
  if (!FINGERPRINT.test(request.previewFingerprint)) {
    throw new AppError('The screening preview proof is invalid', 422, 'SCREENING_PREVIEW_INVALID')
  }
  const confirmedAt = new Date()
  const sendAfter = normalizeSendAfter(request.sendAfter, confirmedAt)

  try {
    return await withActiveHireWorkspaceWriteTransaction(
      ctx.workspace._id,
      ctx.membership._id,
      async (session) => {
        await assertHireOnboardingTestDriveWriteIsolation({
          workspaceId: ctx.workspace._id,
          jobId: normalizedJobId,
          session,
        })
        const jobClaim = await HireJob.updateOne(
          {
            _id: normalizedJobId,
            workspaceId: ctx.workspace._id,
            status: 'open',
          },
          { $inc: { intakeWriteVersion: 1 } },
          { session },
        )
        if (jobClaim.matchedCount !== 1) {
          const exists = await HireJob.exists({
            _id: normalizedJobId,
            workspaceId: ctx.workspace._id,
          }).session(session)
          if (!exists) throw new NotFoundError('Job')
          throw new AppError(
            'Screening gates can only be confirmed while the job is open',
            409,
            'JOB_NOT_OPEN',
          )
        }

        const source = await loadScreeningSource({
          workspaceId: ctx.workspace._id,
          jobId: normalizedJobId,
          session,
          now: confirmedAt,
        })
        assertJobOpen(source)
        const resolved = await resolveSelectionHandoff(ctx, source, request, confirmedAt, session)
        const preview = buildPreview(ctx, resolved.source, request, confirmedAt, resolved.manualIncludeApplicationIds)
        const previewFingerprint = fingerprintForPreview(preview, resolved.source, resolved.audit)
        if (previewFingerprint !== request.previewFingerprint) {
          throw new AppError(
            'The ranked queue changed — refresh the screening preview before confirming',
            409,
            'SCREENING_PREVIEW_STALE',
          )
        }

        const confirmation = buildScreeningGateConfirmation({
          preview,
          actor: { memberId: ctx.membership._id, name: actorName(ctx) },
          confirmedAt,
        })
        const itemPlan = buildInvitationBatchItemPlan(preview)

        // Serialize candidate privacy deletion against gate confirmation in a
        // single bounded database command rather than one round-trip per row.
        const selectedCandidateIds = Array.from(
          new Set(itemPlan.map((item) => item.candidateId)),
          objectIdFromPreview,
        )
        if (selectedCandidateIds.length > 0) {
          const privacyClaim = await HireCandidate.updateMany(
            {
              _id: { $in: selectedCandidateIds },
              workspaceId: ctx.workspace._id,
              piiAnonymizedAt: { $exists: false },
            },
            { $inc: { privacyWriteFenceVersion: 1 } },
            { session, timestamps: false },
          )
          if (privacyClaim.matchedCount !== selectedCandidateIds.length) {
            throw new AppError(
              'One or more selected candidates became unavailable; refresh the screening preview',
              409,
              'SCREENING_PREVIEW_STALE',
            )
          }
        }

        const gateId = new mongoose.Types.ObjectId()
        const batchId = new mongoose.Types.ObjectId()
        const [gate] = await HireScreeningGate.create(
          [
            {
              _id: gateId,
              workspaceId: ctx.workspace._id,
              jobId: normalizedJobId,
              requirementVersionId: source.job.requirementVersionId,
              requirementVersion: source.job.requirementVersion,
              requirementContentHash: source.job.requirementContentHash,
              status: confirmation.status,
              selectionMode: confirmation.selectionMode,
              ...(confirmation.topN !== undefined ? { topN: confirmation.topN } : {}),
              ...(confirmation.scoreThreshold !== undefined
                ? { scoreThreshold: confirmation.scoreThreshold }
                : {}),
              knockoutSettings: confirmation.knockoutSettings,
              cutLine: {
                ...confirmation.cutLine,
                ...(confirmation.cutLine.applicationId
                  ? { applicationId: objectIdFromPreview(confirmation.cutLine.applicationId) }
                  : {}),
              },
              evaluatedCount: confirmation.evaluatedCount,
              eligibleCount: confirmation.eligibleCount,
              automaticallySelectedCount: confirmation.automaticallySelectedCount,
              selectedCount: confirmation.selectedCount,
              rankedApplications: confirmation.rankedApplications.map((entry) => ({
                applicationId: objectIdFromPreview(entry.applicationId),
                candidateId: objectIdFromPreview(entry.candidateId),
                applicationCreatedAt: entry.applicationCreatedAt,
                ...(entry.rank !== undefined ? { rank: entry.rank } : {}),
                score: entry.score,
                scoreState: entry.scoreState,
                knockoutReasons: entry.knockoutReasons,
                automaticallySelected: entry.automaticallySelected,
                selected: entry.selected,
                selectionReason: entry.selectionReason,
              })),
              exceptions: confirmation.exceptions.map((exception) => ({
                applicationId: objectIdFromPreview(exception.applicationId),
                action: exception.action,
                actorMemberId: objectIdFromPreview(exception.actorMemberId),
                actorName: exception.actorName,
                note: exception.note,
                at: exception.at,
              })),
              ...(resolved.audit
                ? {
                    selectionHandoff: {
                      selectionSnapshotId: objectIdFromPreview(resolved.audit.selectionSnapshotId),
                      actorMemberId: objectIdFromPreview(resolved.audit.actorMemberId),
                      actorName: resolved.audit.actorName,
                      note: resolved.audit.note,
                      at: confirmedAt,
                    },
                  }
                : {}),
              confirmedByMemberId: ctx.membership._id,
              confirmedByName: actorName(ctx),
              confirmedAt,
            },
          ],
          { session },
        )
        const [batch] = await HireInvitationBatch.create(
          [
            {
              _id: batchId,
              workspaceId: ctx.workspace._id,
              jobId: normalizedJobId,
              screeningGateId: gateId,
              wave: 1,
              sendAfter,
              status: itemPlan.length === 0 ? 'completed' : 'planned',
              plannedCount: itemPlan.length,
              sentCount: 0,
              failedCount: 0,
              ...(itemPlan.length === 0 ? { completedAt: confirmedAt } : {}),
              createdByMemberId: ctx.membership._id,
              createdByName: actorName(ctx),
            },
          ],
          { session },
        )
        for (let offset = 0; offset < itemPlan.length; offset += 250) {
          await HireInvitationBatchItem.create(
            itemPlan.slice(offset, offset + 250).map((item, chunkIndex) => ({
              workspaceId: ctx.workspace._id,
              jobId: normalizedJobId,
              screeningGateId: gateId,
              invitationBatchId: batchId,
              applicationId: objectIdFromPreview(item.applicationId),
              candidateId: objectIdFromPreview(item.candidateId),
              ...(item.rank !== undefined ? { rank: item.rank } : {}),
              score: item.score,
              scoreState: item.scoreState,
              selectionReason: item.selectionReason,
              sendAfter: new Date(
                sendAfter.getTime() + (offset + chunkIndex) * SCREENING_INVITATION_STAGGER_MS,
              ),
              status: 'pending',
              attempts: 0,
            })),
            { session },
          )
        }
        return {
          gate,
          batch,
          itemCount: itemPlan.length,
          preview,
          requirementVersion: {
            id: source.job.requirementVersionId.toString(),
            version: source.job.requirementVersion,
            contentHash: source.job.requirementContentHash,
          },
          previewFingerprint,
        }
      },
    )
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'SCREENING_UNKNOWN_APPLICATION') {
      throw new AppError(
        'The ranked queue changed — refresh the screening preview before confirming',
        409,
        'SCREENING_PREVIEW_STALE',
      )
    }
    // The unique workspace/application index is the final concurrency guard:
    // two HR members cannot queue a duplicate interview invitation.
    if (isDuplicateKey(error)) {
      throw new AppError(
        'One or more selected candidates already has a screening invitation reserved',
        409,
        'SCREENING_APPLICATION_ALREADY_RESERVED',
      )
    }
    throw error
  }
}

/** List previous decisions and their (still-unsent) batch metadata. */
export async function listJobScreeningGates(
  ctx: MembershipContext,
  jobId: string,
  input: { limit: number; cursor?: ScreeningGateListCursor },
): Promise<ScreeningGateListPage> {
  await connectHireControlDB()
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 25) {
    throw new AppError('Screening history limit must be 1-25', 400, 'INVALID_LIMIT')
  }
  const normalizedJobId = requireObjectId(jobId, 'job id')
  const job = await HireJob.findOne({
    _id: normalizedJobId,
    workspaceId: ctx.workspace._id,
  }).select('_id')
  if (!job) throw new NotFoundError('Job')

  const cursorId = input.cursor
    ? requireObjectId(input.cursor.id, 'screening history cursor')
    : undefined
  const gatesPage = await HireScreeningGate.find({
    workspaceId: ctx.workspace._id,
    jobId: normalizedJobId,
    ...(input.cursor && cursorId
      ? {
          $or: [
            { confirmedAt: { $lt: input.cursor.confirmedAt } },
            { confirmedAt: input.cursor.confirmedAt, _id: { $lt: cursorId } },
          ],
        }
      : {}),
  })
    .sort({ confirmedAt: -1, _id: -1 })
    .limit(input.limit + 1)
    .select('-rankedApplications')
  const hasNextPage = gatesPage.length > input.limit
  const gates = gatesPage.slice(0, input.limit)
  const batchPages = await Promise.all(
    gates.map((gate) =>
      HireInvitationBatch.find({
        workspaceId: ctx.workspace._id,
        jobId: normalizedJobId,
        screeningGateId: gate._id,
      })
        // Wave is unique within a gate, so this order uses the existing exact
        // {workspaceId, screeningGateId, wave} index without a blocking sort.
        .sort({ wave: -1 })
        .limit(11),
    ),
  )
  const items = gates.map((gate, index) => ({
    gate,
    batches: batchPages[index].slice(0, 10),
    hasMoreBatches: batchPages[index].length > 10,
  }))
  const last = gates[gates.length - 1]
  return {
    items,
    nextCursor: hasNextPage && last
      ? { confirmedAt: last.confirmedAt, id: last._id.toString() }
      : null,
  }
}
