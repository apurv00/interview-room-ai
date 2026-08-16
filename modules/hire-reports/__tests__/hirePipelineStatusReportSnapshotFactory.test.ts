import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const IDS = {
  workspace: '1'.repeat(24),
  job: '2'.repeat(24),
  department: '8'.repeat(24),
  applicationOne: '3'.repeat(24),
  applicationTwo: '4'.repeat(24),
  candidateOne: '5'.repeat(24),
  candidateTwo: '6'.repeat(24),
  testDriveJob: '7'.repeat(24),
}

const mocks = vi.hoisted(() => ({
  jobFind: vi.fn(),
  candidateFind: vi.fn(),
  privacyFind: vi.fn(),
  applicationFind: vi.fn(),
  humanRoundFind: vi.fn(),
  deliveryFind: vi.fn(),
  resultFind: vi.fn(),
  scorecardFind: vi.fn(),
  verdictFind: vi.fn(),
  departmentFind: vi.fn(),
  testDriveStages: vi.fn(),
  privacyFilter: vi.fn(),
  queries: {} as Record<string, any>,
}))

vi.mock('@hire-decision-boundary', () => ({
  HireJob: { aggregate: mocks.jobFind },
  HireCandidate: { aggregate: mocks.candidateFind },
  HirePrivacyRequest: { aggregate: mocks.privacyFind },
  activeHirePrivacyRequestFilter: mocks.privacyFilter,
  HireApplication: { aggregate: mocks.applicationFind },
  HireHumanRound: { aggregate: mocks.humanRoundFind },
  HireHumanKitDelivery: { aggregate: mocks.deliveryFind },
  HireInterviewResult: { aggregate: mocks.resultFind },
  HireHumanScorecard: { aggregate: mocks.scorecardFind },
  HIRE_HUMAN_KIT_MAX_ATTEMPTS: 3,
}))

vi.mock('@/modules/hire-decisions/models/HireExternalVerdict', () => ({
  HireExternalVerdict: { aggregate: mocks.verdictFind },
}))

vi.mock('@/modules/hire-departments/models/HireDepartment', () => ({
  HireDepartment: { find: mocks.departmentFind },
}))

vi.mock('@/modules/hire-onboarding/services/testDriveService', () => ({
  buildHireOnboardingTestDriveExclusionStages: mocks.testDriveStages,
}))

import {
  buildHirePipelineStatusReportSnapshotFromControlRecords,
  buildHirePipelineStatusReportSnapshotFromSafeRows,
} from '../services/hirePipelineStatusReportSnapshotFactory'

function id(value: string) {
  return new mongoose.Types.ObjectId(value)
}

function query(rows: unknown[]) {
  const chain = {
    session: vi.fn(),
    exec: vi.fn(),
  }
  chain.session.mockReturnValue(chain)
  chain.exec.mockResolvedValue(rows)
  return chain
}

function departmentQuery(rows: unknown[]) {
  const chain = {
    session: vi.fn(),
    lean: vi.fn(),
  }
  chain.session.mockReturnValue(chain)
  chain.lean.mockResolvedValue(rows)
  return chain
}

function deferredQuery() {
  let resolveRows: (rows: unknown[]) => void = () => undefined
  const rows = new Promise<unknown[]>((resolve) => {
    resolveRows = resolve
  })
  const chain = {
    session: vi.fn(),
    exec: vi.fn(),
  }
  chain.session.mockReturnValue(chain)
  chain.exec.mockReturnValue(rows)
  return {
    chain,
    resolve(rowsToResolve: unknown[]) {
      resolveRows(rowsToResolve)
    },
  }
}

function privacyRequestMatchesFilter(
  filter: Record<string, any>,
  request: { status: string; verificationExpiresAt: Date },
): boolean {
  if (filter.live !== true) return false
  if (!Array.isArray(filter.$or)) return true
  return filter.$or.some((condition: Record<string, any>) => {
    if (condition.status !== request.status) return false
    if (!condition.verificationExpiresAt) return true
    return request.verificationExpiresAt > condition.verificationExpiresAt.$gt
  })
}

function configureQueries() {
  mocks.queries.jobs = query([{
    _id: id(IDS.job),
    departmentId: id(IDS.department),
    title: 'Senior platform engineer',
    status: 'open',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    jdText: 'must never be selected',
  }])
  mocks.queries.candidates = query([
    { _id: id(IDS.candidateOne), name: 'Ada', email: 'ada@example.test' },
    { _id: id(IDS.candidateTwo), name: 'Grace', resumeText: 'private' },
  ])
  mocks.queries.departments = departmentQuery([{
    _id: id(IDS.department),
    name: 'Engineering',
    kind: 'standard',
    status: 'active',
  }])
  mocks.queries.privacy = query([])
  mocks.queries.applications = query([
    {
      _id: id(IDS.applicationOne),
      jobId: id(IDS.job),
      candidateId: id(IDS.candidateOne),
      stage: 'shortlist',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      events: [{ to: 'shortlist', at: new Date('2026-08-11T00:00:00.000Z') }],
      decisionNote: 'private decision note',
    },
    {
      _id: id(IDS.applicationTwo),
      jobId: id(IDS.job),
      candidateId: id(IDS.candidateTwo),
      stage: 'offer',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      events: [{ to: 'offer', at: new Date('2026-07-20T00:00:00.000Z') }],
    },
  ])
  mocks.queries.rounds = query([{
    jobId: id(IDS.job),
    applicationId: id(IDS.applicationOne),
    candidateId: id(IDS.candidateOne),
    status: 'pending_scorecard',
  }])
  mocks.queries.deliveries = query([{
    jobId: id(IDS.job),
    applicationId: id(IDS.applicationOne),
    candidateId: id(IDS.candidateOne),
    recipientEmail: 'interviewer@example.test',
    lastError: 'private provider detail',
  }])
  mocks.queries.results = query([{
    jobId: id(IDS.job),
    applicationId: id(IDS.applicationOne),
    candidateId: id(IDS.candidateOne),
    rawEngineOutput: { transcript: 'never selected' },
  }])
  mocks.queries.scorecards = query([
    {
      jobId: id(IDS.job),
      applicationId: id(IDS.applicationOne),
      candidateId: id(IDS.candidateOne),
      reviewerKind: 'member',
      recommendation: 'yes',
      overallComment: 'private feedback',
    },
    {
      jobId: id(IDS.job),
      applicationId: id(IDS.applicationTwo),
      candidateId: id(IDS.candidateTwo),
      reviewerKind: 'kit',
      recommendation: 'strong_no',
    },
  ])
  mocks.queries.verdicts = query([{
    jobId: id(IDS.job),
    applicationId: id(IDS.applicationOne),
    candidateId: id(IDS.candidateOne),
    recommendation: 'strong_yes',
    comment: 'private external comment',
  }])
  mocks.jobFind.mockReturnValue(mocks.queries.jobs)
  mocks.departmentFind.mockReturnValue(mocks.queries.departments)
  mocks.candidateFind.mockReturnValue(mocks.queries.candidates)
  mocks.privacyFind.mockReturnValue(mocks.queries.privacy)
  mocks.applicationFind.mockReturnValue(mocks.queries.applications)
  mocks.humanRoundFind.mockReturnValue(mocks.queries.rounds)
  mocks.deliveryFind.mockReturnValue(mocks.queries.deliveries)
  mocks.resultFind.mockReturnValue(mocks.queries.results)
  mocks.scorecardFind.mockReturnValue(mocks.queries.scorecards)
  mocks.verdictFind.mockReturnValue(mocks.queries.verdicts)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.testDriveStages.mockImplementation((input: Record<string, unknown>) => [{
    $match: { __testDriveExcludedBy: input.coordinate },
  }])
  mocks.privacyFilter.mockImplementation((now: Date) => ({
    live: true,
    $or: [
      { status: 'processing' },
      { status: 'pending_verification', verificationExpiresAt: { $gt: now } },
    ],
  }))
  configureQueries()
})

describe('pipeline status report snapshot factory', () => {
  it('builds a frozen aggregate from narrow server-side projections only', async () => {
    const now = new Date('2026-08-15T00:00:00.000Z')
    const result = await buildHirePipelineStatusReportSnapshotFromControlRecords({
      workspaceId: id(IDS.workspace),
      scope: 'workspace',
      now,
      session: {} as any,
    })

    expect(result.snapshot).toMatchObject({
      kind: 'pipeline_status',
      scope: 'workspace',
      asOf: now,
      jobs: [{
        jobTitle: 'Senior platform engineer',
        department: { id: IDS.department, name: 'Engineering' },
        jobStatus: 'open',
        stageCounts: expect.arrayContaining([
          { stage: 'shortlist', count: 1 },
          { stage: 'offer', count: 1 },
        ]),
        aging: expect.arrayContaining([
          { bucket: '3_6_days', count: 1 },
          { bucket: '14_plus_days', count: 1 },
        ]),
        blockers: [
          { kind: 'awaiting_member_decision', count: 2 },
          { kind: 'awaiting_human_scorecard', count: 1 },
          { kind: 'human_kit_delivery_failed', count: 1 },
          { kind: 'offer_pending', count: 1 },
        ],
        evidence: {
          aiAssessments: { completedCount: 1 },
          humanScorecards: {
            member: { submittedCount: 1, recommendations: { strong_yes: 0, yes: 1, no: 0, strong_no: 0 } },
            kit: { submittedCount: 1, recommendations: { strong_yes: 0, yes: 0, no: 0, strong_no: 1 } },
          },
          externalVerdicts: { submittedCount: 1, recommendations: { strong_yes: 1, yes: 0, no: 0, strong_no: 0 } },
        },
      }],
    })
    expect(result.affectedCandidateIds).toEqual([])
    const encoded = JSON.stringify(result)
    expect(encoded).not.toContain(IDS.candidateOne)
    expect(encoded).not.toContain('ada@example.test')
    expect(encoded).not.toContain('private decision note')
    expect(encoded).not.toContain('private provider detail')
    expect(encoded).not.toContain('private feedback')
    expect(encoded).not.toContain('private external comment')
    expect(encoded).not.toContain('transcript')

    expect(mocks.jobFind).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ $project: { _id: 1, departmentId: 1, title: 1, status: 1, createdAt: 1 } }),
    ]))
    expect(mocks.departmentFind).toHaveBeenCalledWith(
      {
        workspaceId: id(IDS.workspace),
        _id: { $in: [id(IDS.department)] },
      },
      { _id: 1, name: 1 },
    )
    expect(mocks.applicationFind).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ $project: { _id: 1, jobId: 1, candidateId: 1, stage: 1, createdAt: 1, 'events.to': 1, 'events.at': 1 } }),
    ]))
    expect(mocks.scorecardFind).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ $project: { _id: 0, jobId: 1, applicationId: 1, candidateId: 1, reviewerKind: 1, recommendation: 1 } }),
    ]))
    expect(mocks.testDriveStages).toHaveBeenCalledWith({ coordinate: 'jobId' })
    expect(mocks.testDriveStages).toHaveBeenCalledWith({ coordinate: 'candidateId' })
    expect(mocks.testDriveStages).toHaveBeenCalledWith({ coordinate: 'applicationId', sourceIdField: 'applicationId' })
  })

  it('does not count a mismatched evidence row even if its source record exists', () => {
    const result = buildHirePipelineStatusReportSnapshotFromSafeRows({
      scope: 'job',
      now: new Date('2026-08-15T00:00:00.000Z'),
      rows: {
        jobs: [{ _id: id(IDS.job), title: 'One job', status: 'open', createdAt: new Date('2026-08-01T00:00:00.000Z') }],
        applications: [{
          _id: id(IDS.applicationOne),
          jobId: id(IDS.job),
          candidateId: id(IDS.candidateOne),
          stage: 'screened',
          createdAt: new Date('2026-08-10T00:00:00.000Z'),
        }],
        pendingHumanRounds: [{
          jobId: id(IDS.job),
          applicationId: id(IDS.applicationOne),
          candidateId: id(IDS.candidateTwo),
          status: 'pending_scorecard',
        }],
        failedHumanKitDeliveries: [],
        completedAiAssessments: [],
        submittedHumanScorecards: [],
        externalVerdicts: [],
      },
    })

    expect(result.snapshot.jobs[0].blockers).toContainEqual({
      kind: 'awaiting_human_scorecard',
      count: 0,
    })
  })

  it('suppresses only processing or unexpired verification privacy requests', async () => {
    const now = new Date('2026-08-15T00:00:00.000Z')
    const requests = [
      {
        candidateId: id(IDS.candidateOne),
        status: 'pending_verification',
        verificationExpiresAt: new Date('2026-08-14T23:59:59.000Z'),
      },
      {
        candidateId: id(IDS.candidateTwo),
        status: 'processing',
        verificationExpiresAt: new Date('2026-08-15T01:00:00.000Z'),
      },
    ]
    mocks.privacyFind.mockImplementation((pipeline: Array<{ $match?: Record<string, any> }>) => {
      const filter = pipeline.find((stage) => stage.$match)?.$match ?? {}
      return query(requests
        .filter((request) => privacyRequestMatchesFilter(filter, request))
        .map(({ candidateId }) => ({ candidateId })))
    })
    const applications = [
      {
        _id: id(IDS.applicationOne),
        jobId: id(IDS.job),
        candidateId: id(IDS.candidateOne),
        stage: 'shortlist',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
      },
      {
        _id: id(IDS.applicationTwo),
        jobId: id(IDS.job),
        candidateId: id(IDS.candidateTwo),
        stage: 'offer',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
      },
    ]
    mocks.applicationFind.mockImplementation((pipeline: Array<{ $match?: Record<string, any> }>) => {
      const candidateIds = pipeline.find((stage) => stage.$match)?.$match?.candidateId?.$in ?? []
      return query(applications.filter((application) => candidateIds.some(
        (candidateId: { toString(): string }) => candidateId.toString() === application.candidateId.toString(),
      )))
    })

    const result = await buildHirePipelineStatusReportSnapshotFromControlRecords({
      workspaceId: id(IDS.workspace),
      scope: 'workspace',
      now,
      session: {} as any,
    })

    const [pipeline] = mocks.privacyFind.mock.calls[0]
    expect(pipeline).toContainEqual({
      $match: expect.objectContaining({
        live: true,
        $or: [
          { status: 'processing' },
          { status: 'pending_verification', verificationExpiresAt: { $gt: now } },
        ],
      }),
    })
    expect(mocks.privacyFilter).toHaveBeenCalledWith(now)
    expect(result.snapshot.jobs[0]?.stageCounts).toEqual(expect.arrayContaining([
      { stage: 'shortlist', count: 1 },
      { stage: 'offer', count: 0 },
    ]))
  })

  it('excludes the test-drive job root before sorting and grouping report rows', async () => {
    const realJob = {
      _id: id(IDS.job),
      departmentId: id(IDS.department),
      title: 'Senior platform engineer',
      status: 'open',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
    }
    const testDriveJob = {
      _id: id(IDS.testDriveJob),
      departmentId: id(IDS.department),
      title: 'Practice interview role',
      status: 'open',
      createdAt: new Date('2026-08-02T00:00:00.000Z'),
    }
    mocks.jobFind.mockImplementation((pipeline: Array<Record<string, any>>) => {
      const exclusionIndex = pipeline.findIndex(
        (stage) => stage.$match?.__testDriveExcludedBy === 'jobId',
      )
      const sortIndex = pipeline.findIndex((stage) => Boolean(stage.$sort))
      // Simulate the marker lookup: an unexcluded root would otherwise remain
      // visible with zero application counts in the aggregate report.
      return query(exclusionIndex >= 0 && exclusionIndex < sortIndex ? [realJob] : [realJob, testDriveJob])
    })

    const result = await buildHirePipelineStatusReportSnapshotFromControlRecords({
      workspaceId: id(IDS.workspace),
      scope: 'workspace',
      now: new Date('2026-08-15T00:00:00.000Z'),
      session: {} as any,
    })

    expect(result.snapshot.jobs.map((job) => job.jobTitle)).toEqual(['Senior platform engineer'])
    const pipeline = mocks.jobFind.mock.calls[0][0] as Array<Record<string, any>>
    const exclusionIndex = pipeline.findIndex(
      (stage) => stage.$match?.__testDriveExcludedBy === 'jobId',
    )
    const sortIndex = pipeline.findIndex((stage) => Boolean(stage.$sort))
    expect(exclusionIndex).toBeGreaterThan(0)
    expect(exclusionIndex).toBeLessThan(sortIndex)
  })

  it('does not overlap transaction-session source reads', async () => {
    const pendingApplications = deferredQuery()
    mocks.applicationFind.mockReturnValue(pendingApplications.chain)

    const build = buildHirePipelineStatusReportSnapshotFromControlRecords({
      workspaceId: id(IDS.workspace),
      scope: 'workspace',
      now: new Date('2026-08-15T00:00:00.000Z'),
      session: {} as any,
    })

    await vi.waitFor(() => expect(mocks.applicationFind).toHaveBeenCalledTimes(1))
    expect(mocks.humanRoundFind).not.toHaveBeenCalled()
    expect(mocks.deliveryFind).not.toHaveBeenCalled()
    pendingApplications.resolve([])
    await build
  })

  it('fails closed when a job department is not present in the same workspace', async () => {
    mocks.departmentFind.mockReturnValue(departmentQuery([]))

    await expect(buildHirePipelineStatusReportSnapshotFromControlRecords({
      workspaceId: id(IDS.workspace),
      scope: 'workspace',
      now: new Date('2026-08-15T00:00:00.000Z'),
      session: {} as any,
    })).rejects.toMatchObject({ code: 'REPORT_SNAPSHOT_UNAVAILABLE' })
    expect(mocks.candidateFind).not.toHaveBeenCalled()
  })
})
