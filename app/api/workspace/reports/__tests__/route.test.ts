import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  listHireReportExports: vi.fn(),
  requestHirePipelineStatusReport: vi.fn(),
  snapshotFactory: vi.fn(),
}))

vi.mock('../../_lib/composeHireApiRoute', () => ({
  composeHireApiRoute: (options: any) => async (
    req: Request,
    context?: { params?: Record<string, string> },
  ) => options.handler(req, {
    user: { id: 'member-user', email: 'hr@example.com' },
    body: req.method === 'POST' ? await req.json() : {},
    params: context?.params ?? {},
  }),
}))

vi.mock('@hire/services/workspaceService', () => ({
  requireMembership: mocks.requireMembership,
}))

vi.mock('@/modules/hire-reports/services/hireReportExportService', () => ({
  listHireReportExports: mocks.listHireReportExports,
  requestHirePipelineStatusReport: mocks.requestHirePipelineStatusReport,
}))

vi.mock('@/modules/hire-reports/services/hirePipelineStatusReportSnapshotFactory', () => ({
  buildHirePipelineStatusReportSnapshotFromControlRecords: mocks.snapshotFactory,
}))

import { GET, POST } from '../route'

const EXPORT_ID = '2'.repeat(24)
const JOB_ID = '3'.repeat(24)
const OPERATION_ID = '11111111-1111-4111-8111-111111111111'

const opaqueView = {
  id: EXPORT_ID,
  reportKind: 'pipeline_status',
  format: 'xlsx',
  status: 'requested',
  requestedAt: new Date('2026-08-15T10:00:00.000Z'),
  expiresAt: new Date('2026-08-22T10:00:00.000Z'),
  readyAt: null,
  objectKey: 'hire-report-exports/v1/secret.xlsx',
  reportSnapshot: { candidateEmail: 'never-return@example.test' },
  requestedByName: 'Private member',
  failureCode: 'storage_failed',
  downloadUrl: 'https://storage.example/private.xlsx',
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireMembership.mockResolvedValue({ workspace: { _id: 'workspace-1' } })
  mocks.listHireReportExports.mockResolvedValue([opaqueView])
  mocks.requestHirePipelineStatusReport.mockResolvedValue({
    created: true,
    export: opaqueView,
  })
})

describe('member report request and history APIs', () => {
  it('requires member context and lists only opaque tenant-scoped lifecycle rows with no-store', async () => {
    const response = await GET(
      new Request('https://hire.example/api/workspace/reports') as never,
    )
    const body = await response.json()

    expect(mocks.requireMembership).toHaveBeenCalledWith({
      userId: 'member-user',
      email: 'hr@example.com',
    })
    expect(mocks.listHireReportExports).toHaveBeenCalledWith(expect.anything())
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(body).toEqual({
      reportExports: [{
        id: EXPORT_ID,
        reportKind: 'pipeline_status',
        format: 'xlsx',
        status: 'requested',
        requestedAt: '2026-08-15T10:00:00.000Z',
        expiresAt: '2026-08-22T10:00:00.000Z',
        readyAt: null,
      }],
    })
    const encoded = JSON.stringify(body)
    expect(encoded).not.toContain('objectKey')
    expect(encoded).not.toContain('reportSnapshot')
    expect(encoded).not.toContain('candidateEmail')
    expect(encoded).not.toContain('Private member')
    expect(encoded).not.toContain('storage.example')
    expect(encoded).not.toContain('failureCode')
  })

  it('accepts only scope/format/idempotency data and supplies the server-side safe factory', async () => {
    const response = await POST(
      new Request('https://hire.example/api/workspace/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: 'job',
          jobId: JOB_ID,
          format: 'xlsx',
          operationId: OPERATION_ID,
        }),
      }) as never,
    )
    const body = await response.json()

    expect(mocks.requestHirePipelineStatusReport).toHaveBeenCalledWith(
      expect.anything(),
      {
        scope: 'job',
        jobId: JOB_ID,
        format: 'xlsx',
        operationId: OPERATION_ID,
      },
      mocks.snapshotFactory,
    )
    expect(response.status).toBe(201)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(body).toEqual({
      reportExport: {
        id: EXPORT_ID,
        reportKind: 'pipeline_status',
        format: 'xlsx',
        status: 'requested',
        requestedAt: '2026-08-15T10:00:00.000Z',
        expiresAt: '2026-08-22T10:00:00.000Z',
        readyAt: null,
      },
    })
    expect(JSON.stringify(body)).not.toContain('candidateEmail')
    expect(JSON.stringify(body)).not.toContain('secret.xlsx')
  })
})
