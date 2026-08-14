import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  requestHireAssessmentExport: vi.fn(),
}))

vi.mock('../../../../_lib/composeHireApiRoute', () => ({
  composeHireApiRoute: (options: any) => async (
    req: Request,
    context?: { params?: Record<string, string> },
  ) => options.handler(req, {
    user: { id: 'member-user', email: 'hr@example.com' },
    body: await req.json(),
    params: context?.params ?? {},
  }),
}))

vi.mock('@hire', () => ({ requireMembership: mocks.requireMembership }))
vi.mock('@hire-decisions', () => ({
  RequestHireAssessmentExportSchema: { pick: () => ({}) },
  requestHireAssessmentExport: mocks.requestHireAssessmentExport,
}))

import { POST } from '../route'

const APPLICATION_ID = '1'.repeat(24)
const EXPORT_ID = '2'.repeat(24)
const OPERATION_ID = '11111111-1111-4111-8111-111111111111'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireMembership.mockResolvedValue({ workspace: { _id: 'workspace-1' } })
  mocks.requestHireAssessmentExport.mockResolvedValue({
    created: true,
    export: {
      id: EXPORT_ID,
      status: 'pending',
      requestedAt: new Date('2026-08-14T10:00:00.000Z'),
      expiresAt: new Date('2026-08-21T10:00:00.000Z'),
      readyAt: null,
      // Hostile additions must stay inside the service boundary even if a
      // future service regression expands its runtime object.
      objectKey: 'hire-assessment-exports/v1/private.pdf',
      decisionSnapshot: { rawResume: 'never return this' },
      downloadUrl: 'https://storage.example/private.pdf',
      failureCode: 'storage_failed',
    },
  })
})

describe('assessment export request API', () => {
  it('creates a member-authorized export request and returns only its opaque lifecycle state', async () => {
    const response = await POST(
      new Request(`https://hire.example/api/workspace/applications/${APPLICATION_ID}/assessment-exports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationId: OPERATION_ID }),
      }) as never,
      { params: { appId: APPLICATION_ID } },
    )
    const body = await response.json()

    expect(mocks.requireMembership).toHaveBeenCalledWith({
      userId: 'member-user',
      email: 'hr@example.com',
    })
    expect(mocks.requestHireAssessmentExport).toHaveBeenCalledWith(
      expect.anything(),
      { applicationId: APPLICATION_ID, operationId: OPERATION_ID },
    )
    expect(response.status).toBe(201)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(body).toEqual({
      assessmentExport: {
        id: EXPORT_ID,
        status: 'pending',
        requestedAt: '2026-08-14T10:00:00.000Z',
        expiresAt: '2026-08-21T10:00:00.000Z',
        readyAt: null,
      },
    })
    const encoded = JSON.stringify(body)
    expect(encoded).not.toContain('objectKey')
    expect(encoded).not.toContain('decisionSnapshot')
    expect(encoded).not.toContain('downloadUrl')
    expect(encoded).not.toContain('failureCode')
    expect(encoded).not.toContain('never return this')
  })
})
