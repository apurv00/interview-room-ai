import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  getHireAssessmentExportStatus: vi.fn(),
  downloadHireAssessmentExport: vi.fn(),
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

vi.mock('@hire', () => ({ requireMembership: mocks.requireMembership }))
vi.mock('@hire-decisions', () => ({
  getHireAssessmentExportStatus: mocks.getHireAssessmentExportStatus,
  downloadHireAssessmentExport: mocks.downloadHireAssessmentExport,
}))

import { GET as statusGET } from '../route'
import { GET as downloadGET } from '../download/route'

const EXPORT_ID = '2'.repeat(24)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireMembership.mockResolvedValue({ workspace: { _id: 'workspace-1' } })
  mocks.getHireAssessmentExportStatus.mockResolvedValue({
    id: EXPORT_ID,
    status: 'ready',
    requestedAt: new Date('2026-08-14T10:00:00.000Z'),
    expiresAt: new Date('2026-08-21T10:00:00.000Z'),
    readyAt: new Date('2026-08-14T10:02:00.000Z'),
    objectKey: 'hire-assessment-exports/v1/private.pdf',
    decisionSnapshot: { rawResume: 'never return this' },
    failureCode: 'storage_failed',
    url: 'https://storage.example/private.pdf',
  })
  mocks.downloadHireAssessmentExport.mockResolvedValue({
    filename: 'private-candidate-name.pdf',
    contentType: 'application/pdf',
    body: Buffer.from('%PDF-safe'),
    objectKey: 'hire-assessment-exports/v1/private.pdf',
    url: 'https://storage.example/private.pdf',
  })
})

describe('assessment export status and download APIs', () => {
  it('returns only opaque member lifecycle state from the authenticated status route', async () => {
    const response = await statusGET(
      new Request(`https://hire.example/api/workspace/assessment-exports/${EXPORT_ID}`) as never,
      { params: { exportId: EXPORT_ID } },
    )
    const body = await response.json()

    expect(mocks.getHireAssessmentExportStatus).toHaveBeenCalledWith(expect.anything(), EXPORT_ID)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(body).toEqual({
      assessmentExport: {
        id: EXPORT_ID,
        status: 'ready',
        requestedAt: '2026-08-14T10:00:00.000Z',
        expiresAt: '2026-08-21T10:00:00.000Z',
        readyAt: '2026-08-14T10:02:00.000Z',
      },
    })
    const encoded = JSON.stringify(body)
    expect(encoded).not.toContain('objectKey')
    expect(encoded).not.toContain('decisionSnapshot')
    expect(encoded).not.toContain('failureCode')
    expect(encoded).not.toContain('private.pdf')
    expect(encoded).not.toContain('never return this')
  })

  it('streams the private PDF through the member boundary with fixed no-store download headers', async () => {
    const response = await downloadGET(
      new Request(`https://hire.example/api/workspace/assessment-exports/${EXPORT_ID}/download`) as never,
      { params: { exportId: EXPORT_ID } },
    )

    expect(mocks.downloadHireAssessmentExport).toHaveBeenCalledWith(expect.anything(), EXPORT_ID)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('Content-Type')).toBe('application/pdf')
    expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="candidate-assessment.pdf"')
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('Content-Disposition')).not.toContain('private-candidate-name')
    expect(await response.text()).toBe('%PDF-safe')
  })
})
