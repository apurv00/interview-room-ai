import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  previewJobScreeningGate: vi.fn(),
  confirmJobScreeningGate: vi.fn(),
  listJobScreeningGates: vi.fn(),
  createHireScreeningInvitationWaterfall: vi.fn(),
  retryFailedHireScreeningInvitationBatch: vi.fn(),
  getJobScreeningMemberReadProjection: vi.fn(),
  readJobScreeningBatchRecipients: vi.fn(),
  readJobScreeningGateBatches: vi.fn(),
  readHireJobCandidateIdentities: vi.fn(),
  serializeScreeningGate: vi.fn(),
  serializeInvitationBatch: vi.fn(),
  serializeScreeningPreview: vi.fn(),
  sliceScreeningPreviewPage: vi.fn(),
  screeningPreviewPageOffset: vi.fn(),
  encodeScreeningPreviewPageCursor: vi.fn(),
  decodeScreeningHistoryCursor: vi.fn(),
  encodeScreeningHistoryCursor: vi.fn(),
  decodeScreeningBatchCursor: vi.fn(),
  encodeScreeningBatchCursor: vi.fn(),
}))

vi.mock('../../../../_lib/composeHireApiRoute', () => ({
  composeHireApiRoute: (options: any) => async (
    req: Request,
    context?: { params?: Record<string, string> },
  ) => {
    const body = options.schema ? options.schema.parse(await req.json()) : {}
    return options.handler(req, {
      user: { id: 'hire-member:workspace.member', email: 'admin@acme.example' },
      body,
      params: context?.params ?? {},
    })
  },
}))

vi.mock('@hire', () => ({
  HIRE_SCREENING_GATE_MAX_EXCEPTIONS: 100,
  requireMembership: mocks.requireMembership,
  previewJobScreeningGate: mocks.previewJobScreeningGate,
  confirmJobScreeningGate: mocks.confirmJobScreeningGate,
  listJobScreeningGates: mocks.listJobScreeningGates,
  createHireScreeningInvitationWaterfall: mocks.createHireScreeningInvitationWaterfall,
  retryFailedHireScreeningInvitationBatch: mocks.retryFailedHireScreeningInvitationBatch,
}))

vi.mock('@hire-operations', () => ({
  getJobScreeningMemberReadProjection: mocks.getJobScreeningMemberReadProjection,
  readJobScreeningBatchRecipients: mocks.readJobScreeningBatchRecipients,
  readJobScreeningGateBatches: mocks.readJobScreeningGateBatches,
  readHireJobCandidateIdentities: mocks.readHireJobCandidateIdentities,
}))

vi.mock('../_lib/serialize', () => ({
  SCREENING_PREVIEW_PAGE_SIZE: 50,
  serializeScreeningGate: mocks.serializeScreeningGate,
  serializeInvitationBatch: mocks.serializeInvitationBatch,
  serializeScreeningPreview: mocks.serializeScreeningPreview,
  sliceScreeningPreviewPage: mocks.sliceScreeningPreviewPage,
}))

vi.mock('../_lib/paging', () => ({
  screeningPreviewPageOffset: mocks.screeningPreviewPageOffset,
  encodeScreeningPreviewPageCursor: mocks.encodeScreeningPreviewPageCursor,
  decodeScreeningHistoryCursor: mocks.decodeScreeningHistoryCursor,
  encodeScreeningHistoryCursor: mocks.encodeScreeningHistoryCursor,
  decodeScreeningBatchCursor: mocks.decodeScreeningBatchCursor,
  encodeScreeningBatchCursor: mocks.encodeScreeningBatchCursor,
}))

import { POST as confirmPOST } from '../confirm/route'
import { POST as previewPOST } from '../preview/route'
import { POST as waterfallPOST } from '../gates/[gateId]/waterfall/route'
import { POST as retryPOST } from '../batches/[batchId]/retry/route'
import { GET as recipientsGET } from '../batches/[batchId]/recipients/route'
import { GET as batchesGET } from '../gates/[gateId]/batches/route'
import { GET as candidatesGET } from '../candidates/route'
import { GET } from '../route'

const JOB_ID = '222222222222222222222222'
const ctx = {
  workspace: { _id: '111111111111111111111111', name: 'Acme' },
  membership: { _id: '333333333333333333333333', role: 'admin' },
}
const projection = { candidates: [] }

const preview = {
  preview: {
    workspaceId: '111111111111111111111111',
    jobId: JOB_ID,
    rule: { mode: 'top_n', topN: 1, knockoutSettings: {} },
    rankedApplications: [],
    cutLine: { applicationId: null },
  },
  requirementVersion: {
    id: '333333333333333333333333',
    version: 2,
    contentHash: 'c'.repeat(64),
  },
  previewFingerprint: 'a'.repeat(64),
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireMembership.mockResolvedValue(ctx)
  mocks.previewJobScreeningGate.mockResolvedValue(preview)
  mocks.confirmJobScreeningGate.mockResolvedValue({
    gate: { _id: 'gate-1' },
    batch: { _id: 'batch-1' },
    itemCount: 1,
    ...preview,
  })
  mocks.listJobScreeningGates.mockResolvedValue({
    items: [{
      gate: { _id: 'gate-1' },
      batches: [{ _id: 'batch-1' }],
      hasMoreBatches: false,
    }],
    nextCursor: null,
  })
  mocks.getJobScreeningMemberReadProjection.mockResolvedValue(projection)
  mocks.readJobScreeningBatchRecipients.mockResolvedValue({
    recipients: [],
    hasMore: false,
    nextCursor: null,
  })
  mocks.readJobScreeningGateBatches.mockResolvedValue({
    batches: [],
    hasMore: false,
    nextCursor: null,
  })
  mocks.readHireJobCandidateIdentities.mockResolvedValue({
    candidates: [],
    pageInfo: { limit: 20, nextCursor: null },
  })
  mocks.createHireScreeningInvitationWaterfall.mockResolvedValue({
    batchId: 'batch-2',
    itemIds: ['item-1'],
    count: 1,
  })
  mocks.retryFailedHireScreeningInvitationBatch.mockResolvedValue({
    requeued: 1,
    itemIds: ['item-1'],
  })
  mocks.serializeScreeningGate.mockReturnValue({ id: 'gate-1', batches: [{ id: 'batch-1' }] })
  mocks.serializeInvitationBatch.mockReturnValue({ id: 'batch-1', status: 'planned' })
  mocks.sliceScreeningPreviewPage.mockReturnValue({
    scope: 'selected',
    rows: [],
    total: 0,
    offset: 0,
    hasPrevious: false,
    hasNext: false,
  })
  mocks.screeningPreviewPageOffset.mockReturnValue(0)
  mocks.encodeScreeningPreviewPageCursor.mockReturnValue('opaque-page')
  mocks.decodeScreeningHistoryCursor.mockReturnValue(undefined)
  mocks.encodeScreeningHistoryCursor.mockReturnValue('opaque-history')
  mocks.decodeScreeningBatchCursor.mockReturnValue(undefined)
  mocks.encodeScreeningBatchCursor.mockReturnValue('opaque-batches')
  mocks.serializeScreeningPreview.mockImplementation((value, page, readProjection) => ({
    workspaceId: value.workspaceId,
    page,
    identityEnriched: Boolean(readProjection),
  }))
})

describe('workspace job screening routes', () => {
  it('returns a no-store, authenticated read-only preview', async () => {
    const response = await previewPOST(
      new Request(`https://hire.example/api/workspace/jobs/${JOB_ID}/screening/preview`, {
        method: 'POST',
        body: JSON.stringify({ rule: { mode: 'top_n', topN: 1 } }),
      }) as never,
      { params: { jobId: JOB_ID } },
    )

    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      ...preview,
      preview: {
        workspaceId: preview.preview.workspaceId,
        page: expect.objectContaining({ scope: 'selected', rows: [] }),
        identityEnriched: true,
      },
    })
    expect(mocks.requireMembership).toHaveBeenCalledWith({
      userId: 'hire-member:workspace.member',
      email: 'admin@acme.example',
    })
    expect(mocks.previewJobScreeningGate).toHaveBeenCalledWith(
      ctx,
      JOB_ID,
      { rule: { mode: 'top_n', topN: 1 } },
    )
    expect(mocks.getJobScreeningMemberReadProjection).toHaveBeenCalledWith(
      ctx,
      JOB_ID,
      { candidateCoordinates: [] },
    )
    expect(mocks.serializeScreeningPreview).toHaveBeenCalledWith(
      preview.preview,
      expect.objectContaining({
        scope: 'selected',
        rows: [],
        previousCursor: null,
        nextCursor: null,
      }),
      projection,
    )
  })

  it('accepts only a paired, server-owned candidate selection handoff', async () => {
    const body = {
      rule: { mode: 'top_n', topN: 1 },
      selectionSnapshotId: '444444444444444444444444',
      selectionNote: 'Recruiter selected this cohort for screening review',
    }
    await previewPOST(
      new Request(`https://hire.example/api/workspace/jobs/${JOB_ID}/screening/preview`, {
        method: 'POST',
        body: JSON.stringify(body),
      }) as never,
      { params: { jobId: JOB_ID } },
    )
    expect(mocks.previewJobScreeningGate).toHaveBeenCalledWith(ctx, JOB_ID, body)

    mocks.previewJobScreeningGate.mockClear()
    await expect(
      previewPOST(
        new Request(`https://hire.example/api/workspace/jobs/${JOB_ID}/screening/preview`, {
          method: 'POST',
          body: JSON.stringify({
            rule: { mode: 'top_n', topN: 1 },
            selectionSnapshotId: '444444444444444444444444',
          }),
        }) as never,
        { params: { jobId: JOB_ID } },
      ),
    ).rejects.toMatchObject({ name: 'ZodError' })
    expect(mocks.previewJobScreeningGate).not.toHaveBeenCalled()
  })

  it('rebuilds a fingerprint-bound preview page without passing page state into ranking', async () => {
    mocks.sliceScreeningPreviewPage.mockReturnValueOnce({
      scope: 'evaluated',
      rows: [],
      total: 5_000,
      offset: 50,
      hasPrevious: true,
      hasNext: true,
    })
    mocks.screeningPreviewPageOffset.mockReturnValueOnce(50)
    const body = {
      rule: { mode: 'top_n', topN: 10 },
      page: {
        scope: 'evaluated',
        cursor: 'opaque-page',
        expectedFingerprint: preview.previewFingerprint,
      },
    }
    const response = await previewPOST(
      new Request(`https://hire.example/api/workspace/jobs/${JOB_ID}/screening/preview`, {
        method: 'POST',
        body: JSON.stringify(body),
      }) as never,
      { params: { jobId: JOB_ID } },
    )

    expect(response.status).toBe(200)
    expect(mocks.previewJobScreeningGate).toHaveBeenCalledWith(
      ctx,
      JOB_ID,
      { rule: { mode: 'top_n', topN: 10 } },
    )
    expect(mocks.screeningPreviewPageOffset).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'evaluated',
        cursor: 'opaque-page',
        expectedFingerprint: preview.previewFingerprint,
        currentFingerprint: preview.previewFingerprint,
      }),
    )
    expect(mocks.getJobScreeningMemberReadProjection).toHaveBeenCalledWith(
      ctx,
      JOB_ID,
      { candidateCoordinates: [] },
    )
    expect(mocks.encodeScreeningPreviewPageCursor).toHaveBeenCalledTimes(2)
  })

  it('projects a cut-line identity separately when it falls outside the 50-row page', async () => {
    const pageRows = Array.from({ length: 50 }, (_, index) => ({
      applicationId: (index + 1).toString(16).padStart(24, '0'),
      candidateId: (index + 101).toString(16).padStart(24, '0'),
    }))
    const cutLine = {
      applicationId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      candidateId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
    }
    mocks.previewJobScreeningGate.mockResolvedValueOnce({
      ...preview,
      preview: {
        ...preview.preview,
        cutLine: { applicationId: cutLine.applicationId },
        rankedApplications: [...pageRows, cutLine],
      },
    })
    mocks.sliceScreeningPreviewPage.mockReturnValueOnce({
      scope: 'selected',
      rows: pageRows,
      total: 51,
      offset: 0,
      hasPrevious: false,
      hasNext: true,
    })
    mocks.getJobScreeningMemberReadProjection
      .mockResolvedValueOnce({ candidates: [{ applicationId: pageRows[0].applicationId }] })
      .mockResolvedValueOnce({ candidates: [{ applicationId: cutLine.applicationId }] })

    await previewPOST(
      new Request(`https://hire.example/api/workspace/jobs/${JOB_ID}/screening/preview`, {
        method: 'POST',
        body: JSON.stringify({ rule: { mode: 'top_n', topN: 51 } }),
      }) as never,
      { params: { jobId: JOB_ID } },
    )

    expect(mocks.getJobScreeningMemberReadProjection).toHaveBeenNthCalledWith(
      1,
      ctx,
      JOB_ID,
      { candidateCoordinates: pageRows },
    )
    expect(mocks.getJobScreeningMemberReadProjection).toHaveBeenNthCalledWith(
      2,
      ctx,
      JOB_ID,
      { candidateCoordinates: [cutLine] },
    )
    expect(mocks.serializeScreeningPreview).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { candidates: [
        { applicationId: pageRows[0].applicationId },
        { applicationId: cutLine.applicationId },
      ] },
    )
  })

  it('rejects oversized and duplicate explicit-exception payloads before service work', async () => {
    const exceptions = Array.from({ length: 101 }, (_, index) => ({
      applicationId: index.toString(16).padStart(24, '0'),
      action: 'include',
      note: 'Reviewed exception',
    }))
    await expect(
      previewPOST(
        new Request(`https://hire.example/api/workspace/jobs/${JOB_ID}/screening/preview`, {
          method: 'POST',
          body: JSON.stringify({
            rule: { mode: 'top_n', topN: 1 },
            exceptions,
          }),
        }) as never,
        { params: { jobId: JOB_ID } },
      ),
    ).rejects.toMatchObject({ name: 'ZodError' })

    const duplicate = {
      applicationId: '555555555555555555555555',
      action: 'exclude',
      note: 'Reviewed exception',
    }
    await expect(
      confirmPOST(
        new Request(`https://hire.example/api/workspace/jobs/${JOB_ID}/screening/confirm`, {
          method: 'POST',
          body: JSON.stringify({
            rule: { mode: 'top_n', topN: 1 },
            exceptions: [duplicate, duplicate],
            previewFingerprint: 'b'.repeat(64),
          }),
        }) as never,
        { params: { jobId: JOB_ID } },
      ),
    ).rejects.toMatchObject({ name: 'ZodError' })

    expect(mocks.previewJobScreeningGate).not.toHaveBeenCalled()
    expect(mocks.confirmJobScreeningGate).not.toHaveBeenCalled()
  })

  it('requires an explicit preview proof before confirming a planned batch', async () => {
    const body = {
      rule: { mode: 'above_threshold', scoreThreshold: 72 },
      previewFingerprint: 'b'.repeat(64),
      sendAfter: '2026-08-13T09:00:00.000Z',
    }
    const response = await confirmPOST(
      new Request(`https://hire.example/api/workspace/jobs/${JOB_ID}/screening/confirm`, {
        method: 'POST',
        body: JSON.stringify(body),
      }) as never,
      { params: { jobId: JOB_ID } },
    )

    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mocks.confirmJobScreeningGate).toHaveBeenCalledWith(ctx, JOB_ID, body)
    await expect(response.json()).resolves.toEqual({
      gate: { id: 'gate-1', batches: [{ id: 'batch-1' }] },
      batch: { id: 'batch-1', status: 'planned' },
      itemCount: 1,
      requirementVersion: preview.requirementVersion,
      previewFingerprint: preview.previewFingerprint,
    })
    expect(mocks.getJobScreeningMemberReadProjection).not.toHaveBeenCalled()
    expect(mocks.serializeScreeningGate).toHaveBeenCalledWith(
      { _id: 'gate-1' },
      [{ _id: 'batch-1' }],
    )
    expect(mocks.serializeInvitationBatch).toHaveBeenCalledWith(
      { _id: 'batch-1' },
    )
  })

  it('never lets a post-commit read dependency turn confirmation into a failed mutation', async () => {
    mocks.getJobScreeningMemberReadProjection.mockRejectedValueOnce(
      new Error('read replica unavailable'),
    )
    const body = {
      rule: { mode: 'top_n', topN: 1 },
      previewFingerprint: 'b'.repeat(64),
    }

    const response = await confirmPOST(
      new Request(`https://hire.example/api/workspace/jobs/${JOB_ID}/screening/confirm`, {
        method: 'POST',
        body: JSON.stringify(body),
      }) as never,
      { params: { jobId: JOB_ID } },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mocks.confirmJobScreeningGate).toHaveBeenCalledTimes(1)
    expect(mocks.confirmJobScreeningGate).toHaveBeenCalledWith(ctx, JOB_ID, body)
    expect(mocks.getJobScreeningMemberReadProjection).not.toHaveBeenCalled()
    expect(mocks.serializeScreeningGate).toHaveBeenCalledWith(
      { _id: 'gate-1' },
      [{ _id: 'batch-1' }],
    )
    expect(mocks.serializeInvitationBatch).toHaveBeenCalledWith(
      { _id: 'batch-1' },
    )
    await expect(response.json()).resolves.toMatchObject({
      itemCount: 1,
    })
  })

  it('lists only the requested job’s persisted gates through the membership boundary', async () => {
    const response = await GET(
      new Request(`https://hire.example/api/workspace/jobs/${JOB_ID}/screening`) as never,
      { params: { jobId: JOB_ID } },
    )

    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      gates: [{
        id: 'gate-1',
        batches: [{ id: 'batch-1' }],
        batchPageInfo: { limit: 10, hasNextPage: false, nextCursor: null },
      }],
      pageInfo: { limit: 10, hasNextPage: false, nextCursor: null },
    })
    expect(mocks.listJobScreeningGates).toHaveBeenCalledWith(
      ctx,
      JOB_ID,
      { limit: 10, cursor: undefined },
    )
    expect(mocks.serializeScreeningGate).toHaveBeenCalledWith(
      { _id: 'gate-1' },
      [{ _id: 'batch-1' }],
      false,
    )
    expect(mocks.getJobScreeningMemberReadProjection).not.toHaveBeenCalled()
  })

  it('reads a bounded older-wave batch page through a gate-scoped opaque cursor', async () => {
    const batch = {
      _id: { toString: () => 'bbbbbbbbbbbbbbbbbbbbbbbb' },
      wave: 9,
    }
    mocks.decodeScreeningBatchCursor.mockReturnValueOnce({
      wave: 10,
      id: 'cccccccccccccccccccccccc',
    })
    mocks.readJobScreeningGateBatches.mockResolvedValueOnce({
      batches: [batch],
      hasMore: true,
      nextCursor: { wave: 9, id: 'bbbbbbbbbbbbbbbbbbbbbbbb' },
    })
    mocks.serializeInvitationBatch.mockReturnValueOnce({ id: 'batch-9', wave: 9 })

    const response = await batchesGET(
      new Request(
        `https://hire.example/api/workspace/jobs/${JOB_ID}/screening/gates/aaaaaaaaaaaaaaaaaaaaaaaa/batches?limit=10&cursor=opaque`,
      ) as never,
      { params: { jobId: JOB_ID, gateId: 'aaaaaaaaaaaaaaaaaaaaaaaa' } },
    )

    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mocks.readJobScreeningGateBatches).toHaveBeenCalledWith(
      ctx,
      JOB_ID,
      'aaaaaaaaaaaaaaaaaaaaaaaa',
      {
        limit: 10,
        cursor: { wave: 10, id: 'cccccccccccccccccccccccc' },
      },
    )
    await expect(response.json()).resolves.toEqual({
      batches: [{ id: 'batch-9', wave: 9 }],
      pageInfo: { limit: 10, hasNextPage: true, nextCursor: 'opaque-batches' },
    })
  })

  it('searches only non-terminal candidate identities for documented exceptions', async () => {
    mocks.readHireJobCandidateIdentities.mockResolvedValueOnce({
      candidates: [{
        applicationId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        candidateName: 'Ada Lovelace',
        candidateEmail: 'ada@example.com',
        resumeText: 'never expose',
      }],
      pageInfo: { limit: 20, nextCursor: 'opaque-search' },
    })

    const response = await candidatesGET(
      new Request(
        `https://hire.example/api/workspace/jobs/${JOB_ID}/screening/candidates?q=ada&limit=20`,
      ) as never,
      { params: { jobId: JOB_ID } },
    )

    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mocks.readHireJobCandidateIdentities).toHaveBeenCalledWith({
      workspaceId: ctx.workspace._id.toString(),
      jobId: JOB_ID,
      query: { q: 'ada', limit: 20 },
      nonTerminalOnly: true,
    })
    await expect(response.json()).resolves.toEqual({
      candidates: [{
        applicationId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        candidateName: 'Ada Lovelace',
        candidateEmail: 'ada@example.com',
      }],
      pageInfo: { limit: 20, nextCursor: 'opaque-search' },
    })
  })

  it('rejects repeated or oversized screening-history query parameters', async () => {
    await expect(
      GET(
        new Request(
          `https://hire.example/api/workspace/jobs/${JOB_ID}/screening?limit=10&limit=20`,
        ) as never,
        { params: { jobId: JOB_ID } },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY', statusCode: 400 })
    await expect(
      GET(
        new Request(
          `https://hire.example/api/workspace/jobs/${JOB_ID}/screening?limit=26`,
        ) as never,
        { params: { jobId: JOB_ID } },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_LIMIT', statusCode: 400 })
    expect(mocks.listJobScreeningGates).not.toHaveBeenCalled()
  })

  it('loads one authenticated, batch-scoped recipient page without accepting tenant scope', async () => {
    const response = await recipientsGET(
      new Request(
        `https://hire.example/api/workspace/jobs/${JOB_ID}/screening/batches/bbbbbbbbbbbbbbbbbbbbbbbb/recipients?cursor=opaque&limit=25&workspaceId=other`,
      ) as never,
      { params: { jobId: JOB_ID, batchId: 'bbbbbbbbbbbbbbbbbbbbbbbb' } },
    )

    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mocks.requireMembership).toHaveBeenCalledWith({
      userId: 'hire-member:workspace.member',
      email: 'admin@acme.example',
    })
    expect(mocks.readJobScreeningBatchRecipients).toHaveBeenCalledWith(
      ctx,
      JOB_ID,
      'bbbbbbbbbbbbbbbbbbbbbbbb',
      { cursor: 'opaque', limit: 25 },
    )
    await expect(response.json()).resolves.toEqual({
      recipients: [],
      hasMore: false,
      nextCursor: null,
    })
  })

  it('requires a bounded explicit HR waterfall command and never accepts candidate ids', async () => {
    const response = await waterfallPOST(
      new Request(`https://hire.example/api/workspace/jobs/${JOB_ID}/screening/gates/gate-1/waterfall`, {
        method: 'POST',
        body: JSON.stringify({ count: 2, sendAfter: '2026-08-13T09:00:00.000Z' }),
      }) as never,
      { params: { jobId: JOB_ID, gateId: 'aaaaaaaaaaaaaaaaaaaaaaaa' } },
    )

    expect(response.status).toBe(201)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mocks.createHireScreeningInvitationWaterfall).toHaveBeenCalledWith(ctx, {
      jobId: JOB_ID,
      gateId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      count: 2,
      sendAfter: '2026-08-13T09:00:00.000Z',
    })
    await expect(response.json()).resolves.toEqual({
      batchId: 'batch-2',
      itemIds: ['item-1'],
      count: 1,
    })
  })

  it('rejects an unbounded waterfall body before calling the service', async () => {
    await expect(
      waterfallPOST(
        new Request(`https://hire.example/api/workspace/jobs/${JOB_ID}/screening/gates/gate-1/waterfall`, {
          method: 'POST',
          body: JSON.stringify({ count: 101, applicationIds: ['not-accepted'] }),
        }) as never,
        { params: { jobId: JOB_ID, gateId: 'aaaaaaaaaaaaaaaaaaaaaaaa' } },
      ),
    ).rejects.toMatchObject({ name: 'ZodError' })
    expect(mocks.createHireScreeningInvitationWaterfall).not.toHaveBeenCalled()
  })

  it('requeues only failed batch items through an explicit HR command', async () => {
    const response = await retryPOST(
      new Request(`https://hire.example/api/workspace/jobs/${JOB_ID}/screening/batches/batch-1/retry`, {
        method: 'POST',
        body: JSON.stringify({}),
      }) as never,
      { params: { jobId: JOB_ID, batchId: 'bbbbbbbbbbbbbbbbbbbbbbbb' } },
    )

    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mocks.retryFailedHireScreeningInvitationBatch).toHaveBeenCalledWith(ctx, {
      jobId: JOB_ID,
      batchId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
    })
    await expect(response.json()).resolves.toEqual({ requeued: 1, itemIds: ['item-1'] })
  })
})
