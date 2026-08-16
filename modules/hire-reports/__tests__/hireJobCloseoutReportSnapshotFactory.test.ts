import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NotFoundError } from '@shared/errors'

const IDS = {
  workspace: '1'.repeat(24),
  job: '2'.repeat(24),
  department: '5'.repeat(24),
  application: '3'.repeat(24),
  candidate: '4'.repeat(24),
}

const mocks = vi.hoisted(() => ({
  applicationAggregate: vi.fn(),
  candidateAggregate: vi.fn(),
  testDriveStages: vi.fn(),
  pipelineSnapshot: vi.fn(),
}))

vi.mock('@hire-decision-boundary', () => ({
  HireApplication: { aggregate: mocks.applicationAggregate },
  HireCandidate: { aggregate: mocks.candidateAggregate },
}))

vi.mock('@/modules/hire-onboarding/services/testDriveService', () => ({
  buildHireOnboardingTestDriveExclusionStages: mocks.testDriveStages,
}))

vi.mock('../services/hirePipelineStatusReportSnapshotFactory', () => ({
  buildHirePipelineStatusReportSnapshotFromControlRecords: mocks.pipelineSnapshot,
}))

import {
  buildHireJobCloseoutReportSnapshotInputFromControlRecords,
} from '../services/hireJobCloseoutReportSnapshotFactory'

function id(value: string) {
  return new mongoose.Types.ObjectId(value)
}

function query(rows: unknown[]) {
  const chain = { session: vi.fn(), exec: vi.fn() }
  chain.session.mockReturnValue(chain)
  chain.exec.mockResolvedValue(rows)
  return chain
}

function deferredQuery() {
  let resolveRows: (rows: unknown[]) => void = () => undefined
  const rows = new Promise<unknown[]>((resolve) => {
    resolveRows = resolve
  })
  const chain = { session: vi.fn(), exec: vi.fn() }
  chain.session.mockReturnValue(chain)
  chain.exec.mockReturnValue(rows)
  return { chain, resolve: (value: unknown[]) => resolveRows(value) }
}

const closedJob = {
  _id: id(IDS.job),
  title: 'Senior platform engineer',
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  status: 'closed' as const,
  closedAt: new Date('2026-08-15T00:00:00.000Z'),
  closeNote: 'Role filled after final panel review.',
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.testDriveStages.mockImplementation((input: Record<string, unknown>) => [{
    $match: { __testDriveExcludedBy: input.coordinate },
  }])
  mocks.pipelineSnapshot.mockResolvedValue({
    snapshot: {
      jobs: [{
        jobTitle: 'Senior platform engineer',
        department: { id: IDS.department, name: 'Engineering' },
        jobStatus: 'closed',
        openedAt: closedJob.createdAt,
        stageCounts: [{ stage: 'hired', count: 1 }],
        evidence: { aiAssessments: { completedCount: 1 } },
      }],
    },
  })
  mocks.applicationAggregate.mockReturnValue(query([{
    _id: id(IDS.application),
    candidateId: id(IDS.candidate),
    events: [{ to: 'hired', at: new Date('2026-08-10T00:00:00.000Z') }],
    decisionNote: 'must not be selected',
  }]))
  mocks.candidateAggregate.mockReturnValue(query([{
    _id: id(IDS.candidate),
    name: 'Ada Lovelace',
    email: 'ada@example.test',
  }]))
})

describe('job closeout report snapshot factory', () => {
  it('uses the frozen aggregate counts and adds only independently filtered hired-name rows', async () => {
    const result = await buildHireJobCloseoutReportSnapshotInputFromControlRecords({
      workspaceId: id(IDS.workspace),
      job: closedJob,
      now: new Date('2026-08-15T00:05:00.000Z'),
      session: {} as mongoose.ClientSession,
    })

    expect(result).toEqual({
      asOf: new Date('2026-08-15T00:05:00.000Z'),
      jobTitle: 'Senior platform engineer',
      department: { id: IDS.department, name: 'Engineering' },
      openedAt: closedJob.createdAt,
      closedAt: closedJob.closedAt,
      stageCounts: [{ stage: 'hired', count: 1 }],
      evidence: { aiAssessments: { completedCount: 1 } },
      hiredCandidates: [{
        candidateId: IDS.candidate,
        candidateName: 'Ada Lovelace',
        hiredAt: new Date('2026-08-10T00:00:00.000Z'),
      }],
      decisionNote: 'Role filled after final panel review.',
    })
    expect(mocks.testDriveStages).toHaveBeenCalledWith({ coordinate: 'applicationId' })
    expect(mocks.testDriveStages).toHaveBeenCalledWith({ coordinate: 'candidateId' })
    expect(mocks.applicationAggregate).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ $project: { _id: 1, candidateId: 1, 'events.to': 1, 'events.at': 1 } }),
    ]))
    expect(mocks.candidateAggregate).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ $project: { _id: 1, name: 1 } }),
    ]))
    expect(JSON.stringify(result)).not.toContain('ada@example.test')
    expect(JSON.stringify(result)).not.toContain('must not be selected')
  })

  it('keeps closeout transaction reads serial after the aggregate snapshot', async () => {
    const pendingApplications = deferredQuery()
    mocks.applicationAggregate.mockReturnValue(pendingApplications.chain)
    const build = buildHireJobCloseoutReportSnapshotInputFromControlRecords({
      workspaceId: id(IDS.workspace),
      job: closedJob,
      now: new Date('2026-08-15T00:05:00.000Z'),
      session: {} as mongoose.ClientSession,
    })

    await vi.waitFor(() => expect(mocks.applicationAggregate).toHaveBeenCalledTimes(1))
    expect(mocks.candidateAggregate).not.toHaveBeenCalled()
    pendingApplications.resolve([])
    await build
  })

  it('skips the report obligation when the closed job is an onboarding test-drive root', async () => {
    mocks.pipelineSnapshot.mockRejectedValue(new NotFoundError('Job'))

    await expect(buildHireJobCloseoutReportSnapshotInputFromControlRecords({
      workspaceId: id(IDS.workspace),
      job: closedJob,
      now: new Date('2026-08-15T00:05:00.000Z'),
      session: {} as mongoose.ClientSession,
    })).resolves.toBeNull()
    expect(mocks.applicationAggregate).not.toHaveBeenCalled()
    expect(mocks.candidateAggregate).not.toHaveBeenCalled()
  })
})
