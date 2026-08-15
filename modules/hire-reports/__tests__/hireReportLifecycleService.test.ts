import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const IDS = {
  workspace: '1'.repeat(24),
  job: '2'.repeat(24),
  candidate: '3'.repeat(24),
  exportOne: '4'.repeat(24),
  exportTwo: '5'.repeat(24),
  member: '6'.repeat(24),
}

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  exportFind: vi.fn(),
  markCancelled: vi.fn(),
  buildCloseoutSnapshot: vi.fn(),
  createCloseout: vi.fn(),
}))

vi.mock('../services/hireReportBoundary', () => ({
  connectHireReportDB: mocks.connect,
}))

vi.mock('../models/HireReportExport', () => ({
  HireReportExport: { find: mocks.exportFind },
}))

vi.mock('../services/hireReportExportService', () => ({
  markHireReportExportCancelledForLifecycle: mocks.markCancelled,
  createHireJobCloseoutReport: mocks.createCloseout,
}))

vi.mock('../services/hireJobCloseoutReportSnapshotFactory', () => ({
  buildHireJobCloseoutReportSnapshotInputFromControlRecords: mocks.buildCloseoutSnapshot,
}))

import {
  cancelHirePipelineStatusReportsForTerminalTransition,
  cancelHireReportExportsForLifecycle,
  createHireJobCloseoutReportForLifecycle,
} from '../services/hireReportLifecycleService'

function id(value: string) {
  return new mongoose.Types.ObjectId(value)
}

function reportRows(rows: Array<{ _id: mongoose.Types.ObjectId }>) {
  const lean = vi.fn().mockResolvedValue(rows)
  const session = vi.fn().mockReturnValue({ lean })
  const select = vi.fn().mockReturnValue({ session })
  return { select, session, lean }
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
  mocks.connect.mockResolvedValue(undefined)
  mocks.exportFind.mockReturnValue(reportRows([
    { _id: id(IDS.exportOne) },
    { _id: id(IDS.exportTwo) },
  ]))
  mocks.markCancelled
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false)
  mocks.buildCloseoutSnapshot.mockResolvedValue({
    asOf: closedJob.closedAt,
    jobTitle: closedJob.title,
    openedAt: closedJob.createdAt,
    closedAt: closedJob.closedAt,
    stageCounts: [],
    evidence: {},
    hiredCandidates: [],
    decisionNote: closedJob.closeNote,
  })
  mocks.createCloseout.mockResolvedValue({
    export: { id: IDS.exportOne, status: 'requested' },
    created: true,
  })
})

describe('report lifecycle service', () => {
  it('cancels candidate-scoped closeouts plus all privacy-sensitive pipeline aggregates through the tombstone-first service', async () => {
    const now = new Date('2026-08-15T01:00:00.000Z')
    const result = await cancelHireReportExportsForLifecycle({
      scope: {
        workspaceId: id(IDS.workspace),
        jobId: id(IDS.job),
        candidateId: id(IDS.candidate),
      },
      cancelledAt: now,
      session: {} as mongoose.ClientSession,
    })

    expect(result).toBe(1)
    expect(mocks.exportFind).toHaveBeenCalledWith({
      workspaceId: id(IDS.workspace),
      status: { $nin: ['cancelled', 'expired'] },
      jobId: id(IDS.job),
      $or: [
        { affectedCandidateIds: id(IDS.candidate) },
        { reportKind: 'pipeline_status' },
      ],
    })
    expect(mocks.markCancelled).toHaveBeenNthCalledWith(1, {
      workspaceId: IDS.workspace,
      exportId: IDS.exportOne,
      session: expect.anything(),
      now,
    })
    expect(mocks.markCancelled).toHaveBeenNthCalledWith(2, {
      workspaceId: IDS.workspace,
      exportId: IDS.exportTwo,
      session: expect.anything(),
      now,
    })
  })

  it('cancels only the workspace-wide and matching-job pipeline reports for a terminal transition', async () => {
    const now = new Date('2026-08-15T01:00:00.000Z')
    const session = {} as mongoose.ClientSession
    const result = await cancelHirePipelineStatusReportsForTerminalTransition({
      workspaceId: id(IDS.workspace),
      jobId: id(IDS.job),
      cancelledAt: now,
      session,
    })

    expect(result).toBe(1)
    expect(mocks.exportFind).toHaveBeenCalledWith({
      workspaceId: id(IDS.workspace),
      reportKind: 'pipeline_status',
      status: { $nin: ['cancelled', 'expired'] },
      $or: [
        { reportScope: 'workspace' },
        { jobId: id(IDS.job) },
      ],
    })
    expect(mocks.markCancelled).toHaveBeenNthCalledWith(1, {
      workspaceId: IDS.workspace,
      exportId: IDS.exportOne,
      session,
      now,
    })
    expect(mocks.markCancelled).toHaveBeenNthCalledWith(2, {
      workspaceId: IDS.workspace,
      exportId: IDS.exportTwo,
      session,
      now,
    })
  })

  it('creates one closeout obligation from the server-side factory and preserves the post-commit kick boundary', async () => {
    const now = new Date('2026-08-15T01:00:00.000Z')
    const session = {} as mongoose.ClientSession
    const result = await createHireJobCloseoutReportForLifecycle({
      workspaceId: id(IDS.workspace),
      job: closedJob,
      operationId: '11111111-1111-4111-8111-111111111111',
      requestedBy: { memberId: IDS.member, name: 'Hiring member' },
      session,
      now,
    })

    expect(result).toEqual({
      export: { id: IDS.exportOne, status: 'requested' },
      created: true,
    })
    expect(mocks.buildCloseoutSnapshot).toHaveBeenCalledWith({
      workspaceId: id(IDS.workspace),
      job: closedJob,
      now,
      session,
    })
    expect(mocks.createCloseout).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: IDS.workspace,
      jobId: IDS.job,
      operationId: '11111111-1111-4111-8111-111111111111',
      requestedBy: { memberId: IDS.member, name: 'Hiring member' },
      session,
      now,
    }))
  })

  it('does not create a closeout export for an onboarding test-drive job', async () => {
    mocks.buildCloseoutSnapshot.mockResolvedValue(null)

    await expect(createHireJobCloseoutReportForLifecycle({
      workspaceId: id(IDS.workspace),
      job: closedJob,
      operationId: '11111111-1111-4111-8111-111111111111',
      requestedBy: { memberId: IDS.member, name: 'Hiring member' },
      session: {} as mongoose.ClientSession,
      now: new Date('2026-08-15T01:00:00.000Z'),
    })).resolves.toBeNull()
    expect(mocks.createCloseout).not.toHaveBeenCalled()
  })
})
