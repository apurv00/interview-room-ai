import { randomUUID } from 'node:crypto'
import mongoose, { type ClientSession } from 'mongoose'
import { logger } from '@shared/logger'
import { inngest } from '@shared/services/inngest'
import {
  HireAiInviteDelivery,
  HireApplication,
  HireAssessmentExport,
  HireCandidate,
  HireCandidateStatusLink,
  HireConsentReceipt,
  HireEmailOutbox,
  HireEngineHandoff,
  HireEngineIngestionEvent,
  HireExternalVerdict,
  HireGuestSession,
  HireHumanKitDelivery,
  HireHumanRound,
  HireHumanScorecard,
  HireIntakeTask,
  HireInterviewAttempt,
  HireInterviewKit,
  HireInterviewResult,
  HireInvitationBatch,
  HireInvitationBatchItem,
  HireJob,
  HireJobRequirementVersion,
  HireMediaAsset,
  HireMultimodalAnalysis,
  HireMultimodalAnalysisIngestionEvent,
  HireMultimodalObservation,
  HireMultimodalObservationIngestionEvent,
  HireMultimodalObservationPurgeObligation,
  HirePrivacyRequest,
  HireReportExport,
  HireRound,
  HireScreeningGate,
  HireSharePacket,
  HireWorkspace,
  activeHireWorkspaceLifecycleFilter,
  cancelHireAssessmentExports,
  cancelHireReportExportsForLifecycle,
  connectHireControlDB,
  deleteHireAssessmentExportObjects,
  deliverRuntimeRevocation,
  hireMediaStorageKindForAsset,
  hireMediaStorage,
  revokeCandidateStatusLinksForScope,
  type HireAssessmentExportCleanupTarget,
  type HireMediaCoordinate,
  type HireMediaStoragePort,
} from '../../hire/onboardingLifecycleBoundary'
import {
  HireOnboardingTestDrive,
  type IHireOnboardingTestDrive,
} from '../models'

/** Recovery remains deliberately small until the index rollout is owned. */
export const HIRE_ONBOARDING_TEST_DRIVE_CLEANUP_LIMIT = 20
const TEST_DRIVE_CLEANUP_LEASE_MS = 15 * 60 * 1000
const TEST_DRIVE_MEDIA_DELETE_BATCH_SIZE = 25
const TEST_DRIVE_LEGACY_STAGING_GRACE_MS = 60 * 60 * 1000
const TEST_DRIVE_STALE_MEDIA_PURGE_CLAIM_MS = 15 * 60 * 1000
const RUNTIME_REVOCATION_DELIVERY_BATCH_SIZE = 10
const TEST_DRIVE_RETENTION_PURGE_REASON = 'Practice test-drive retention elapsed'

export interface HireOnboardingTestDriveLifecycleActor {
  memberId: mongoose.Types.ObjectId | string
  name: string
}

interface TestDriveLifecycleScope {
  workspaceId: mongoose.Types.ObjectId | string
  memberId?: mongoose.Types.ObjectId | string
  at: Date
  cleanupAfter: Date
  reason: string
  actor?: HireOnboardingTestDriveLifecycleActor
  session: ClientSession
}

export interface HireOnboardingTestDriveCancellationResult {
  marked: number
  runtimeRoundIds: string[]
}

export interface HireOnboardingTestDriveCleanupResult {
  claimed: boolean
  purged: boolean
  failed: boolean
  skipped: boolean
  mediaObjectsDeleted: number
}

export interface HireOnboardingTestDriveCleanupReport {
  scanned: number
  claimed: number
  purged: number
  failed: number
  mediaObjectsDeleted: number
}

interface ClaimedTestDrive {
  testDrive: IHireOnboardingTestDrive
  claimToken: string
}

interface PreparedTestDriveForPurge {
  testDrive: IHireOnboardingTestDrive
  roundIds: string[]
  assessmentExportCleanupTargets: HireAssessmentExportCleanupTarget[]
}

function toObjectId(value: string, label: string): mongoose.Types.ObjectId {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new Error(`Invalid ${label} coordinate`)
  }
  return new mongoose.Types.ObjectId(value)
}

function idOf(value: { toString(): string }): string {
  return value.toString()
}

function stableActorName(value: string): string {
  const name = value.trim().slice(0, 120)
  return name || 'Workspace member'
}

function lifecycleActorUpdate(actor?: HireOnboardingTestDriveLifecycleActor) {
  if (!actor) return {}
  return {
    removedByMemberId: actor.memberId,
    removedByName: stableActorName(actor.name),
  }
}

function testDriveScope(testDrive: IHireOnboardingTestDrive) {
  return {
    workspaceId: testDrive.workspaceId,
    applicationId: testDrive.applicationId,
    jobId: testDrive.jobId,
    candidateId: testDrive.candidateId,
  }
}

function mediaCoordinate(asset: {
  _id: { toString(): string }
  workspaceId: { toString(): string }
  applicationId: { toString(): string }
  roundId: { toString(): string }
  attemptId: { toString(): string }
}): HireMediaCoordinate {
  return {
    workspaceId: idOf(asset.workspaceId),
    applicationId: idOf(asset.applicationId),
    roundId: idOf(asset.roundId),
    attemptId: idOf(asset.attemptId),
    assetId: idOf(asset._id),
  }
}

function cleanupFailureCode(error: unknown): string {
  if (error instanceof Error && error.name) return error.name.slice(0, 120)
  return 'TEST_DRIVE_CLEANUP_FAILED'
}

function stagingWriterStillOwnsTestDriveMedia(asset: {
  state: string
  ingestionLeaseId?: string
  ingestionLeaseExpiresAt?: Date
  createdAt?: Date
}, now: Date): boolean {
  if (asset.state !== 'staging') return false
  if (asset.ingestionLeaseExpiresAt) {
    return asset.ingestionLeaseExpiresAt.getTime() > now.getTime()
  }
  if (asset.ingestionLeaseId) return true
  return !asset.createdAt
    || asset.createdAt.getTime() > now.getTime() - TEST_DRIVE_LEGACY_STAGING_GRACE_MS
}

function boundedLimit(value: number | undefined): number {
  const candidate = value ?? HIRE_ONBOARDING_TEST_DRIVE_CLEANUP_LIMIT
  if (!Number.isInteger(candidate)) return HIRE_ONBOARDING_TEST_DRIVE_CLEANUP_LIMIT
  return Math.min(Math.max(candidate, 1), HIRE_ONBOARDING_TEST_DRIVE_CLEANUP_LIMIT)
}

async function workspaceIsActive(workspaceId: mongoose.Types.ObjectId): Promise<boolean> {
  const workspace = await HireWorkspace.exists({
    _id: workspaceId,
    ...activeHireWorkspaceLifecycleFilter(),
  })
  return Boolean(workspace)
}

/**
 * Mark a member's practice graph inactive in the caller's transaction, then
 * revoke only still-live AI rounds. Runtime delivery must happen after that
 * transaction commits, through deliverHireOnboardingTestDriveRuntimeRevocations.
 */
export async function cancelHireOnboardingTestDrivesForMember(
  input: TestDriveLifecycleScope,
): Promise<HireOnboardingTestDriveCancellationResult> {
  if (!input.memberId) return { marked: 0, runtimeRoundIds: [] }
  return cancelHireOnboardingTestDrives({ ...input, memberId: input.memberId })
}

/**
 * Workspace deletion marks every live practice graph inactive. Callers that
 * already revoke the complete workspace round set can leave revokeRounds off
 * to keep one authoritative runtime-delivery loop.
 */
export async function cancelHireOnboardingTestDrivesForWorkspace(
  input: Omit<TestDriveLifecycleScope, 'memberId'> & { revokeRounds?: boolean },
): Promise<HireOnboardingTestDriveCancellationResult> {
  return cancelHireOnboardingTestDrives({
    ...input,
    revokeRounds: input.revokeRounds,
  })
}

async function cancelHireOnboardingTestDrives(
  input: TestDriveLifecycleScope & { revokeRounds?: boolean },
): Promise<HireOnboardingTestDriveCancellationResult> {
  const markerFilter = {
    workspaceId: input.workspaceId,
    active: true,
    ...(input.memberId ? { issuedByMemberId: input.memberId } : {}),
  }
  const testDrives = await HireOnboardingTestDrive.find(markerFilter).session(input.session)
  if (testDrives.length === 0) return { marked: 0, runtimeRoundIds: [] }

  await HireOnboardingTestDrive.updateMany(
    {
      _id: { $in: testDrives.map((testDrive) => testDrive._id) },
      workspaceId: input.workspaceId,
      active: true,
    },
    {
      $set: {
        state: 'removed',
        active: false,
        removedAt: input.at,
        cleanupAfter: input.cleanupAfter,
        ...lifecycleActorUpdate(input.actor),
      },
      $unset: {
        cleanupClaimToken: 1,
        cleanupClaimedAt: 1,
        cleanupLeaseExpiresAt: 1,
        cleanupLastError: 1,
      },
    },
    { session: input.session },
  )

  if (input.revokeRounds === false) {
    return { marked: testDrives.length, runtimeRoundIds: [] }
  }

  const applicationIds = testDrives.map((testDrive) => testDrive.applicationId)
  const activeRounds = await HireRound.find(
    {
      workspaceId: input.workspaceId,
      applicationId: { $in: applicationIds },
      status: { $nin: ['completed', 'revoked'] },
      revokedAt: { $exists: false },
    },
    { _id: 1 },
  ).session(input.session)
  const roundIds = activeRounds.map((round) => round._id)
  if (roundIds.length === 0) {
    return { marked: testDrives.length, runtimeRoundIds: [] }
  }

  await HireRound.updateMany(
    {
      workspaceId: input.workspaceId,
      applicationId: { $in: applicationIds },
      _id: { $in: roundIds },
      status: { $nin: ['completed', 'revoked'] },
      revokedAt: { $exists: false },
    },
    {
      $set: {
        status: 'revoked',
        revokedAt: input.at,
        revocationState: 'pending',
        revocationReason: input.reason,
        ...(input.actor
          ? {
              revokedByMemberId: input.actor.memberId,
              revokedByName: stableActorName(input.actor.name),
            }
          : {}),
      },
      $unset: { live: 1, revocationFailureCode: 1 },
    },
    { session: input.session },
  )
  await HireGuestSession.updateMany(
    {
      workspaceId: input.workspaceId,
      applicationId: { $in: applicationIds },
      roundId: { $in: roundIds },
      active: true,
    },
    { $set: { revokedAt: input.at }, $unset: { active: 1 } },
    { session: input.session },
  )
  await HireEngineHandoff.updateMany(
    {
      workspaceId: input.workspaceId,
      applicationId: { $in: applicationIds },
      roundId: { $in: roundIds },
      revokedAt: { $exists: false },
    },
    { $set: { revokedAt: input.at } },
    { session: input.session },
  )
  await HireInterviewAttempt.updateMany(
    {
      workspaceId: input.workspaceId,
      applicationId: { $in: applicationIds },
      roundId: { $in: roundIds },
      live: true,
      status: { $ne: 'completed' },
    },
    { $set: { status: 'revoked' }, $unset: { live: 1 } },
    { session: input.session },
  )

  return {
    marked: testDrives.length,
    runtimeRoundIds: roundIds.map((roundId) => idOf(roundId)),
  }
}

/**
 * Control-plane state commits before this best-effort delivery. A false
 * result stays durable as a failed round and the established runtime retry
 * worker owns future confirmation.
 */
export async function deliverHireOnboardingTestDriveRuntimeRevocations(input: {
  workspaceId: string
  roundIds: string[]
}): Promise<{ requested: number; confirmed: number }> {
  const roundIds = Array.from(
    new Set(input.roundIds.filter((roundId) => mongoose.Types.ObjectId.isValid(roundId))),
  )
  let confirmed = 0
  for (let offset = 0; offset < roundIds.length; offset += RUNTIME_REVOCATION_DELIVERY_BATCH_SIZE) {
    const outcomes = await Promise.all(
      roundIds.slice(offset, offset + RUNTIME_REVOCATION_DELIVERY_BATCH_SIZE).map(async (roundId) => {
        try {
          return await deliverRuntimeRevocation(input.workspaceId, roundId)
        } catch {
          // The control-plane revocation is already committed. Treat an
          // unavailable runtime bridge like its ordinary false result so the
          // established retry worker can recover it from durable state.
          return false
        }
      }),
    )
    confirmed += outcomes.filter(Boolean).length
  }
  return { requested: roundIds.length, confirmed }
}

export async function listDueHireOnboardingTestDriveIds(input: {
  workspaceId: string
  now?: Date
  limit?: number
}): Promise<string[]> {
  await connectHireControlDB()
  const workspaceId = toObjectId(input.workspaceId, 'workspace')
  if (!(await workspaceIsActive(workspaceId))) return []
  const drives = await HireOnboardingTestDrive.find({
    workspaceId,
    cleanupAfter: { $lte: input.now ?? new Date() },
  })
    .sort({ cleanupAfter: 1, _id: 1 })
    .limit(boundedLimit(input.limit))
    .select('_id')
    .lean()
  return drives.map((testDrive) => idOf(testDrive._id))
}

/**
 * Best-effort post-commit wakeup for one already-durable marker. The recovery
 * sweep remains authoritative when event delivery is unavailable, and the
 * event carries only opaque database coordinates.
 */
export async function kickHireOnboardingTestDriveCleanup(input: {
  workspaceId: string
  testDriveId: string
}): Promise<boolean> {
  try {
    await inngest.send({
      name: 'hire/onboarding-test-drive.cleanup-requested',
      data: input,
    })
    return true
  } catch (error) {
    logger.warn(
      { workspaceId: input.workspaceId, testDriveId: input.testDriveId, error },
      'hire onboarding test-drive cleanup dispatch failed; durable recovery will retry',
    )
    return false
  }
}

/**
 * Use after a member-removal transaction commits. It finds only markers that
 * are already due, so a workspace's delayed deletion schedule is never
 * accelerated by a best-effort event.
 */
export async function kickDueHireOnboardingTestDriveCleanups(input: {
  workspaceId: string
  now?: Date
}): Promise<{ discovered: number; dispatched: number }> {
  try {
    const testDriveIds = await listDueHireOnboardingTestDriveIds({
      workspaceId: input.workspaceId,
      now: input.now,
    })
    let dispatched = 0
    for (const testDriveId of testDriveIds) {
      if (await kickHireOnboardingTestDriveCleanup({
        workspaceId: input.workspaceId,
        testDriveId,
      })) {
        dispatched += 1
      }
    }
    return { discovered: testDriveIds.length, dispatched }
  } catch (error) {
    logger.warn(
      { workspaceId: input.workspaceId, error },
      'hire onboarding due-cleanup discovery failed; durable recovery will retry',
    )
    return { discovered: 0, dispatched: 0 }
  }
}

async function claimTestDriveForCleanup(input: {
  workspaceId: mongoose.Types.ObjectId
  testDriveId: mongoose.Types.ObjectId
  now: Date
}): Promise<ClaimedTestDrive | null> {
  const claimToken = randomUUID()
  const testDrive = await HireOnboardingTestDrive.findOneAndUpdate(
    {
      _id: input.testDriveId,
      workspaceId: input.workspaceId,
      cleanupAfter: { $lte: input.now },
      $or: [
        { cleanupClaimToken: { $exists: false } },
        { cleanupLeaseExpiresAt: { $exists: false } },
        { cleanupLeaseExpiresAt: { $lte: input.now } },
      ],
    },
    {
      $set: {
        cleanupClaimToken: claimToken,
        cleanupClaimedAt: input.now,
        cleanupLeaseExpiresAt: new Date(input.now.getTime() + TEST_DRIVE_CLEANUP_LEASE_MS),
      },
      $inc: { cleanupAttempts: 1 },
      $unset: { cleanupLastError: 1 },
    },
    { new: true },
  )
  return testDrive ? { testDrive, claimToken } : null
}

async function renewTestDriveCleanupLease(input: {
  workspaceId: mongoose.Types.ObjectId
  testDriveId: mongoose.Types.ObjectId
  claimToken: string
  now: Date
}): Promise<void> {
  const renewed = await HireOnboardingTestDrive.updateOne(
    {
      _id: input.testDriveId,
      workspaceId: input.workspaceId,
      cleanupClaimToken: input.claimToken,
    },
    {
      $set: {
        cleanupLeaseExpiresAt: new Date(input.now.getTime() + TEST_DRIVE_CLEANUP_LEASE_MS),
      },
    },
  )
  if (renewed.matchedCount !== 1) throw new Error('Test-drive cleanup lease was lost')
}

async function releaseFailedTestDriveCleanup(input: {
  workspaceId: mongoose.Types.ObjectId
  testDriveId: mongoose.Types.ObjectId
  claimToken: string
  error: unknown
}): Promise<void> {
  await HireOnboardingTestDrive.updateOne(
    {
      _id: input.testDriveId,
      workspaceId: input.workspaceId,
      cleanupClaimToken: input.claimToken,
    },
    {
      $set: { cleanupLastError: cleanupFailureCode(input.error) },
      $unset: {
        cleanupClaimToken: 1,
        cleanupClaimedAt: 1,
        cleanupLeaseExpiresAt: 1,
      },
    },
  )
}

async function prepareTestDriveForPurge(input: {
  workspaceId: mongoose.Types.ObjectId
  testDriveId: mongoose.Types.ObjectId
  claimToken: string
  now: Date
}): Promise<PreparedTestDriveForPurge> {
  const session = await mongoose.startSession()
  try {
    return await session.withTransaction(async () => {
      const workspace = await HireWorkspace.exists({
        _id: input.workspaceId,
        ...activeHireWorkspaceLifecycleFilter(),
      }).session(session)
      if (!workspace) throw new Error('Workspace is not active for test-drive cleanup')

      const testDrive = await HireOnboardingTestDrive.findOne({
        _id: input.testDriveId,
        workspaceId: input.workspaceId,
        cleanupClaimToken: input.claimToken,
      }).session(session)
      if (!testDrive) throw new Error('Test-drive cleanup claim is no longer authoritative')

      const markerUpdate: Record<string, unknown> = {
        state: 'removed',
        active: false,
      }
      if (!testDrive.removedAt) markerUpdate.removedAt = input.now
      await HireOnboardingTestDrive.updateOne(
        {
          _id: testDrive._id,
          workspaceId: input.workspaceId,
          cleanupClaimToken: input.claimToken,
        },
        { $set: markerUpdate },
        { session },
      )

      const scope = testDriveScope(testDrive)
      const rounds = await HireRound.find(scope, { _id: 1 }).session(session)
      const roundIds = rounds.map((round) => round._id)
      if (roundIds.length > 0) {
        await HireRound.updateMany(
          {
            ...scope,
            _id: { $in: roundIds },
            status: { $nin: ['completed', 'revoked'] },
            revokedAt: { $exists: false },
          },
          {
            $set: {
              status: 'revoked',
              revokedAt: input.now,
              revocationState: 'pending',
              revocationReason: TEST_DRIVE_RETENTION_PURGE_REASON,
            },
            $unset: { live: 1, revocationFailureCode: 1 },
          },
          { session },
        )
        await HireRound.updateMany(
          {
            ...scope,
            _id: { $in: roundIds },
            status: { $in: ['completed', 'revoked'] },
            revokedAt: { $exists: false },
          },
          {
            $set: {
              revokedAt: input.now,
              revocationState: 'pending',
              revocationReason: TEST_DRIVE_RETENTION_PURGE_REASON,
            },
            $unset: { live: 1, revocationFailureCode: 1 },
          },
          { session },
        )
        // A prior member revocation may already be confirmed. Runtime data
        // still requires a second, explicit personal-data purge acknowledgement
        // before the marker or its control-plane children can be deleted.
        await HireRound.updateMany(
          {
            ...scope,
            _id: { $in: roundIds },
            runtimePurgedAt: { $exists: false },
          },
          {
            $set: {
              runtimePurgeRequested: true,
              revocationState: 'pending',
              revocationReason: TEST_DRIVE_RETENTION_PURGE_REASON,
            },
            $unset: { live: 1, revocationFailureCode: 1 },
          },
          { session },
        )
        await HireGuestSession.updateMany(
          {
            workspaceId: testDrive.workspaceId,
            applicationId: testDrive.applicationId,
            roundId: { $in: roundIds },
            active: true,
          },
          { $set: { revokedAt: input.now }, $unset: { active: 1 } },
          { session },
        )
        await HireEngineHandoff.updateMany(
          {
            workspaceId: testDrive.workspaceId,
            applicationId: testDrive.applicationId,
            roundId: { $in: roundIds },
            revokedAt: { $exists: false },
          },
          { $set: { revokedAt: input.now } },
          { session },
        )
        await HireInterviewAttempt.updateMany(
          {
            workspaceId: testDrive.workspaceId,
            applicationId: testDrive.applicationId,
            roundId: { $in: roundIds },
            live: true,
            status: { $ne: 'completed' },
          },
          { $set: { status: 'revoked' }, $unset: { live: 1 } },
          { session },
        )
      }

      // Test-drive coordinates form an artificial identity boundary. Redact
      // every possession/public artifact before any synthetic parent can be
      // removed. Keep the work serial: a Mongo transaction cannot safely run
      // parallel model commands on its session.
      await revokeCandidateStatusLinksForScope({
        workspaceId: testDrive.workspaceId,
        applicationId: testDrive.applicationId,
        candidateId: testDrive.candidateId,
        reason: TEST_DRIVE_RETENTION_PURGE_REASON,
        at: input.now,
        session,
      })
      await HireSharePacket.updateMany(
        {
          ...scope,
          active: true,
          status: 'active',
          revokedAt: { $exists: false },
        },
        {
          $set: {
            active: false,
            status: 'revoked',
            revokedAt: input.now,
            revocationReason: TEST_DRIVE_RETENTION_PURGE_REASON,
          },
        },
        { session },
      )
      await HireSharePacket.updateMany(
        { ...scope, privacyRedactedAt: { $exists: false } },
        {
          $set: { privacyRedactedAt: input.now },
          $unset: { secretHash: 1, snapshot: 1 },
        },
        { session, overwriteImmutable: true },
      )
      await HireExternalVerdict.updateMany(
        { ...scope, privacyRedactedAt: { $exists: false } },
        {
          $set: { privacyRedactedAt: input.now },
          $unset: { comment: 1 },
        },
        { session, overwriteImmutable: true },
      )
      const assessmentExportCleanupTargets = await cancelHireAssessmentExports({
        scope,
        cancelledAt: input.now,
        privacyRedactedAt: input.now,
        session,
      })
      // Candidate-bearing workspace reports can include ordinary results, so
      // cancel/redact them by candidate. A synthetic job can also own a report
      // whose candidate list has not yet been populated; cancel that exact
      // job scope too. Both helpers first persist their own cleanup tombstone.
      await cancelHireReportExportsForLifecycle({
        scope: {
          workspaceId: testDrive.workspaceId,
          candidateId: testDrive.candidateId,
        },
        cancelledAt: input.now,
        session,
      })
      await cancelHireReportExportsForLifecycle({
        scope: {
          workspaceId: testDrive.workspaceId,
          jobId: testDrive.jobId,
        },
        cancelledAt: input.now,
        session,
      })
      return {
        testDrive,
        roundIds: roundIds.map((roundId) => idOf(roundId)),
        assessmentExportCleanupTargets,
      }
    })
  } finally {
    await session.endSession()
  }
}

async function deleteTestDriveMedia(input: {
  testDrive: IHireOnboardingTestDrive
  claimToken: string
  now: Date
  storage: HireMediaStoragePort
  clock: () => Date
}): Promise<number> {
  const scope = testDriveScope(input.testDrive)
  let deleted = 0
  for (;;) {
    const assets = await HireMediaAsset.find({
      ...scope,
      state: { $ne: 'purged' },
    })
      .select('+objectKeyNonce')
      .sort({ _id: 1 })
      .limit(TEST_DRIVE_MEDIA_DELETE_BATCH_SIZE)
    if (assets.length === 0) return deleted

    const claimAt = input.clock()
    if (assets.some((asset) => stagingWriterStillOwnsTestDriveMedia(asset, claimAt))) {
      throw new Error('Test-drive media ingestion lease is still active')
    }

    let firstFailure: unknown
    for (const candidate of assets) {
      const purgeClaimId = randomUUID()
      try {
        const asset = await HireMediaAsset.findOneAndUpdate(
          {
            _id: candidate._id,
            ...scope,
            objectKey: candidate.objectKey,
            ...(candidate.objectKeyNonce
              ? { objectKeyNonce: candidate.objectKeyNonce }
              : { objectKeyNonce: { $exists: false } }),
            $or: [
              { state: { $in: ['ready', 'purge_failed'] } },
              {
                state: 'staging',
                ingestionLeaseExpiresAt: { $lte: claimAt },
              },
              {
                state: 'staging',
                ingestionLeaseId: { $exists: false },
                ingestionLeaseExpiresAt: { $exists: false },
                createdAt: {
                  $lte: new Date(claimAt.getTime() - TEST_DRIVE_LEGACY_STAGING_GRACE_MS),
                },
              },
              ...(candidate.state === 'purge_claimed'
                && candidate.purgeClaimedAt
                && candidate.purgeClaimedAt.getTime()
                  <= claimAt.getTime() - TEST_DRIVE_STALE_MEDIA_PURGE_CLAIM_MS
                ? [{
                    state: 'purge_claimed' as const,
                    purgeClaimedAt: candidate.purgeClaimedAt,
                    ...(candidate.purgeClaimId
                      ? { purgeClaimId: candidate.purgeClaimId }
                      : { purgeClaimId: { $exists: false } }),
                  }]
                : []),
            ],
          },
          {
            $set: {
              state: 'purge_claimed',
              purgeClaimId,
              purgeClaimedAt: claimAt,
            },
            $unset: {
              active: 1,
              ingestionLeaseId: 1,
              ingestionLeaseExpiresAt: 1,
              purgeFailureCode: 1,
            },
          },
          { new: true },
        )
        if (!asset) throw new Error('Test-drive media purge claim is no longer authoritative')
        // Logical deletion is idempotent: legacy keys are physically deleted,
        // while v2 keys receive the same permanent zero-byte seal on retry.
        await input.storage.delete({
          key: asset.objectKey,
          coordinate: mediaCoordinate(asset),
          kind: hireMediaStorageKindForAsset(candidate.kind),
          objectKeyNonce: candidate.objectKeyNonce,
        })
        const finalized = await HireMediaAsset.updateOne(
          {
            _id: asset._id,
            ...scope,
            objectKey: asset.objectKey,
            state: 'purge_claimed',
            purgeClaimId,
          },
          {
            $set: { state: 'purged', purgedAt: input.clock() },
            $unset: {
              active: 1,
              ingestionLeaseId: 1,
              ingestionLeaseExpiresAt: 1,
              purgeClaimId: 1,
              purgeClaimedAt: 1,
              purgeFailureCode: 1,
            },
          },
        )
        if (finalized.modifiedCount !== 1) {
          throw new Error('Test-drive media purge claim changed before finalization')
        }
        deleted += finalized.modifiedCount
      } catch (error) {
        await HireMediaAsset.updateOne(
          {
            _id: candidate._id,
            ...scope,
            objectKey: candidate.objectKey,
            state: 'purge_claimed',
            purgeClaimId,
          },
          {
            $set: {
              state: 'purge_failed',
              purgeFailureCode: cleanupFailureCode(error),
            },
            $unset: {
              purgeClaimId: 1,
              purgeClaimedAt: 1,
              active: 1,
              ingestionLeaseId: 1,
              ingestionLeaseExpiresAt: 1,
            },
          },
        )
        firstFailure ??= error
      }
    }
    await renewTestDriveCleanupLease({
      workspaceId: input.testDrive.workspaceId,
      testDriveId: input.testDrive._id,
      claimToken: input.claimToken,
      now: input.clock(),
    })
    if (firstFailure) throw firstFailure
  }
}

async function deleteClaimedTestDriveGraph(input: {
  workspaceId: mongoose.Types.ObjectId
  testDriveId: mongoose.Types.ObjectId
  claimToken: string
  now: Date
}): Promise<void> {
  const session = await mongoose.startSession()
  try {
    await session.withTransaction(async () => {
      const workspace = await HireWorkspace.exists({
        _id: input.workspaceId,
        ...activeHireWorkspaceLifecycleFilter(),
      }).session(session)
      if (!workspace) throw new Error('Workspace is not active for test-drive cleanup')

      const testDrive = await HireOnboardingTestDrive.findOne({
        _id: input.testDriveId,
        workspaceId: input.workspaceId,
        cleanupClaimToken: input.claimToken,
      }).session(session)
      if (!testDrive) throw new Error('Test-drive cleanup claim is no longer authoritative')

      const scope = testDriveScope(testDrive)
      const unacknowledgedMedia = await HireMediaAsset.exists({
        ...scope,
        $or: [
          { state: { $ne: 'purged' } },
          { purgedAt: { $exists: false } },
          { ingestionLeaseId: { $exists: true } },
          { ingestionLeaseExpiresAt: { $exists: true } },
        ],
      }).session(session)
      if (unacknowledgedMedia) {
        throw new Error('Test-drive media deletion has not been acknowledged')
      }
      const runtimeWorkPending = await HireRound.exists({
        ...scope,
        runtimePurgeRequested: true,
        runtimePurgedAt: { $exists: false },
      }).session(session)
      if (runtimeWorkPending) {
        throw new Error('Test-drive runtime personal-data purge is still pending')
      }

      // Fail closed if a synthetic coordinate was ever joined to ordinary
      // work. The marker stays durable and reviewable; cleanup must never
      // silently delete a real application, candidate, or job graph.
      // MongoDB transactions do not support parallel model operations on one
      // session. Keep both isolation checks sequential so the transaction
      // never races its own session command stream.
      const otherCandidateApplication = await HireApplication.exists({
        workspaceId: testDrive.workspaceId,
        candidateId: testDrive.candidateId,
        _id: { $ne: testDrive.applicationId },
      }).session(session)
      const otherJobApplication = await HireApplication.exists({
        workspaceId: testDrive.workspaceId,
        jobId: testDrive.jobId,
        _id: { $ne: testDrive.applicationId },
      }).session(session)
      // A synthetic test drive never creates an intake task. A legacy task
      // with this job might contain an unrelated applicant's raw resume but
      // has no reliable candidate/application coordinate until it is parsed;
      // do not guess ownership and delete it. Keep the marker/graph for
      // review so cleanup never silently destroys ordinary candidate data.
      const unexpectedIntakeTask = await HireIntakeTask.exists({
        workspaceId: testDrive.workspaceId,
        jobId: testDrive.jobId,
      }).session(session)
      if (otherCandidateApplication || otherJobApplication || unexpectedIntakeTask) {
        throw new Error('Test-drive coordinates are no longer isolated')
      }

      // Delete edge/control rows first. No raw invite recovery material, guest
      // access record, consent receipt, status capability, decision evidence,
      // result, or media row can outlive the synthetic coordinate graph.
      await HireEmailOutbox.deleteMany(scope, { session })
      await HireAiInviteDelivery.deleteMany(scope, { session })
      await HireHumanKitDelivery.deleteMany(scope, { session })
      await HireInterviewKit.deleteMany(scope, { session })
      await HireHumanScorecard.deleteMany(scope, { session })
      await HireHumanRound.deleteMany(scope, { session })
      await HireGuestSession.deleteMany(scope, { session })
      await HireConsentReceipt.deleteMany(scope, { session })
      await HireEngineHandoff.deleteMany(
        {
          workspaceId: testDrive.workspaceId,
          applicationId: testDrive.applicationId,
        },
        { session },
      )
      await HireEngineIngestionEvent.deleteMany(
        {
          workspaceId: testDrive.workspaceId,
          applicationId: testDrive.applicationId,
        },
        { session },
      )
      const multimodalEventScope = {
        workspaceId: testDrive.workspaceId,
        applicationId: testDrive.applicationId,
        candidateId: testDrive.candidateId,
        roundId: testDrive.roundId,
      }
      await HireMultimodalObservationIngestionEvent.deleteMany(
        multimodalEventScope,
        { session },
      )
      await HireMultimodalObservation.deleteMany(scope, { session })
      await HireMultimodalObservationPurgeObligation.deleteMany(scope, { session })
      await HireMultimodalAnalysisIngestionEvent.deleteMany(
        multimodalEventScope,
        { session },
      )
      await HireMultimodalAnalysis.deleteMany(scope, { session })
      await HireInterviewResult.deleteMany(scope, { session })
      await HireInterviewAttempt.deleteMany(scope, { session })
      await HireMediaAsset.deleteMany(
        {
          ...scope,
          state: 'purged',
          purgedAt: { $exists: true },
          ingestionLeaseId: { $exists: false },
          ingestionLeaseExpiresAt: { $exists: false },
        },
        { session },
      )
      // Screening confirmation stores candidate/application snapshots and a
      // durable email-dispatch plan. These exact synthetic job rows must not
      // survive as either a reportable gate or a future delivery egress.
      await HireInvitationBatchItem.deleteMany(scope, { session })
      await HireInvitationBatch.deleteMany(
        { workspaceId: testDrive.workspaceId, jobId: testDrive.jobId },
        { session },
      )
      await HireScreeningGate.deleteMany(
        { workspaceId: testDrive.workspaceId, jobId: testDrive.jobId },
        { session },
      )
      await HireCandidateStatusLink.deleteMany(scope, { session })
      await HireExternalVerdict.deleteMany(scope, { session })
      await HireSharePacket.deleteMany(scope, { session })
      await HireAssessmentExport.deleteMany(scope, { session })
      await HirePrivacyRequest.deleteMany(
        { workspaceId: testDrive.workspaceId, candidateId: testDrive.candidateId },
        { session },
      )
      // A job-scoped export for the isolated synthetic job cannot contain any
      // ordinary work (the ownership checks above fail closed). Candidate-only
      // workspace reports remain as redacted/cancelled rows so they do not
      // delete unrelated report history; their cleanup tombstones survive.
      await HireReportExport.deleteMany(
        { workspaceId: testDrive.workspaceId, jobId: testDrive.jobId },
        { session },
      )

      // The marker is intentionally last. This strict dependency order leaves
      // the durable exclusion/recovery coordinate in place unless every child
      // safely disappears: round → application → candidate → requirement
      // version → job → marker.
      await HireRound.deleteMany(scope, { session })
      await HireApplication.deleteMany(
        {
          _id: testDrive.applicationId,
          workspaceId: testDrive.workspaceId,
          jobId: testDrive.jobId,
          candidateId: testDrive.candidateId,
        },
        { session },
      )
      await HireCandidate.deleteMany(
        { _id: testDrive.candidateId, workspaceId: testDrive.workspaceId },
        { session },
      )
      await HireJobRequirementVersion.deleteMany(
        { workspaceId: testDrive.workspaceId, jobId: testDrive.jobId },
        { session },
      )
      await HireJob.deleteMany(
        { _id: testDrive.jobId, workspaceId: testDrive.workspaceId },
        { session },
      )
      const removed = await HireOnboardingTestDrive.deleteOne(
        {
          _id: testDrive._id,
          workspaceId: testDrive.workspaceId,
          cleanupClaimToken: input.claimToken,
        },
        { session },
      )
      if (removed.deletedCount !== 1) {
        throw new Error('Test-drive cleanup claim changed before marker deletion')
      }
    })
  } finally {
    await session.endSession()
  }
}

/**
 * One exact marker cleanup. It leaves a marker and all coordinate children
 * intact on any failed runtime/media acknowledgement, so retries cannot lose
 * the only durable recovery handle.
 */
export async function purgeHireOnboardingTestDrive(input: {
  workspaceId: string
  testDriveId: string
  now?: Date
  storage?: HireMediaStoragePort
  clock?: () => Date
}): Promise<HireOnboardingTestDriveCleanupResult> {
  await connectHireControlDB()
  const workspaceId = toObjectId(input.workspaceId, 'workspace')
  const testDriveId = toObjectId(input.testDriveId, 'test-drive')
  const now = input.now ?? new Date()
  if (!(await workspaceIsActive(workspaceId))) {
    return { claimed: false, purged: false, failed: false, skipped: true, mediaObjectsDeleted: 0 }
  }
  const claim = await claimTestDriveForCleanup({ workspaceId, testDriveId, now })
  if (!claim) {
    return { claimed: false, purged: false, failed: false, skipped: true, mediaObjectsDeleted: 0 }
  }

  let mediaObjectsDeleted = 0
  try {
    const prepared = await prepareTestDriveForPurge({
      workspaceId,
      testDriveId,
      claimToken: claim.claimToken,
      now,
    })
    await renewTestDriveCleanupLease({
      workspaceId,
      testDriveId,
      claimToken: claim.claimToken,
      now,
    })
    const runtime = await deliverHireOnboardingTestDriveRuntimeRevocations({
      workspaceId: idOf(workspaceId),
      roundIds: prepared.roundIds,
    })
    if (runtime.confirmed !== runtime.requested) {
      throw new Error('Test-drive runtime personal-data purge is incomplete')
    }
    // Cancellation created durable tombstones inside the preparation
    // transaction. This eager exact-object delete is only an optimization;
    // its tombstone-backed worker remains authoritative after a crash/failure.
    await deleteHireAssessmentExportObjects(prepared.assessmentExportCleanupTargets)
    mediaObjectsDeleted = await deleteTestDriveMedia({
      testDrive: prepared.testDrive,
      claimToken: claim.claimToken,
      now,
      storage: input.storage ?? hireMediaStorage,
      clock: input.clock ?? (() => new Date()),
    })
    await renewTestDriveCleanupLease({
      workspaceId,
      testDriveId,
      claimToken: claim.claimToken,
      now: input.clock?.() ?? now,
    })
    await deleteClaimedTestDriveGraph({
      workspaceId,
      testDriveId,
      claimToken: claim.claimToken,
      now,
    })
    return { claimed: true, purged: true, failed: false, skipped: false, mediaObjectsDeleted }
  } catch (error) {
    await releaseFailedTestDriveCleanup({
      workspaceId,
      testDriveId,
      claimToken: claim.claimToken,
      error,
    })
    return { claimed: true, purged: false, failed: true, skipped: false, mediaObjectsDeleted }
  }
}

/** Bounded per-workspace recovery; unscoped enumeration belongs to the job. */
export async function purgeDueHireOnboardingTestDrives(input: {
  workspaceId: string
  now?: Date
  limit?: number
  storage?: HireMediaStoragePort
  clock?: () => Date
}): Promise<HireOnboardingTestDriveCleanupReport> {
  const ids = await listDueHireOnboardingTestDriveIds({
    workspaceId: input.workspaceId,
    now: input.now,
    limit: input.limit,
  })
  let claimed = 0
  let purged = 0
  let failed = 0
  let mediaObjectsDeleted = 0
  for (const testDriveId of ids) {
    const result = await purgeHireOnboardingTestDrive({
      workspaceId: input.workspaceId,
      testDriveId,
      now: input.now,
      storage: input.storage,
      clock: input.clock,
    })
    if (result.claimed) claimed += 1
    if (result.purged) purged += 1
    if (result.failed) failed += 1
    mediaObjectsDeleted += result.mediaObjectsDeleted
  }
  return {
    scanned: ids.length,
    claimed,
    purged,
    failed,
    mediaObjectsDeleted,
  }
}

export const __hireOnboardingTestDriveLifecycle = {
  TEST_DRIVE_CLEANUP_LEASE_MS,
  TEST_DRIVE_MEDIA_DELETE_BATCH_SIZE,
  TEST_DRIVE_LEGACY_STAGING_GRACE_MS,
  TEST_DRIVE_STALE_MEDIA_PURGE_CLAIM_MS,
  RUNTIME_REVOCATION_DELIVERY_BATCH_SIZE,
  mediaCoordinate,
  cleanupFailureCode,
  stagingWriterStillOwnsTestDriveMedia,
}
