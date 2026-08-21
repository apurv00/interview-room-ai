import { randomUUID } from 'node:crypto'
import mongoose, { type ClientSession, type PipelineStage } from 'mongoose'
import {
  HireAssessmentExport,
  HireExternalVerdict,
  HireSharePacket,
} from '@hire-decisions/models'
import {
  HireApplication,
  HireCandidate,
  HireConsentReceipt,
  HireEmailOutbox,
  HireEngineIngestionEvent,
  HireHumanKitDelivery,
  HireHumanRound,
  HireHumanScorecard,
  HireInterviewAttempt,
  HireInterviewKit,
  HireInterviewResult,
  HireIntakeTask,
  HireInvitationBatchItem,
  HireJob,
  HireMediaAsset,
  HirePrivacyRequest,
  HireRound,
  HireScreeningGate,
  HireWorkspace,
  TERMINAL_STAGES,
  type IHireCandidate,
} from '../models'
import { connectHireControlDB } from './hireControlBoundary'
import { addCalendarMonths } from './mediaLifecycleService'
import {
  cancelHireAssessmentExports,
  deleteHireAssessmentExportObjects,
  type HireAssessmentExportCleanupTarget,
} from './assessmentExportLifecycleService'
import { cancelHireReportExportsForLifecycle } from '../../hire-reports/services/hireReportLifecycleService'
import { revokeCandidateStatusLinksForScope } from '../../hire-status/services/candidateStatusLinkService'
import { invalidateHireDigestAggregateSnapshotsForPrivacy } from '../../hire-digest/services/hireDigestService'
import {
  HireMultimodalObservation,
  HireMultimodalObservationIngestionEvent,
  HireMultimodalObservationPurgeObligation,
} from '../../hire-multimodal/models'

const DEFAULT_CANDIDATE_BATCH_SIZE = 100
const ANONYMIZATION_LEASE_MS = 15 * 60 * 1000
export const HIRE_CANDIDATE_RETENTION_MONTHS = 12

export interface HireCandidateRetentionReport {
  scanned: number
  claimed: number
  anonymized: number
  skipped: number
  failed: number
}

interface CandidateRetentionRow {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  lastActivityAt: Date
  retentionEligibleAt: Date
}

interface RetentionEligibility {
  eligible: boolean
  lastActivityAt?: Date
  retentionEligibleAt?: Date
  reason?:
    | 'no_applications'
    | 'live_application'
    | 'open_job'
    | 'privacy_request'
    | 'live_human_round'
    | 'live_human_kit'
    | 'live_share_packet'
    | 'live_assessment_export'
    | 'not_due'
}

function latestDate(values: Array<Date | null | undefined>): Date | undefined {
  let latest: Date | undefined
  for (const value of values) {
    if (!value || Number.isNaN(value.getTime())) continue
    if (!latest || value > latest) latest = value
  }
  return latest
}

function activityLookup(input: {
  from: string
  as: string
  activityExpression: unknown
}): PipelineStage.Lookup {
  return {
    $lookup: {
      from: input.from,
      let: { candidateId: '$_id', workspaceId: '$workspaceId' },
      pipeline: [
        {
          $match: {
            $expr: {
              $and: [
                { $eq: ['$candidateId', '$$candidateId'] },
                { $eq: ['$workspaceId', '$$workspaceId'] },
              ],
            },
          },
        },
        { $project: { _id: 0, activityAt: input.activityExpression } },
        { $sort: { activityAt: -1 as const } },
        { $limit: 1 },
      ],
      as: input.as,
    },
  }
}

/**
 * Database-side eligibility filter. The worker re-checks every condition in a
 * transaction after claiming; this pipeline exists to avoid old open jobs at
 * the front of the candidate collection starving truly due records.
 */
export function buildHireCandidateRetentionPipeline(
  workspaceId: mongoose.Types.ObjectId,
  now: Date,
  batchSize: number,
): PipelineStage[] {
  const activityArrays = [
    '$latestRounds',
    '$latestAttempts',
    '$latestResults',
    '$latestMultimodalObservations',
    '$latestMedia',
    '$latestConsents',
    '$latestHumanRounds',
    '$latestHumanKits',
    '$latestHumanScorecards',
    '$latestHumanKitDeliveries',
    '$latestSharePackets',
    '$latestExternalVerdicts',
    '$latestAssessmentExports',
  ].map((input) => ({
    $map: {
      input,
      as: 'activity',
      in: '$$activity.activityAt',
    },
  }))

  return [
    {
      $match: {
        workspaceId,
        piiAnonymizedAt: { $exists: false },
      },
    },
    {
      $lookup: {
        from: HireWorkspace.collection.name,
        localField: 'workspaceId',
        foreignField: '_id',
        as: 'workspaces',
      },
    },
    {
      $match: {
        'workspaces.0': { $exists: true },
        workspaces: { $not: { $elemMatch: { lifecycleState: 'deletion_pending' } } },
      },
    },
    {
      $lookup: {
        from: HireApplication.collection.name,
        let: { candidateId: '$_id', workspaceId: '$workspaceId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$candidateId', '$$candidateId'] },
                  { $eq: ['$workspaceId', '$$workspaceId'] },
                ],
              },
            },
          },
          { $project: { jobId: 1, stage: 1, updatedAt: 1 } },
        ],
        as: 'applications',
      },
    },
    {
      $match: {
        'applications.0': { $exists: true },
        applications: {
          $not: { $elemMatch: { stage: { $nin: [...TERMINAL_STAGES] } } },
        },
      },
    },
    { $set: { jobIds: { $setUnion: ['$applications.jobId', []] } } },
    {
      $lookup: {
        from: HireJob.collection.name,
        let: { jobIds: '$jobIds', workspaceId: '$workspaceId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $in: ['$_id', '$$jobIds'] },
                  { $eq: ['$workspaceId', '$$workspaceId'] },
                ],
              },
            },
          },
          { $project: { status: 1, closedAt: 1 } },
        ],
        as: 'jobs',
      },
    },
    {
      $match: {
        jobs: { $not: { $elemMatch: { status: { $ne: 'closed' } } } },
        $expr: { $eq: [{ $size: '$jobs' }, { $size: '$jobIds' }] },
      },
    },
    activityLookup({
      from: HireRound.collection.name,
      as: 'latestRounds',
      activityExpression: { $max: ['$invitedAt', '$consentAt', '$linkedAt'] },
    }),
    activityLookup({
      from: HireInterviewAttempt.collection.name,
      as: 'latestAttempts',
      activityExpression: {
        $max: ['$createdAt', '$startedAt', '$completedAt', '$failedAt'],
      },
    }),
    activityLookup({
      from: HireInterviewResult.collection.name,
      as: 'latestResults',
      activityExpression: '$completedAt',
    }),
    activityLookup({
      from: HireMultimodalObservation.collection.name,
      as: 'latestMultimodalObservations',
      activityExpression: '$observedAt',
    }),
    activityLookup({
      from: HireMediaAsset.collection.name,
      as: 'latestMedia',
      activityExpression: '$capturedAt',
    }),
    activityLookup({
      from: HireConsentReceipt.collection.name,
      as: 'latestConsents',
      activityExpression: '$acceptedAt',
    }),
    // Human rounds deliberately remain outside the engine-bound HireRound
    // graph. Their own timestamps count as subject activity for retention;
    // otherwise a freshly submitted human scorecard could be anonymized on
    // the older AI-only clock.
    activityLookup({
      from: HireHumanRound.collection.name,
      as: 'latestHumanRounds',
      activityExpression: { $max: ['$createdAt', '$updatedAt'] },
    }),
    activityLookup({
      from: HireInterviewKit.collection.name,
      as: 'latestHumanKits',
      activityExpression: { $max: ['$createdAt', '$updatedAt'] },
    }),
    activityLookup({
      from: HireHumanScorecard.collection.name,
      as: 'latestHumanScorecards',
      activityExpression: { $max: ['$createdAt', '$updatedAt'] },
    }),
    activityLookup({
      from: HireHumanKitDelivery.collection.name,
      as: 'latestHumanKitDeliveries',
      activityExpression: { $max: ['$createdAt', '$updatedAt'] },
    }),
    // Share packets and external verdicts are candidate-facing decision
    // artifacts in the same Hire control plane. Their creation, revocation,
    // and submitted verdict times must advance the subject retention clock.
    activityLookup({
      from: HireSharePacket.collection.name,
      as: 'latestSharePackets',
      activityExpression: {
        $max: ['$createdAt', '$updatedAt', '$verdictSubmittedAt', '$revokedAt'],
      },
    }),
    activityLookup({
      from: HireExternalVerdict.collection.name,
      as: 'latestExternalVerdicts',
      activityExpression: { $max: ['$createdAt', '$updatedAt', '$submittedAt'] },
    }),
    activityLookup({
      from: HireAssessmentExport.collection.name,
      as: 'latestAssessmentExports',
      activityExpression: {
        $max: ['$requestedAt', '$createdAt', '$updatedAt', '$readyAt', '$failedAt', '$cancelledAt'],
      },
    }),
    {
      $set: {
        activityDates: {
          $concatArrays: [
            ['$updatedAt'],
            {
              $map: {
                input: '$applications',
                as: 'application',
                in: '$$application.updatedAt',
              },
            },
            {
              $map: {
                input: '$jobs',
                as: 'job',
                in: '$$job.closedAt',
              },
            },
            ...activityArrays,
          ],
        },
      },
    },
    { $set: { lastActivityAt: { $max: '$activityDates' } } },
    {
      $set: {
        retentionEligibleAt: {
          $dateAdd: {
            startDate: '$lastActivityAt',
            unit: 'month',
            amount: HIRE_CANDIDATE_RETENTION_MONTHS,
          },
        },
      },
    },
    { $match: { retentionEligibleAt: { $lte: now } } },
    { $sort: { retentionEligibleAt: 1, _id: 1 } },
    { $limit: batchSize },
    { $project: { _id: 1, workspaceId: 1, lastActivityAt: 1, retentionEligibleAt: 1 } },
  ]
}

function activityFromDocument(
  document: Record<string, unknown> | null,
  fields: string[],
): Date[] {
  if (!document) return []
  return fields.flatMap((field) => {
    const value = document[field]
    return value instanceof Date ? [value] : []
  })
}

async function evaluateRetentionEligibility(
  candidate: IHireCandidate,
  now: Date,
  session: ClientSession,
): Promise<RetentionEligibility> {
  const scope = { workspaceId: candidate.workspaceId, candidateId: candidate._id }
  const privacyRequest = await HirePrivacyRequest.exists({
    ...scope,
    live: true,
    $or: [
      { status: 'processing' },
      { status: 'pending_verification', verificationExpiresAt: { $gt: now } },
    ],
  }).session(session)
  if (privacyRequest) return { eligible: false, reason: 'privacy_request' }

  const applications = await HireApplication.find(scope)
    .select('jobId stage updatedAt')
    .session(session)
    .lean()
  if (applications.length === 0) return { eligible: false, reason: 'no_applications' }
  if (applications.some((application) => !TERMINAL_STAGES.includes(application.stage))) {
    return { eligible: false, reason: 'live_application' }
  }

  const jobIds = Array.from(new Set(applications.map((application) => application.jobId.toString())))
  const jobs = await HireJob.find({
    workspaceId: candidate.workspaceId,
    _id: { $in: jobIds },
  })
    .select('status closedAt')
    .session(session)
    .lean()
  if (jobs.length !== jobIds.length || jobs.some((job) => job.status !== 'closed' || !job.closedAt)) {
    return { eligible: false, reason: 'open_job' }
  }

  const activeHumanRound = await HireHumanRound.exists({
    ...scope,
    status: 'pending_scorecard',
    revokedAt: { $exists: false },
  }).session(session)
  if (activeHumanRound) return { eligible: false, reason: 'live_human_round' }

  // A human-kit capability can expose a candidate brief without an account.
  // Job close normally revokes it, but retain this explicit fence so a data
  // cleanup never races a still-live capability left by an interrupted
  // lifecycle transition.
  const activeHumanKit = await HireInterviewKit.exists({
    ...scope,
    active: true,
    status: 'active',
    revokedAt: { $exists: false },
    expiresAt: { $gt: now },
  }).session(session)
  if (activeHumanKit) return { eligible: false, reason: 'live_human_kit' }

  // A valid share packet grants an unauthenticated recipient access to a
  // candidate snapshot. Retention must not race that possession capability;
  // terminal/job/workspace lifecycle hooks normally revoke it first, and the
  // explicit fence covers interrupted or legacy lifecycle transitions.
  const activeSharePacket = await HireSharePacket.exists({
    ...scope,
    active: true,
    status: 'active',
    revokedAt: { $exists: false },
    expiresAt: { $gt: now },
  }).session(session)
  if (activeSharePacket) return { eligible: false, reason: 'live_share_packet' }

  // Assessment exports are member-authorized rather than public URLs, but a
  // live row still holds a candidate-bearing PDF/snapshot. Do not anonymize
  // until it has expired or the lifecycle can cancel and redact it.
  const activeAssessmentExport = await HireAssessmentExport.exists({
    ...scope,
    status: { $ne: 'cancelled' },
    expiresAt: { $gt: now },
  }).session(session)
  if (activeAssessmentExport) return { eligible: false, reason: 'live_assessment_export' }

  const round = await HireRound.findOne(scope)
    .sort({ linkedAt: -1, consentAt: -1, invitedAt: -1 })
    .select('invitedAt consentAt linkedAt')
    .session(session)
    .lean()
  const attempt = await HireInterviewAttempt.findOne(scope)
    .sort({ completedAt: -1, startedAt: -1, createdAt: -1 })
    .select('createdAt startedAt completedAt failedAt')
    .session(session)
    .lean()
  const result = await HireInterviewResult.findOne(scope)
    .sort({ completedAt: -1 })
    .select('completedAt')
    .session(session)
    .lean()
  const multimodalObservation = await HireMultimodalObservation.findOne(scope)
    .sort({ observedAt: -1 })
    .select('observedAt')
    .session(session)
    .lean()
  const media = await HireMediaAsset.findOne(scope)
    .sort({ capturedAt: -1 })
    .select('capturedAt')
    .session(session)
    .lean()
  const consent = await HireConsentReceipt.findOne(scope)
    .sort({ acceptedAt: -1 })
    .select('acceptedAt')
    .session(session)
    .lean()
  const humanRound = await HireHumanRound.findOne(scope)
    .sort({ updatedAt: -1, createdAt: -1 })
    .select('createdAt updatedAt')
    .session(session)
    .lean()
  const humanKit = await HireInterviewKit.findOne(scope)
    .sort({ updatedAt: -1, createdAt: -1 })
    .select('createdAt updatedAt')
    .session(session)
    .lean()
  const humanScorecard = await HireHumanScorecard.findOne(scope)
    .sort({ updatedAt: -1, createdAt: -1 })
    .select('createdAt updatedAt')
    .session(session)
    .lean()
  const humanKitDelivery = await HireHumanKitDelivery.findOne(scope)
    .sort({ updatedAt: -1, createdAt: -1 })
    .select('createdAt updatedAt')
    .session(session)
    .lean()
  const sharePacket = await HireSharePacket.findOne(scope)
    .sort({ updatedAt: -1, verdictSubmittedAt: -1, revokedAt: -1, createdAt: -1 })
    .select('createdAt updatedAt verdictSubmittedAt revokedAt')
    .session(session)
    .lean()
  const externalVerdict = await HireExternalVerdict.findOne(scope)
    .sort({ submittedAt: -1, updatedAt: -1, createdAt: -1 })
    .select('createdAt updatedAt submittedAt')
    .session(session)
    .lean()
  const assessmentExport = await HireAssessmentExport.findOne(scope)
    .sort({
      updatedAt: -1,
      readyAt: -1,
      failedAt: -1,
      cancelledAt: -1,
      requestedAt: -1,
      createdAt: -1,
    })
    .select('requestedAt createdAt updatedAt readyAt failedAt cancelledAt')
    .session(session)
    .lean()
  const lastActivityAt = latestDate([
    candidate.updatedAt,
    ...applications.map((application) => application.updatedAt),
    ...jobs.map((job) => job.closedAt),
    ...activityFromDocument(round as Record<string, unknown> | null, [
      'invitedAt',
      'consentAt',
      'linkedAt',
    ]),
    ...activityFromDocument(attempt as Record<string, unknown> | null, [
      'createdAt',
      'startedAt',
      'completedAt',
      'failedAt',
    ]),
    ...activityFromDocument(result as Record<string, unknown> | null, ['completedAt']),
    ...activityFromDocument(
      multimodalObservation as Record<string, unknown> | null,
      ['observedAt'],
    ),
    ...activityFromDocument(media as Record<string, unknown> | null, ['capturedAt']),
    ...activityFromDocument(consent as Record<string, unknown> | null, ['acceptedAt']),
    ...activityFromDocument(humanRound as Record<string, unknown> | null, [
      'createdAt',
      'updatedAt',
    ]),
    ...activityFromDocument(humanKit as Record<string, unknown> | null, [
      'createdAt',
      'updatedAt',
    ]),
    ...activityFromDocument(humanScorecard as Record<string, unknown> | null, [
      'createdAt',
      'updatedAt',
    ]),
    ...activityFromDocument(humanKitDelivery as Record<string, unknown> | null, [
      'createdAt',
      'updatedAt',
    ]),
    ...activityFromDocument(sharePacket as Record<string, unknown> | null, [
      'createdAt',
      'updatedAt',
      'verdictSubmittedAt',
      'revokedAt',
    ]),
    ...activityFromDocument(externalVerdict as Record<string, unknown> | null, [
      'createdAt',
      'updatedAt',
      'submittedAt',
    ]),
    ...activityFromDocument(assessmentExport as Record<string, unknown> | null, [
      'requestedAt',
      'createdAt',
      'updatedAt',
      'readyAt',
      'failedAt',
      'cancelledAt',
    ]),
  ])
  if (!lastActivityAt) return { eligible: false, reason: 'not_due' }
  const retentionEligibleAt = addCalendarMonths(
    lastActivityAt,
    HIRE_CANDIDATE_RETENTION_MONTHS,
  )
  return retentionEligibleAt <= now
    ? { eligible: true, lastActivityAt, retentionEligibleAt }
    : { eligible: false, lastActivityAt, retentionEligibleAt, reason: 'not_due' }
}

async function releaseCandidateClaim(input: {
  candidateId: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  claimToken: string
  error?: unknown
}): Promise<void> {
  const errorMessage = input.error instanceof Error
    ? `${input.error.name}: ${input.error.message}`.slice(0, 500)
    : input.error
      ? 'Candidate anonymization failed'
      : undefined
  await HireCandidate.updateOne(
    {
      _id: input.candidateId,
      workspaceId: input.workspaceId,
      anonymizationClaimToken: input.claimToken,
      piiAnonymizedAt: { $exists: false },
    },
    {
      ...(errorMessage ? { $set: { anonymizationLastError: errorMessage } } : {}),
      $unset: {
        anonymizationClaimToken: 1,
        anonymizationLeaseExpiresAt: 1,
        ...(!errorMessage ? { anonymizationLastError: 1 } : {}),
      },
    },
    { timestamps: false },
  )
}

async function anonymizeClaimedCandidate(input: {
  candidateId: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  claimToken: string
  now: Date
}): Promise<'anonymized' | 'skipped'> {
  const session = await mongoose.startSession()
  let assessmentExportCleanupTargets: HireAssessmentExportCleanupTarget[] = []
  try {
    let outcome: 'anonymized' | 'skipped' = 'skipped'
    await session.withTransaction(async () => {
      const candidate = await HireCandidate.findOne({
        _id: input.candidateId,
        workspaceId: input.workspaceId,
        anonymizationClaimToken: input.claimToken,
        piiAnonymizedAt: { $exists: false },
      }).session(session)
      if (!candidate) return

      const eligibility = await evaluateRetentionEligibility(candidate, input.now, session)
      if (!eligibility.eligible) return

      // Retention anonymization changes the aggregate's subject set. This
      // transaction shares the workspace fence with snapshot creation and
      // exact egress, so a pre-anonymization digest cannot send after commit.
      await invalidateHireDigestAggregateSnapshotsForPrivacy({
        workspaceId: candidate.workspaceId,
        now: input.now,
        session,
      })

      const anonymizedEmail = `retained-${candidate._id.toString()}@privacy.invalid`
      const changed = await HireCandidate.updateOne(
        {
          _id: candidate._id,
          workspaceId: candidate.workspaceId,
          anonymizationClaimToken: input.claimToken,
          piiAnonymizedAt: { $exists: false },
        },
        {
          $set: {
            name: 'Anonymized candidate',
            email: anonymizedEmail,
            piiAnonymizedAt: input.now,
            piiAnonymizationReason: 'retention',
          },
          $unset: {
            phone: 1,
            resumeText: 1,
            resumeFileName: 1,
            screeningProfile: 1,
            anonymizationClaimToken: 1,
            anonymizationLeaseExpiresAt: 1,
            anonymizationLastError: 1,
          },
        },
        { session },
      )
      if (changed.matchedCount !== 1) {
        throw new Error('Candidate anonymization claim changed')
      }

      const scope = { workspaceId: candidate.workspaceId, candidateId: candidate._id }
      const applicationCoordinates = await HireApplication.find(scope)
        .select('_id')
        .session(session)
        .lean()
      const applicationIds = applicationCoordinates.map((application) => application._id)
      await HireApplication.updateMany(
        scope,
        {
          $unset: {
            applicantSubmissions: 1,
            'events.$[sensitiveEvent].note': 1,
          },
        },
        {
          session,
          arrayFilters: [{
            'sensitiveEvent.type': {
              $in: [
                'ai_round_sent',
                'human_round_logged',
                'human_kit_sent',
                'human_kit_delivery_failed',
                'human_kit_reminded',
                'human_kit_revoked',
                'human_scorecard_submitted',
              ],
            },
          }],
        },
      )
      await HireApplication.updateMany(
        { ...scope, resumeMatch: { $exists: true } },
        {
          $set: {
            'resumeMatch.strengths': [],
            'resumeMatch.gaps': [],
            'resumeMatch.resumeHash': '0'.repeat(64),
            'resumeMatch.stale': true,
          },
        },
        { session },
      )
      await HireRound.updateMany(
        scope,
        {
          $set: { candidateEmail: anonymizedEmail },
          $unset: {
            candidateName: 1,
            consentUserAgent: 1,
            'results.perQuestion': 1,
            'results.redFlags': 1,
            'results.topImprovements': 1,
          },
        },
        { session },
      )
      await HireInterviewResult.updateMany(
        { ...scope, piiPurgedAt: { $exists: false } },
        {
          $set: { piiPurgedAt: input.now },
          $unset: {
            rawEngineOutput: 1,
            projection: 1,
            evidenceIndex: 1,
          },
        },
        { session },
      )
      if (applicationIds.length > 0) {
        // Legacy ingestion ledgers may still contain source object paths and
        // media fingerprints. Keep their immutable retry identity/digest,
        // but remove the manifest at the same retention boundary as results.
        await HireEngineIngestionEvent.updateMany(
          {
            workspaceId: candidate.workspaceId,
            applicationId: { $in: applicationIds },
          },
          { $set: { media: [] } },
          { session },
        )
      }
      // The derived observation and its idempotency ledger do not have a
      // defensible aggregate use after retention anonymization. Erase both in
      // the same subject transaction rather than preserving an identifier-only
      // observation that could be re-linked later.
      await HireMultimodalObservationIngestionEvent.deleteMany(scope, { session })
      await HireMultimodalObservation.deleteMany(scope, { session })
      // Retain an unacknowledged runtime-outbox purge barrier: deleting it
      // would strand a future publisher in the isolated runtime. The control
      // report/ledger above are already gone, so scrub the candidate key while
      // preserving only opaque runtime retry coordinates. Acknowledged rows
      // have no remaining purpose and may be deleted with the candidate.
      await HireMultimodalObservationPurgeObligation.deleteMany(
        { ...scope, runtimePurgedAt: { $exists: true } },
        { session },
      )
      await HireMultimodalObservationPurgeObligation.updateMany(
        { ...scope, runtimePurgedAt: { $exists: false } },
        { $unset: { candidateId: 1 } },
        { session, overwriteImmutable: true },
      )
      await HireConsentReceipt.updateMany(
        scope,
        { $unset: { userAgent: 1, locale: 1 } },
        { session },
      )
      // Delivery contact snapshots are not funnel history and must not keep
      // an address alive beyond the candidate clock.
      await HireEmailOutbox.deleteMany(scope, { session })
      // Human-kit delivery rows contain interviewer contact/recovery material
      // and the scorecard holds free-text candidate evidence. Retention has
      // no Phase-3 aggregate artifact to preserve, so erase this distinct
      // human-side graph rather than overloading AI-runtime tombstones.
      await HireHumanKitDelivery.deleteMany(scope, { session })
      await HireInterviewKit.deleteMany(scope, { session })
      await HireHumanScorecard.deleteMany(scope, { session })
      await HireHumanRound.deleteMany(scope, { session })
      // Retention is the final PII boundary. Any residual capability becomes
      // uniformly inactive and its digest is removed in this transaction.
      await revokeCandidateStatusLinksForScope({
        ...scope,
        reason: 'Candidate retained and anonymized',
        at: input.now,
        session,
      })
      // A claimed candidate was fenced against currently valid share
      // capabilities above. Revoke any residual active packet defensively,
      // then remove all immutable snapshot content and external verdict prose
      // before the anonymized candidate transaction commits.
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
            revocationReason: 'Candidate retained and anonymized',
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
      assessmentExportCleanupTargets = await cancelHireAssessmentExports({
        scope,
        cancelledAt: input.now,
        privacyRedactedAt: input.now,
        session,
      })
      await cancelHireReportExportsForLifecycle({
        scope,
        cancelledAt: input.now,
        session,
      })
      // Intake tasks are transient, but an interrupted worker can retain the
      // original resume payload and supplied contact fields. A retained
      // candidate must never leave those task artifacts behind.
      await HireIntakeTask.deleteMany(scope, { session })
      await HireInvitationBatchItem.updateMany(
        {
          ...scope,
          status: { $in: ['pending', 'sending', 'failed'] },
        },
        {
          $set: { status: 'cancelled', cancelledAt: input.now },
          $unset: { claimToken: 1, leaseExpiresAt: 1 },
        },
        { session },
      )
      // Retention anonymization has the same subject-level promise as a
      // verified deletion. Keep gate-level aggregate audit facts, but erase
      // every immutable snapshot coordinate that could re-identify this
      // candidate or their applications.
      await HireScreeningGate.updateMany(
        {
          workspaceId: candidate.workspaceId,
          $or: [
            { 'rankedApplications.candidateId': candidate._id },
            { 'rankedApplications.applicationId': { $in: applicationIds } },
            { 'exceptions.applicationId': { $in: applicationIds } },
          ],
        },
        {
          $pull: {
            rankedApplications: {
              $or: [
                { candidateId: candidate._id },
                { applicationId: { $in: applicationIds } },
              ],
            },
            exceptions: { applicationId: { $in: applicationIds } },
          },
        },
        { session, overwriteImmutable: true },
      )
      if (applicationIds.length > 0) {
        await HireScreeningGate.updateMany(
          {
            workspaceId: candidate.workspaceId,
            'cutLine.applicationId': { $in: applicationIds },
          },
          { $unset: { 'cutLine.applicationId': 1 } },
          { session, overwriteImmutable: true },
        )
      }
      // Cancel nonterminal work first, then make all durable items
      // non-identifying. Sent/skipped/cancelled rows retain only aggregate
      // operational facts and can no longer be joined to this person.
      await HireInvitationBatchItem.updateMany(
        { ...scope, privacyRedactedAt: { $exists: false } },
        {
          $set: { privacyRedactedAt: input.now },
          $unset: {
            applicationId: 1,
            candidateId: 1,
            roundId: 1,
            inviteDeliveryId: 1,
            deliveryStatus: 1,
            providerMessageId: 1,
            lastError: 1,
            skipReason: 1,
            claimToken: 1,
            leaseExpiresAt: 1,
          },
        },
        { session, overwriteImmutable: true },
      )
      await HirePrivacyRequest.deleteMany(
        {
          ...scope,
          $or: [
            { status: { $in: ['expired', 'failed'] } },
            { status: 'pending_verification', verificationExpiresAt: { $lte: input.now } },
          ],
        },
        { session },
      )
      outcome = 'anonymized'
    })
    await deleteHireAssessmentExportObjects(assessmentExportCleanupTargets)
    return outcome
  } finally {
    await session.endSession()
  }
}

export async function anonymizeDueHireCandidates(input: {
  workspaceId: string
  now?: Date
  batchSize?: number
}): Promise<HireCandidateRetentionReport> {
  await connectHireControlDB()
  const now = input.now ?? new Date()
  const batchSize = Math.min(
    Math.max(input.batchSize ?? DEFAULT_CANDIDATE_BATCH_SIZE, 1),
    500,
  )
  const workspaceId = new mongoose.Types.ObjectId(input.workspaceId)
  const candidates = await HireCandidate.aggregate<CandidateRetentionRow>(
    buildHireCandidateRetentionPipeline(workspaceId, now, batchSize),
  )

  let claimed = 0
  let anonymized = 0
  let skipped = 0
  let failed = 0
  for (const candidate of candidates) {
    const claimToken = randomUUID()
    const claim = await HireCandidate.updateOne(
      {
        _id: candidate._id,
        workspaceId,
        piiAnonymizedAt: { $exists: false },
        $or: [
          { anonymizationClaimToken: { $exists: false } },
          { anonymizationLeaseExpiresAt: { $lte: now } },
        ],
      },
      {
        $set: {
          anonymizationClaimToken: claimToken,
          anonymizationLeaseExpiresAt: new Date(now.getTime() + ANONYMIZATION_LEASE_MS),
        },
        $inc: { anonymizationAttempts: 1 },
        $unset: { anonymizationLastError: 1 },
      },
      { timestamps: false },
    )
    if (claim.matchedCount !== 1) {
      // Surface a live/stale claim to the Inngest step so a crashed execution
      // is retried instead of silently postponing deletion until tomorrow.
      failed += 1
      continue
    }
    claimed += 1
    try {
      const outcome = await anonymizeClaimedCandidate({
        candidateId: candidate._id,
        workspaceId,
        claimToken,
        now,
      })
      if (outcome === 'anonymized') {
        anonymized += 1
      } else {
        skipped += 1
        await releaseCandidateClaim({
          candidateId: candidate._id,
          workspaceId,
          claimToken,
        })
      }
    } catch (error) {
      failed += 1
      await releaseCandidateClaim({
        candidateId: candidate._id,
        workspaceId,
        claimToken,
        error,
      })
    }
  }

  return {
    scanned: candidates.length,
    claimed,
    anonymized,
    skipped,
    failed,
  }
}

export const __candidateRetention = {
  ANONYMIZATION_LEASE_MS,
  activityFromDocument,
  latestDate,
}
