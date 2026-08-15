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
vi.mock('../services/hireReportExportService', () => ({
  dispatchHireReportExport: mocks.dispatch,
  HIRE_REPORT_EXPORT_RECOVERY_LIMIT_PER_WORKSPACE: 10,
  listDueHireReportExportIds: mocks.listDue,
  listHireReportExportWorkspaceIdsForSweep: mocks.listWorkspaces,
  processHireReportExport: mocks.process,
}))
vi.mock('../services/hireReportExportCleanupService', () => ({
  listDueHireReportExportCleanupIds: mocks.listDueCleanup,
  processHireReportExportCleanup: mocks.processCleanup,
}))
vi.mock('../models/HireReportExportCleanup', () => ({
  HIRE_REPORT_EXPORT_CLEANUP_RECOVERY_LIMIT: 25,
}))

import {
  hireReportExportRecoveryJob,
  hireReportExportRequestedJob,
  runHireReportExportRecoverySweep,
  runHireReportExportRequestedHandler,
} from '../jobs/hireReportExportJob'

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

describe('Hire report export jobs', () => {
  it('processes only the requested event durable coordinates', async () => {
    const runner = step()
    await expect(runHireReportExportRequestedHandler({
      data: { workspaceId: 'workspace-id', exportId: 'export-id' },
    }, runner)).resolves.toBe('ready')
    expect(mocks.process).toHaveBeenCalledWith({ workspaceId: 'workspace-id', exportId: 'export-id' })
    expect(runner.run).toHaveBeenCalledWith('process-hire-report-export-export-id', expect.any(Function))
  })

  it('uses a minute recovery sweep with bounded global cleanup and tenant-fair ID-only dispatch', async () => {
    mocks.listDueCleanup.mockResolvedValue(['cleanup-a'])
    mocks.listDue
      .mockResolvedValueOnce(['export-a'])
      .mockResolvedValueOnce(['export-b', 'export-c'])
    const runner = step()

    const report = await runHireReportExportRecoverySweep(runner)

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

  it('defines the unregistered requested handler and one-minute recovery function', () => {
    expect(hireReportExportRequestedJob).toMatchObject({
      id: 'hire-report-export-dispatch',
      triggers: [{ event: 'hire/report-export.requested' }],
    })
    expect(hireReportExportRecoveryJob).toMatchObject({
      id: 'hire-report-export-recovery',
      triggers: [{ cron: '* * * * *' }],
    })
  })
})
