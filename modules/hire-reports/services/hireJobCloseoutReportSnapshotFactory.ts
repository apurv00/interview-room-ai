import mongoose, { type ClientSession, type PipelineStage } from 'mongoose'
import { AppError, NotFoundError } from '@shared/errors'
import { HireApplication, HireCandidate } from '@hire-decision-boundary'
import { buildHireOnboardingTestDriveExclusionStages } from '@/modules/hire-onboarding/services/testDriveService'
import type { HireJobCloseoutReportSnapshotInput } from '../types'
import { buildHirePipelineStatusReportSnapshotFromControlRecords } from './hirePipelineStatusReportSnapshotFactory'

type CloseoutJobSource = {
  _id: mongoose.Types.ObjectId
  title: string
  createdAt: Date
  status: 'open' | 'on_hold' | 'closed'
  closedAt?: Date
  closeNote?: string
}

type HiredApplicationRow = {
  _id: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
  events?: Array<{ to?: unknown; at?: unknown }>
}

type HiredCandidateRow = {
  _id: mongoose.Types.ObjectId
  name: string
}

function excludeHireOnboardingTestDrives(input: {
  coordinate: 'applicationId' | 'jobId' | 'candidateId' | 'roundId'
  sourceIdField?: string
}): PipelineStage[] {
  return buildHireOnboardingTestDriveExclusionStages(input) as unknown as PipelineStage[]
}

function reportUnavailable(message: string): AppError {
  return new AppError(message, 409, 'REPORT_SNAPSHOT_UNAVAILABLE')
}

function hiredAt(application: HiredApplicationRow, fallback: Date): Date {
  let latest: Date | undefined
  for (const event of application.events ?? []) {
    if (event.to !== 'hired' || !(event.at instanceof Date)) continue
    if (!latest || event.at.getTime() > latest.getTime()) latest = event.at
  }
  return latest ?? fallback
}

/**
 * Build the closeout-only source shape inside the same job-close transaction.
 * The aggregate pipeline is the authority for counts/evidence. This narrow
 * supplement exposes only hired names (never IDs) after independent
 * application and candidate test-drive exclusions.
 */
export async function buildHireJobCloseoutReportSnapshotInputFromControlRecords(input: {
  workspaceId: mongoose.Types.ObjectId
  job: CloseoutJobSource
  now: Date
  session: ClientSession
}): Promise<HireJobCloseoutReportSnapshotInput | null> {
  if (input.job.status !== 'closed' || !input.job.closedAt || !input.job.closeNote) {
    throw reportUnavailable('A closeout report requires a closed job with a decision note')
  }

  let pipeline
  try {
    pipeline = await buildHirePipelineStatusReportSnapshotFromControlRecords({
      workspaceId: input.workspaceId,
      scope: 'job',
      jobId: input.job._id,
      now: input.now,
      session: input.session,
    })
  } catch (error) {
    // This helper runs immediately after the job's own close update in the
    // same transaction. A missing job root therefore denotes the durable
    // onboarding test-drive exclusion, not a normal client-facing lookup.
    if (error instanceof NotFoundError) return null
    throw error
  }

  const aggregateJob = pipeline.snapshot.jobs[0]
  if (!aggregateJob || aggregateJob.jobStatus !== 'closed') {
    throw reportUnavailable('The closeout report did not observe the closed job state')
  }
  if (!aggregateJob.department) {
    throw reportUnavailable('The closeout report did not observe the job department')
  }

  // Mongo/Mongoose does not support concurrent work on one transaction
  // session. Keep the additional closeout disclosures serial with the
  // aggregate snapshot above and with one another.
  const hiredApplications = await HireApplication.aggregate([
    {
      $match: {
        workspaceId: input.workspaceId,
        jobId: input.job._id,
        stage: 'hired',
      },
    },
    ...excludeHireOnboardingTestDrives({ coordinate: 'applicationId' }),
    { $project: { _id: 1, candidateId: 1, 'events.to': 1, 'events.at': 1 } },
  ])
    .session(input.session)
    .exec() as unknown as HiredApplicationRow[]
  const hiredCandidateIds = hiredApplications.map((application) => application.candidateId)

  const hiredCandidateRows = hiredCandidateIds.length === 0
    ? []
    : await HireCandidate.aggregate([
      {
        $match: {
          workspaceId: input.workspaceId,
          _id: { $in: hiredCandidateIds },
          piiAnonymizedAt: { $exists: false },
        },
      },
      ...excludeHireOnboardingTestDrives({ coordinate: 'candidateId' }),
      { $project: { _id: 1, name: 1 } },
    ])
      .session(input.session)
      .exec() as unknown as HiredCandidateRow[]
  const candidateById = new Map(
    hiredCandidateRows.map((candidate) => [candidate._id.toString(), candidate]),
  )
  const hiredCandidates: Array<{ candidateId: string; candidateName: string; hiredAt: Date }> = []
  for (const application of hiredApplications) {
    const candidate = candidateById.get(application.candidateId.toString())
    // A privacy-pending/anonymized candidate must not become a partial
    // disclosure. The aggregate builder applied the equivalent root filter.
    if (!candidate) continue
    hiredCandidates.push({
      candidateId: candidate._id.toString(),
      candidateName: candidate.name,
      hiredAt: hiredAt(application, input.job.closedAt),
    })
  }

  return {
    asOf: input.now,
    jobTitle: aggregateJob.jobTitle,
    department: aggregateJob.department,
    openedAt: aggregateJob.openedAt,
    closedAt: input.job.closedAt,
    stageCounts: aggregateJob.stageCounts,
    evidence: aggregateJob.evidence,
    hiredCandidates,
    decisionNote: input.job.closeNote,
  }
}
