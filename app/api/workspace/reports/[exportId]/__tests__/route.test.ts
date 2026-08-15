import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  getHireReportExportStatus: vi.fn(),
  downloadHireReportExport: vi.fn(),
}))

vi.mock('../../_lib/composeHireApiRoute', () => ({
  composeHireApiRoute: (options: any) => async (
    req: Request,
    context?: { params?: Record<string, string> },
  ) => options.handler(req, {
    user: { id: 'member-user', email: 'hr@example.com' },
    body: {},
    params: context?.params ?? {},
  }),
}))

vi.mock('../../../_lib/composeHireApiRoute', () => ({
  composeHireApiRoute: (options: any) => async (
    req: Request,
    context?: { params?: Record<string, string> },
  ) => options.handler(req, {
    user: { id: 'member-user', email: 'hr@example.com' },
    body: {},
    params: context?.params ?? {},
  }),
}))

vi.mock('@hire/services/workspaceService', () => ({
  requireMembership: mocks.requireMembership,
}))

vi.mock('@/modules/hire-reports/services/hireReportExportService', () => ({
  getHireReportExportStatus: mocks.getHireReportExportStatus,
  downloadHireReportExport: mocks.downloadHireReportExport,
}))

vi.mock('@/modules/hire-reports/services/hireReportExportStorage', () => ({
  HIRE_REPORT_EXPORT_CONTENT_TYPES: {
    pdf: 'application/pdf',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
}))

import { GET as statusGET } from '../route'
import { GET as downloadGET, runtime } from '../download/route'

const EXPORT_ID = '2'.repeat(24)
const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireMembership.mockResolvedValue({ workspace: { _id: 'workspace-1' } })
  mocks.getHireReportExportStatus.mockResolvedValue({
    id: EXPORT_ID,
    reportKind: 'pipeline_status',
    format: 'pdf',
    status: 'ready',
    requestedAt: new Date('2026-08-15T10:00:00.000Z'),
    expiresAt: new Date('2026-08-22T10:00:00.000Z'),
    readyAt: new Date('2026-08-15T10:01:00.000Z'),
    objectKey: 'hire-report-exports/v1/private.pdf',
    reportSnapshot: { rawResume: 'never return this' },
    failureCode: 'storage_failed',
    requestedByName: 'Private actor',
  })
  mocks.downloadHireReportExport.mockResolvedValue({
    filename: 'candidate-name-private.xlsx',
    contentType: XLSX_CONTENT_TYPE,
    body: Buffer.from('PK-safe'),
    objectKey: 'hire-report-exports/v1/private.xlsx',
    url: 'https://storage.example/private.xlsx',
  })
})

describe('member report status and download APIs', () => {
  it('returns only opaque report status after the member tenancy gate with no-store', async () => {
    const response = await statusGET(
      new Request(`https://hire.example/api/workspace/reports/${EXPORT_ID}`) as never,
      { params: { exportId: EXPORT_ID } },
    )
    const body = await response.json()

    expect(mocks.requireMembership).toHaveBeenCalledWith({
      userId: 'member-user',
      email: 'hr@example.com',
    })
    expect(mocks.getHireReportExportStatus).toHaveBeenCalledWith(expect.anything(), EXPORT_ID)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(body).toEqual({
      reportExport: {
        id: EXPORT_ID,
        reportKind: 'pipeline_status',
        format: 'pdf',
        status: 'ready',
        requestedAt: '2026-08-15T10:00:00.000Z',
        expiresAt: '2026-08-22T10:00:00.000Z',
        readyAt: '2026-08-15T10:01:00.000Z',
      },
    })
    const encoded = JSON.stringify(body)
    expect(encoded).not.toContain('objectKey')
    expect(encoded).not.toContain('reportSnapshot')
    expect(encoded).not.toContain('rawResume')
    expect(encoded).not.toContain('Private actor')
    expect(encoded).not.toContain('failureCode')
  })

  it('streams a private XLSX through the Node member boundary with fixed safe headers', async () => {
    const response = await downloadGET(
      new Request(`https://hire.example/api/workspace/reports/${EXPORT_ID}/download`) as never,
      { params: { exportId: EXPORT_ID } },
    )

    expect(runtime).toBe('nodejs')
    expect(mocks.downloadHireReportExport).toHaveBeenCalledWith(expect.anything(), EXPORT_ID)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('Content-Type')).toBe(XLSX_CONTENT_TYPE)
    expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="hire-report.xlsx"')
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('Content-Disposition')).not.toContain('candidate-name-private')
    expect(response.headers.get('Content-Disposition')).not.toContain('private.xlsx')
    expect(await response.text()).toBe('PK-safe')
  })
})
