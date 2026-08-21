import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  findOneAndUpdate: vi.fn(),
  findOne: vi.fn(),
  updateOne: vi.fn(),
}))

vi.mock('../models/HireRuntimeBinding', () => ({
  HireRuntimeBinding: {
    findOneAndUpdate: mocks.findOneAndUpdate,
    findOne: mocks.findOne,
    updateOne: mocks.updateOne,
  },
}))
vi.mock('../services/runtimeBoundary', () => ({
  connectHireRuntimeDB: mocks.connect,
}))

import {
  __runtimeWriteFence,
  assertRuntimeWritesDrained,
  claimRuntimeWriteCapability,
  recordRuntimeStorageCapability,
  releaseRuntimeReplayWriteReservations,
  reserveRuntimeReplayWrites,
  runtimeWriteDrainMs,
} from '../services/runtimeWriteFence'

const PRINCIPAL_ID = 'a'.repeat(24)
const SESSION_ID = 'b'.repeat(24)
const BINDING_ID = 'c'.repeat(24)
const WORKSPACE_ID = 'd'.repeat(24)
const KEY = `recordings/${PRINCIPAL_ID}/${SESSION_ID}-1723248000000.webm`
const SCREEN_KEY = `recordings/${PRINCIPAL_ID}/${SESSION_ID}-screen-1723248000000.webm`
const AUDIO_KEY = `recordings/${PRINCIPAL_ID}/${SESSION_ID}-audio-1723248000000.webm`

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.findOneAndUpdate.mockResolvedValue({ _id: BINDING_ID })
  mocks.findOne.mockReturnValue({
    select: () => ({ lean: async () => ({ status: 'active' }) }),
  })
  mocks.updateOne.mockResolvedValue({ acknowledged: true, matchedCount: 1 })
})

describe('runtime host write fence', () => {
  it('allows only known mutating engine routes and gives storage capabilities a longer drain', () => {
    expect(runtimeWriteDrainMs('/api/generate-feedback', 'POST')).toBe(
      __runtimeWriteFence.RUNTIME_WRITE_DRAIN_MS,
    )
    expect(runtimeWriteDrainMs(`/api/interviews/${SESSION_ID}`, 'PATCH')).toBe(
      __runtimeWriteFence.RUNTIME_WRITE_DRAIN_MS,
    )
    expect(runtimeWriteDrainMs('/api/storage/presign', 'POST')).toBe(
      __runtimeWriteFence.RUNTIME_STORAGE_CAPABILITY_MS,
    )
    expect(runtimeWriteDrainMs('/api/interviews', 'GET')).toBeNull()
    expect(runtimeWriteDrainMs('/api/account/export', 'POST')).toBeNull()
  })

  it('atomically extends the drain horizon only on a live non-purge binding', async () => {
    const now = new Date('2026-08-10T00:00:00.000Z')
    await claimRuntimeWriteCapability({
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      pathname: '/api/generate-feedback',
      method: 'POST',
      now,
    })
    expect(mocks.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        principalId: PRINCIPAL_ID,
        revokedAt: { $exists: false },
        purgePersonalData: { $ne: true },
      }),
      {
        $max: {
          runtimeWriteDrainUntil: new Date(
            now.getTime() + __runtimeWriteFence.RUNTIME_WRITE_DRAIN_MS,
          ),
        },
      },
      { new: true },
    )
  })

  it('rejects a new write after revocation wins the binding race', async () => {
    mocks.findOneAndUpdate.mockResolvedValueOnce(null)
    mocks.findOne.mockReturnValueOnce({
      select: () => ({
        lean: async () => ({ status: 'revoked', revokedAt: new Date() }),
      }),
    })
    await expect(
      claimRuntimeWriteCapability({
        workspaceId: WORKSPACE_ID,
        principalId: PRINCIPAL_ID,
        pathname: '/api/generate-feedback',
        method: 'POST',
      }),
    ).rejects.toMatchObject({ status: 410, code: 'ACCOUNT_UNAVAILABLE' })
  })

  it('distinguishes a terminal media fence from an account privacy boundary', async () => {
    mocks.findOneAndUpdate.mockResolvedValueOnce(null)
    mocks.findOne.mockReturnValueOnce({
      select: () => ({
        lean: async () => ({ status: 'completed' }),
      }),
    })

    await expect(claimRuntimeWriteCapability({
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      pathname: '/api/storage/multipart',
      method: 'POST',
    })).rejects.toMatchObject({ status: 410, code: 'MEDIA_TERMINAL' })
  })

  it('atomically reserves the exact replay kind before a storage side effect', async () => {
    const now = new Date('2026-08-10T00:00:00.000Z')

    const reservations = await reserveRuntimeReplayWrites({
      workspaceId: WORKSPACE_ID,
      bindingId: BINDING_ID,
      principalId: PRINCIPAL_ID,
      runtimeSessionId: SESSION_ID,
      kinds: ['camera'],
      now,
    })

    expect(reservations).toEqual([
      { reservationId: expect.stringMatching(/^[a-f0-9]{64}$/), kind: 'camera' },
    ])
    expect(mocks.updateOne).toHaveBeenNthCalledWith(
      1,
      {
        _id: BINDING_ID,
        workspaceId: WORKSPACE_ID,
        principalId: PRINCIPAL_ID,
        runtimeSessionId: SESSION_ID,
      },
      { $pull: { mediaWriteReservations: { expiresAt: { $lte: now } } } },
    )
    expect(mocks.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: BINDING_ID,
        mediaCompletionContractVersion: 1,
        $and: expect.arrayContaining([
          expect.objectContaining({
            $or: expect.arrayContaining([
              expect.objectContaining({
                status: 'active',
                cameraMediaStatus: { $nin: ['published', 'unavailable'] },
              }),
            ]),
          }),
          expect.objectContaining({
            $or: expect.arrayContaining([
              { cameraMediaTerminalClaimToken: { $exists: false } },
            ]),
          }),
        ]),
      }),
      {
        $push: {
          mediaWriteReservations: {
            reservationId: reservations[0].reservationId,
            kind: 'camera',
            expiresAt: new Date(
              now.getTime() + __runtimeWriteFence.REPLAY_WRITE_RESERVATION_MS,
            ),
          },
        },
      },
      { new: true },
    )
  })

  it('releases only the reservation ids owned by the completed request', async () => {
    await releaseRuntimeReplayWriteReservations({
      workspaceId: WORKSPACE_ID,
      bindingId: BINDING_ID,
      reservations: [
        { reservationId: 'a'.repeat(64), kind: 'camera' },
        { reservationId: 'b'.repeat(64), kind: 'screen' },
      ],
    })

    expect(mocks.updateOne).toHaveBeenCalledWith(
      { _id: BINDING_ID, workspaceId: WORKSPACE_ID },
      {
        $pull: {
          mediaWriteReservations: {
            reservationId: { $in: ['a'.repeat(64), 'b'.repeat(64)] },
          },
        },
      },
    )
  })

  it('claims a completed binding only for a bounded pending replay continuation', async () => {
    await claimRuntimeWriteCapability({
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      pathname: '/api/storage/multipart',
      method: 'POST',
    })
    expect(mocks.findOneAndUpdate.mock.calls[0][0]).toMatchObject({
      $or: [
        { status: 'active' },
        {
          status: 'completed',
          publishedRevision: { $gte: 1, $lt: 10 },
          $or: [
            { cameraMediaStatus: 'pending' },
            {
              screenMediaStatus: 'pending',
              consentVersion: 'hire-ai-v6-2026-08-20',
            },
          ],
        },
      ],
    })

    mocks.findOneAndUpdate.mockClear()
    await claimRuntimeWriteCapability({
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      pathname: '/api/generate-feedback',
      method: 'POST',
    })
    expect(mocks.findOneAndUpdate.mock.calls[0][0]).toMatchObject({
      status: 'active',
    })
    expect(mocks.findOneAndUpdate.mock.calls[0][0]).not.toHaveProperty('$or')
  })

  it('inventories an issued object and multipart upload before exposure', async () => {
    const now = new Date('2026-08-10T00:00:00.000Z')
    await recordRuntimeStorageCapability({
      workspaceId: WORKSPACE_ID,
      bindingId: BINDING_ID,
      principalId: PRINCIPAL_ID,
      runtimeSessionId: SESSION_ID,
      key: KEY,
      uploadId: 'upload-1',
      now,
    })
    expect(mocks.updateOne).toHaveBeenCalledTimes(2)
    expect(mocks.updateOne.mock.calls[1][1]).toMatchObject({
      $push: {
        issuedObjectCapabilities: {
          key: KEY,
          runtimeSessionId: SESSION_ID,
        },
        issuedMultipartCapabilities: {
          key: KEY,
          runtimeSessionId: SESSION_ID,
          uploadId: 'upload-1',
        },
      },
    })
  })

  it('inventories completed capabilities only for their exact pending replay kind', async () => {
    await recordRuntimeStorageCapability({
      workspaceId: WORKSPACE_ID,
      bindingId: BINDING_ID,
      principalId: PRINCIPAL_ID,
      runtimeSessionId: SESSION_ID,
      key: SCREEN_KEY,
      uploadId: 'screen-upload',
    })
    expect(mocks.updateOne.mock.calls[0][0]).toMatchObject({
      $or: [
        {
          status: { $in: ['provisioned', 'active'] },
          screenMediaStatus: { $ne: 'unavailable' },
        },
        {
          status: 'completed',
          publishedRevision: { $gte: 1, $lt: 10 },
          screenMediaStatus: 'pending',
          consentVersion: 'hire-ai-v6-2026-08-20',
        },
      ],
    })

    mocks.updateOne.mockClear()
    await recordRuntimeStorageCapability({
      workspaceId: WORKSPACE_ID,
      bindingId: BINDING_ID,
      principalId: PRINCIPAL_ID,
      runtimeSessionId: SESSION_ID,
      key: AUDIO_KEY,
    })
    expect(mocks.updateOne.mock.calls[0][0]).toMatchObject({
      status: { $in: ['provisioned', 'active'] },
    })
    expect(mocks.updateOne.mock.calls[0][0]).not.toHaveProperty('$or')
  })

  it('refuses to inventory a foreign R2 key', async () => {
    await expect(
      recordRuntimeStorageCapability({
        workspaceId: WORKSPACE_ID,
        bindingId: BINDING_ID,
        principalId: PRINCIPAL_ID,
        runtimeSessionId: SESSION_ID,
        key: `recordings/${'e'.repeat(24)}/${SESSION_ID}-1723248000000.webm`,
      }),
    ).rejects.toThrow(/crossed/)
    expect(mocks.updateOne).not.toHaveBeenCalled()
  })

  it('blocks purge until the last admitted operation or URL capability expires', () => {
    const now = new Date('2026-08-10T00:00:00.000Z')
    expect(() =>
      assertRuntimeWritesDrained(
        { runtimeWriteDrainUntil: new Date(now.getTime() + 1) },
        now,
      ),
    ).toThrow(/waiting/)
    expect(() =>
      assertRuntimeWritesDrained({ runtimeWriteDrainUntil: now }, now),
    ).not.toThrow()
  })
})
