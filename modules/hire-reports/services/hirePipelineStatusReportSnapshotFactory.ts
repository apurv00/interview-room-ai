import mongoose, { type ClientSession, type PipelineStage } from 'mongoose'
import { AppError, NotFoundError } from '@shared/errors'
import {
  HireApplication,
  HireCandidate,
  HireHumanKitDelivery,
  HireHumanRound,
  HireHumanScorecard,
  HireInterviewResult,
  HireJob,
  HirePrivacyRequest,
  activeHirePrivacyRequestFilter,
  HIRE_HUMAN_KIT_MAX_ATTEMPTS,
} from '@hire-decision-boundary'
import { HireExternalVerdict } from '@/modules/hire-decisions/models/HireExternalVerdict'
import { HireDepartment } from '@/modules/hire-departments/models/HireDepartment'
import {
  HIRE_REPORT_AGING_BUCKETS,
  HIRE_REPORT_BLOCKER_KINDS,
  HIRE_REPORT_MAX_PIPELINE_JOBS,
  HIRE_REPORT_PIPELINE_STAGES,
  HIRE_REPORT_RECOMMENDATIONS,
  type HirePipelineStatusReportSnapshot,
  type HireReportAgingBucket,
  type HireReportPipelineStage,
  type HireReportRecommendation,
  type HireReportRecommendationTally,
  type HireReportScope,
  type HireReportSnapshotBuildResult,
} from '../types'
import { buildHirePipelineStatusReportSnapshot } from './reportSnapshotBuilders'
import { buildHireOnboardingTestDriveExclusionStages } from '@/modules/hire-onboarding/services/testDriveService'

const DAY_MS = 24 * 60 * 60 * 1000

type IdLike = mongoose.Types.ObjectId | string

type SafeJobRecord = {
  _id: IdLike
  departmentId?: IdLike
  title: string
  status: 'open' | 'on_hold' | 'closed'
  createdAt: Date
  department?: {
    id: string
    name: string
  }
}

type SafeDepartmentRecord = {
  _id: IdLike
  name: string
}

type SafeApplicationRecord = {
  _id: IdLike
  jobId: IdLike
  candidateId: IdLike
  stage: HireReportPipelineStage
  createdAt: Date
  events?: Array<{ to?: unknown; at?: unknown }>
}

type SafeRoundRecord = {
  jobId: IdLike
  applicationId: IdLike
  candidateId: IdLike
  status: 'pending_scorecard' | 'completed' | 'revoked'
}

type SafeDeliveryRecord = {
  jobId: IdLike
  applicationId: IdLike
  candidateId: IdLike
}

type SafeAssessmentRecord = {
  jobId: IdLike
  applicationId: IdLike
  candidateId: IdLike
}

type SafeScorecardRecord = SafeAssessmentRecord & {
  reviewerKind: 'member' | 'kit'
  recommendation: HireReportRecommendation
}

type SafeExternalVerdictRecord = SafeAssessmentRecord & {
  recommendation: HireReportRecommendation
}

interface SafePipelineReportRows {
  jobs: SafeJobRecord[]
  applications: SafeApplicationRecord[]
  pendingHumanRounds: SafeRoundRecord[]
  failedHumanKitDeliveries: SafeDeliveryRecord[]
  completedAiAssessments: SafeAssessmentRecord[]
  submittedHumanScorecards: SafeScorecardRecord[]
  externalVerdicts: SafeExternalVerdictRecord[]
}

function recordId(value: IdLike): string {
  return value.toString()
}

/**
 * Resolve catalog display data through the same workspace coordinate as the
 * source jobs. Status/kind are intentionally not part of this historical
 * display lookup: an archived or legacy department must keep its original
 * label, while onboarding jobs have already been excluded at the job root.
 */
async function resolveReportJobDepartments(input: {
  workspaceId: mongoose.Types.ObjectId
  jobs: readonly SafeJobRecord[]
  session: ClientSession
}): Promise<SafeJobRecord[]> {
  const departmentIdsByKey = new Map<string, IdLike>()
  for (const job of input.jobs) {
    if (!job.departmentId) {
      throw snapshotUnavailable('A job department is unavailable for this report')
    }
    departmentIdsByKey.set(recordId(job.departmentId), job.departmentId)
  }
  const departmentRows = await HireDepartment.find(
    {
      workspaceId: input.workspaceId,
      _id: { $in: Array.from(departmentIdsByKey.values()) },
    },
    { _id: 1, name: 1 },
  )
    .session(input.session)
    .lean() as unknown as SafeDepartmentRecord[]
  const departmentById = new Map(
    departmentRows.map((department) => [recordId(department._id), department]),
  )

  return input.jobs.map((job) => {
    const departmentId = job.departmentId
    if (!departmentId) {
      throw snapshotUnavailable('A job department is unavailable for this report')
    }
    const department = departmentById.get(recordId(departmentId))
    if (!department) {
      throw snapshotUnavailable('A job department is unavailable for this report')
    }
    return {
      ...job,
      department: {
        id: recordId(department._id),
        name: department.name,
      },
    }
  })
}

function isKnownStage(value: unknown): value is HireReportPipelineStage {
  return typeof value === 'string' && HIRE_REPORT_PIPELINE_STAGES.includes(value as HireReportPipelineStage)
}

function isKnownRecommendation(value: unknown): value is HireReportRecommendation {
  return typeof value === 'string' && HIRE_REPORT_RECOMMENDATIONS.includes(value as HireReportRecommendation)
}

function zeroRecommendations(): HireReportRecommendationTally {
  return {
    strong_yes: 0,
    yes: 0,
    no: 0,
    strong_no: 0,
  }
}

function recommendationSummary(records: readonly { recommendation: unknown }[]): {
  submittedCount: number
  recommendations: HireReportRecommendationTally
} {
  const recommendations = zeroRecommendations()
  for (const record of records) {
    if (!isKnownRecommendation(record.recommendation)) continue
    recommendations[record.recommendation] += 1
  }
  return {
    submittedCount: HIRE_REPORT_RECOMMENDATIONS.reduce(
      (total, recommendation) => total + recommendations[recommendation],
      0,
    ),
    recommendations,
  }
}

function stageEnteredAt(application: SafeApplicationRecord): Date {
  let latest: Date | undefined
  for (const event of application.events ?? []) {
    if (event.to !== application.stage || !(event.at instanceof Date)) continue
    if (!latest || event.at.getTime() > latest.getTime()) latest = event.at
  }
  return latest ?? application.createdAt
}

function agingBucket(application: SafeApplicationRecord, now: Date): HireReportAgingBucket {
  const elapsedDays = Math.max(0, Math.floor((now.getTime() - stageEnteredAt(application).getTime()) / DAY_MS))
  if (elapsedDays <= 2) return '0_2_days'
  if (elapsedDays <= 6) return '3_6_days'
  if (elapsedDays <= 13) return '7_13_days'
  return '14_plus_days'
}

function relatedToApplication<T extends SafeAssessmentRecord>(
  record: T,
  applicationsById: ReadonlyMap<string, SafeApplicationRecord>,
): boolean {
  const application = applicationsById.get(recordId(record.applicationId))
  return Boolean(
    application &&
      recordId(application.jobId) === recordId(record.jobId) &&
      recordId(application.candidateId) === recordId(record.candidateId),
  )
}

/**
 * Builds a pure, aggregate-only report input from already allowlisted source
 * records. Each evidence row is checked against the scoped application
 * coordinate before it can affect a count. Candidate IDs never cross this
 * function's return boundary.
 */
export function buildHirePipelineStatusReportSnapshotFromSafeRows(input: {
  scope: HireReportScope
  now: Date
  rows: SafePipelineReportRows
}): HireReportSnapshotBuildResult<HirePipelineStatusReportSnapshot> {
  const applicationsById = new Map(
    input.rows.applications.map((application) => [recordId(application._id), application]),
  )
  const applicationsByJob = new Map<string, SafeApplicationRecord[]>()
  for (const application of input.rows.applications) {
    if (!isKnownStage(application.stage)) continue
    const jobId = recordId(application.jobId)
    const entries = applicationsByJob.get(jobId)
    if (entries) entries.push(application)
    else applicationsByJob.set(jobId, [application])
  }

  const validRecordsByJob = <T extends SafeAssessmentRecord>(records: readonly T[]): Map<string, T[]> => {
    const grouped = new Map<string, T[]>()
    for (const record of records) {
      if (!relatedToApplication(record, applicationsById)) continue
      const jobId = recordId(record.jobId)
      const entries = grouped.get(jobId)
      if (entries) entries.push(record)
      else grouped.set(jobId, [record])
    }
    return grouped
  }

  const roundsByJob = validRecordsByJob(input.rows.pendingHumanRounds)
  const failedDeliveriesByJob = validRecordsByJob(input.rows.failedHumanKitDeliveries)
  const assessmentsByJob = validRecordsByJob(input.rows.completedAiAssessments)
  const scorecardsByJob = validRecordsByJob(input.rows.submittedHumanScorecards)
  const externalVerdictsByJob = validRecordsByJob(input.rows.externalVerdicts)

  return buildHirePipelineStatusReportSnapshot({
    scope: input.scope,
    asOf: input.now,
    jobs: input.rows.jobs.map((job) => {
      const jobId = recordId(job._id)
      const applications = applicationsByJob.get(jobId) ?? []
      const isOpen = job.status === 'open'
      const stageCounts = HIRE_REPORT_PIPELINE_STAGES.map((stage) => ({
        stage,
        count: applications.filter((application) => application.stage === stage).length,
      }))
      const aging = HIRE_REPORT_AGING_BUCKETS.map((bucket) => ({
        bucket,
        count: applications.filter((application) => agingBucket(application, input.now) === bucket).length,
      }))
      const scorecards = scorecardsByJob.get(jobId) ?? []
      const memberScorecards = scorecards.filter((scorecard) => scorecard.reviewerKind === 'member')
      const kitScorecards = scorecards.filter((scorecard) => scorecard.reviewerKind === 'kit')
      const decisionCount = isOpen
        ? applications.filter((application) => application.stage === 'shortlist' || application.stage === 'offer').length
        : 0
      const offerCount = isOpen
        ? applications.filter((application) => application.stage === 'offer').length
        : 0
      return {
        jobTitle: job.title,
        ...(job.department ? { department: job.department } : {}),
        jobStatus: job.status,
        openedAt: job.createdAt,
        stageCounts,
        aging,
        blockers: HIRE_REPORT_BLOCKER_KINDS.map((kind) => ({
          kind,
          count: kind === 'awaiting_member_decision'
            ? decisionCount
            : kind === 'awaiting_human_scorecard'
              ? (isOpen ? (roundsByJob.get(jobId) ?? []).length : 0)
              : kind === 'human_kit_delivery_failed'
                ? (isOpen ? (failedDeliveriesByJob.get(jobId) ?? []).length : 0)
                : offerCount,
        })),
        evidence: {
          aiAssessments: {
            completedCount: (assessmentsByJob.get(jobId) ?? []).length,
          },
          humanScorecards: {
            member: recommendationSummary(memberScorecards),
            kit: recommendationSummary(kitScorecards),
          },
          externalVerdicts: recommendationSummary(externalVerdictsByJob.get(jobId) ?? []),
        },
      }
    }),
  })
}

function snapshotUnavailable(message: string): AppError {
  return new AppError(message, 409, 'REPORT_SNAPSHOT_UNAVAILABLE')
}

/**
 * The onboarding marker is the only authority for synthetic-record
 * exclusion. Use it before projections/grouping for every report source,
 * rather than relying on a mutable title or a candidate-facing label.
 */
function excludeHireOnboardingTestDrives(input: {
  coordinate: 'applicationId' | 'jobId' | 'candidateId' | 'roundId'
  sourceIdField?: string
}): PipelineStage[] {
  return buildHireOnboardingTestDriveExclusionStages(input) as unknown as PipelineStage[]
}

/**
 * Report request factory. It is invoked only within the member's active
 * workspace transaction by `requestHirePipelineStatusReport`; no client DTO
 * can contribute a candidate field, snapshot field, key, or evidence value.
 */
export async function buildHirePipelineStatusReportSnapshotFromControlRecords(input: {
  workspaceId: mongoose.Types.ObjectId
  scope: HireReportScope
  jobId?: mongoose.Types.ObjectId
  now: Date
  session: ClientSession
}): Promise<HireReportSnapshotBuildResult<HirePipelineStatusReportSnapshot>> {
  if (input.scope === 'job' && !input.jobId) {
    throw snapshotUnavailable('A job report requires a job scope')
  }
  const jobFilter = input.scope === 'job'
    ? { _id: input.jobId, workspaceId: input.workspaceId }
    : { workspaceId: input.workspaceId }
  const jobs = await HireJob.aggregate([
    { $match: jobFilter },
    ...excludeHireOnboardingTestDrives({ coordinate: 'jobId' }),
    { $sort: { createdAt: 1, _id: 1 } },
    { $limit: HIRE_REPORT_MAX_PIPELINE_JOBS + 1 },
    { $project: { _id: 1, departmentId: 1, title: 1, status: 1, createdAt: 1 } },
  ])
    .session(input.session)
    .exec() as unknown as SafeJobRecord[]

  if (input.scope === 'job' && jobs.length === 0) throw new NotFoundError('Job')
  if (jobs.length === 0) throw snapshotUnavailable('There are no jobs available for this report')
  if (jobs.length > HIRE_REPORT_MAX_PIPELINE_JOBS) {
    throw snapshotUnavailable('This workspace has too many jobs for one report')
  }

  // Resolve this before any candidate source: the resulting id/name pair is
  // the only department data the frozen report can retain.
  const jobsWithDepartments = await resolveReportJobDepartments({
    workspaceId: input.workspaceId,
    jobs,
    session: input.session,
  })

  const jobIds = jobsWithDepartments.map((job) => job._id)
  const candidates = await HireCandidate.aggregate([
    {
      $match: {
        workspaceId: input.workspaceId,
        piiAnonymizedAt: { $exists: false },
      },
    },
    ...excludeHireOnboardingTestDrives({ coordinate: 'candidateId' }),
    { $project: { _id: 1 } },
  ])
    .session(input.session)
    .exec() as unknown as Array<{ _id: mongoose.Types.ObjectId }>
  const candidateIds = candidates.map((candidate) => candidate._id)

  if (candidateIds.length === 0) {
    return buildHirePipelineStatusReportSnapshotFromSafeRows({
      scope: input.scope,
      now: input.now,
      rows: {
        jobs: jobsWithDepartments,
        applications: [],
        pendingHumanRounds: [],
        failedHumanKitDeliveries: [],
        completedAiAssessments: [],
        submittedHumanScorecards: [],
        externalVerdicts: [],
      },
    })
  }

  const privacyRows = await HirePrivacyRequest.aggregate([
    {
      $match: {
        workspaceId: input.workspaceId,
        candidateId: { $in: candidateIds },
        ...activeHirePrivacyRequestFilter(input.now),
      },
    },
    ...excludeHireOnboardingTestDrives({ coordinate: 'candidateId', sourceIdField: 'candidateId' }),
    { $project: { _id: 0, candidateId: 1 } },
  ])
    .session(input.session)
    .exec() as unknown as Array<{ candidateId: mongoose.Types.ObjectId }>
  const privacyPendingCandidateIds = new Set(privacyRows.map((row) => recordId(row.candidateId)))
  const safeCandidateIds = candidateIds.filter((candidateId) => !privacyPendingCandidateIds.has(recordId(candidateId)))

  if (safeCandidateIds.length === 0) {
    return buildHirePipelineStatusReportSnapshotFromSafeRows({
      scope: input.scope,
      now: input.now,
      rows: {
        jobs: jobsWithDepartments,
        applications: [],
        pendingHumanRounds: [],
        failedHumanKitDeliveries: [],
        completedAiAssessments: [],
        submittedHumanScorecards: [],
        externalVerdicts: [],
      },
    })
  }

  const baseScope = {
    workspaceId: input.workspaceId,
    jobId: { $in: jobIds },
    candidateId: { $in: safeCandidateIds },
  }
  // Mongoose/Mongo does not permit concurrent operations on a transaction
  // session. These reads intentionally remain serial even though their
  // projections are independent.
  const applications = await HireApplication.aggregate([
    { $match: baseScope },
    ...excludeHireOnboardingTestDrives({ coordinate: 'applicationId' }),
    { $project: { _id: 1, jobId: 1, candidateId: 1, stage: 1, createdAt: 1, 'events.to': 1, 'events.at': 1 } },
  ]).session(input.session).exec()
  const pendingHumanRounds = await HireHumanRound.aggregate([
    { $match: { ...baseScope, status: 'pending_scorecard', privacyRedactedAt: { $exists: false } } },
    ...excludeHireOnboardingTestDrives({ coordinate: 'applicationId', sourceIdField: 'applicationId' }),
    { $project: { _id: 0, jobId: 1, applicationId: 1, candidateId: 1, status: 1 } },
  ]).session(input.session).exec()
  const failedHumanKitDeliveries = await HireHumanKitDelivery.aggregate([
    { $match: { ...baseScope, status: 'failed', attempts: { $gte: HIRE_HUMAN_KIT_MAX_ATTEMPTS } } },
    ...excludeHireOnboardingTestDrives({ coordinate: 'applicationId', sourceIdField: 'applicationId' }),
    { $project: { _id: 0, jobId: 1, applicationId: 1, candidateId: 1 } },
  ]).session(input.session).exec()
  const completedAiAssessments = await HireInterviewResult.aggregate([
    { $match: { ...baseScope, piiPurgedAt: { $exists: false } } },
    ...excludeHireOnboardingTestDrives({ coordinate: 'applicationId', sourceIdField: 'applicationId' }),
    { $project: { _id: 0, jobId: 1, applicationId: 1, candidateId: 1 } },
  ]).session(input.session).exec()
  const submittedHumanScorecards = await HireHumanScorecard.aggregate([
    { $match: { ...baseScope, status: 'submitted', privacyRedactedAt: { $exists: false } } },
    ...excludeHireOnboardingTestDrives({ coordinate: 'applicationId', sourceIdField: 'applicationId' }),
    { $project: { _id: 0, jobId: 1, applicationId: 1, candidateId: 1, reviewerKind: 1, recommendation: 1 } },
  ]).session(input.session).exec()
  const externalVerdicts = await HireExternalVerdict.aggregate([
    { $match: { ...baseScope, privacyRedactedAt: { $exists: false } } },
    ...excludeHireOnboardingTestDrives({ coordinate: 'applicationId', sourceIdField: 'applicationId' }),
    { $project: { _id: 0, jobId: 1, applicationId: 1, candidateId: 1, recommendation: 1 } },
  ]).session(input.session).exec()

  return buildHirePipelineStatusReportSnapshotFromSafeRows({
    scope: input.scope,
    now: input.now,
    rows: {
      jobs: jobsWithDepartments,
      applications: applications as unknown as SafeApplicationRecord[],
      pendingHumanRounds: pendingHumanRounds as unknown as SafeRoundRecord[],
      failedHumanKitDeliveries: failedHumanKitDeliveries as unknown as SafeDeliveryRecord[],
      completedAiAssessments: completedAiAssessments as unknown as SafeAssessmentRecord[],
      submittedHumanScorecards: submittedHumanScorecards as unknown as SafeScorecardRecord[],
      externalVerdicts: externalVerdicts as unknown as SafeExternalVerdictRecord[],
    },
  })
}
