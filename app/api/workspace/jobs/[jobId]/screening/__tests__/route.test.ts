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
  serializeScreeningGate: vi.fn(),
  serializeInvitationBatch: vi.fn(),
  serializeScreeningPreview: vi.fn(),
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
}))

vi.mock('../_lib/serialize', () => ({
  serializeScreeningGate: mocks.serializeScreeningGate,
  serializeInvitationBatch: mocks.serializeInvitationBatch,
  serializeScreeningPreview: mocks.serializeScreeningPreview,
}))

import { POST as confirmPOST } from '../confirm/route'
import { POST as previewPOST } from '../preview/route'
import { POST as waterfallPOST } from '../gates/[gateId]/waterfall/route'
import { POST as retryPOST } from '../batches/[batchId]/retry/route'
import { GET as recipientsGET } from '../batches/[batchId]/recipients/route'
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
  mocks.listJobScreeningGates.mockResolvedValue([{
    gate: { _id: 'gate-1', rankedApplications: [] },
    batches: [{ _id: 'batch-1' }],
  }])
  mocks.getJobScreeningMemberReadProjection.mockResolvedValue(projection)
  mocks.readJobScreeningBatchRecipients.mockResolvedValue({
    recipients: [],
    hasMore: false,
    nextCursor: null,
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
  mocks.serializeScreeningPreview.mockImplementation((value, readProjection) => ({
    ...value,
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
      preview: { ...preview.preview, identityEnriched: true },
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
    expect(mocks.serializeScreeningPreview).toHaveBeenCalledWith(preview.preview, projection)
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
      preview: { ...preview.preview, identityEnriched: false },
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
      gates: [{ id: 'gate-1', batches: [{ id: 'batch-1' }] }],
    })
    expect(mocks.listJobScreeningGates).toHaveBeenCalledWith(ctx, JOB_ID)
    expect(mocks.serializeScreeningGate).toHaveBeenCalledWith(
      { _id: 'gate-1', rankedApplications: [] },
      [{ _id: 'batch-1' }],
    )
    expect(mocks.getJobScreeningMemberReadProjection).not.toHaveBeenCalled()
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
