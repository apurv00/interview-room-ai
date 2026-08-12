import { randomUUID } from 'node:crypto'
import mongoose, { type ClientSession, type PipelineStage } from 'mongoose'
import {
  HireApplication,
  HireCandidate,
  HireConsentReceipt,
  HireEmailOutbox,
  HireInterviewAttempt,
  HireInterviewResult,
  HireJob,
  HireMediaAsset,
  HirePrivacyRequest,
  HireRound,
  HireWorkspace,
  TERMINAL_STAGES,
  type IHireCandidate,
} from '../models'
import { connectHireControlDB } from './hireControlBoundary'
import { addCalendarMonths } from './mediaLifecycleService'

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
  reason?: 'no_applications' | 'live_application' | 'open_job' | 'privacy_request' | 'not_due'
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
    '$latestMedia',
    '$latestConsents',
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
      from: HireMediaAsset.collection.name,
      as: 'latestMedia',
      activityExpression: '$capturedAt',
    }),
    activityLookup({
      from: HireConsentReceipt.collection.name,
      as: 'latestConsents',
      activityExpression: '$acceptedAt',
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
    ...activityFromDocument(media as Record<string, unknown> | null, ['capturedAt']),
    ...activityFromDocument(consent as Record<string, unknown> | null, ['acceptedAt']),
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
      await HireApplication.updateMany(
        scope,
        {
          $unset: {
            applicantSubmissions: 1,
            'events.$[inviteEvent].note': 1,
          },
        },
        {
          session,
          arrayFilters: [{ 'inviteEvent.type': 'ai_round_sent' }],
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
      await HireConsentReceipt.updateMany(
        scope,
        { $unset: { userAgent: 1, locale: 1 } },
        { session },
      )
      // Delivery contact snapshots are not funnel history and must not keep
      // an address alive beyond the candidate clock.
      await HireEmailOutbox.deleteMany(scope, { session })
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
