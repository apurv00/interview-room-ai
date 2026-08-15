import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createFunction: vi.fn((definition: unknown) => definition),
  dispatch: vi.fn(),
  listDue: vi.fn(),
  listDueCleanup: vi.fn(),
  listWorkspaces: vi.fn(),
  process: vi.fn(),
  processCleanup: vi.fn(),
}))

vi.mock('@shared/services/inngest', () => ({
  inngest: { createFunction: mocks.createFunction },
}))
vi.mock('../services/hireAssessmentExportService', () => ({
  dispatchHireAssessmentExport: mocks.dispatch,
  HIRE_ASSESSMENT_EXPORT_RECOVERY_LIMIT_PER_WORKSPACE: 10,
  listDueHireAssessmentExportIds: mocks.listDue,
  listHireAssessmentExportWorkspaceIdsForSweep: mocks.listWorkspaces,
  processHireAssessmentExport: mocks.process,
}))
vi.mock('../services/hireAssessmentExportCleanupService', () => ({
  listDueHireAssessmentExportCleanupIds: mocks.listDueCleanup,
  processHireAssessmentExportCleanup: mocks.processCleanup,
}))
vi.mock('../models/HireAssessmentExportCleanup', () => ({
  HIRE_ASSESSMENT_EXPORT_CLEANUP_RECOVERY_LIMIT: 25,
}))

import {
  hireAssessmentExportRecoveryJob,
  hireAssessmentExportRequestedJob,
  runHireAssessmentExportRecoverySweep,
  runHireAssessmentExportRequestedHandler,
} from '../jobs/hireAssessmentExportJob'

function step() {
  return { run: vi.fn(async (_name: string, work: () => unknown) => work()) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.process.mockResolvedValue('ready')
  mocks.listWorkspaces.mockResolvedValue(['w1', 'w2'])
  mocks.listDue.mockResolvedValue([])
  mocks.listDueCleanup.mockResolvedValue([])
  mocks.dispatch.mockResolvedValue(undefined)
  mocks.processCleanup.mockResolvedValue('deleted')
})

describe('Hire assessment export jobs', () => {
  it('processes only the event durable coordinates', async () => {
    const runner = step()
    await expect(runHireAssessmentExportRequestedHandler({
      data: { workspaceId: 'workspace-id', exportId: 'export-id' },
    }, runner)).resolves.toBe('ready')
    expect(mocks.process).toHaveBeenCalledWith({ workspaceId: 'workspace-id', exportId: 'export-id' })
    expect(runner.run).toHaveBeenCalledWith('process-hire-assessment-export-export-id', expect.any(Function))
  })

  it('uses a minute recovery sweep with bounded global cleanup and per-workspace ID-only dispatch', async () => {
    mocks.listDueCleanup.mockResolvedValue(['cleanup-a'])
    mocks.listDue
      .mockResolvedValueOnce(['export-a'])
      .mockResolvedValueOnce(['export-b', 'export-c'])
    const runner = step()

    const report = await runHireAssessmentExportRecoverySweep(runner)

    expect(mocks.listDueCleanup).toHaveBeenCalledWith({ limit: 25 })
    expect(mocks.processCleanup).toHaveBeenCalledWith({ cleanupId: 'cleanup-a' })
    expect(mocks.listDue).toHaveBeenNthCalledWith(1, { workspaceId: 'w1', limit: 10 })
    expect(mocks.listDue).toHaveBeenNthCalledWith(2, { workspaceId: 'w2', limit: 10 })
    expect(mocks.dispatch).toHaveBeenCalledWith({ workspaceId: 'w1', exportId: 'export-a' })
    expect(mocks.dispatch).toHaveBeenCalledWith({ workspaceId: 'w2', exportId: 'export-b' })
    expect(mocks.dispatch).toHaveBeenCalledWith({ workspaceId: 'w2', exportId: 'export-c' })
    expect(report).toEqual({
      workspaces: 2,
      reports: [{ workspaceId: 'w1', dispatched: 1 }, { workspaceId: 'w2', dispatched: 2 }],
      cleanupReports: [{ cleanupId: 'cleanup-a', outcome: 'deleted' }],
    })
  })

  it('registers the requested handler and one-minute recovery definition', () => {
    expect(hireAssessmentExportRequestedJob).toMatchObject({
      id: 'hire-assessment-export-dispatch',
      triggers: [{ event: 'hire/assessment-export.requested' }],
    })
    expect(hireAssessmentExportRecoveryJob).toMatchObject({
      id: 'hire-assessment-export-recovery',
      triggers: [{ cron: '* * * * *' }],
    })
  })
})
