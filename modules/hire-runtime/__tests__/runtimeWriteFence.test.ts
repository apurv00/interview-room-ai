import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  findOneAndUpdate: vi.fn(),
  updateOne: vi.fn(),
}))

vi.mock('../models/HireRuntimeBinding', () => ({
  HireRuntimeBinding: {
    findOneAndUpdate: mocks.findOneAndUpdate,
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
  runtimeWriteDrainMs,
} from '../services/runtimeWriteFence'

const PRINCIPAL_ID = 'a'.repeat(24)
const SESSION_ID = 'b'.repeat(24)
const BINDING_ID = 'c'.repeat(24)
const WORKSPACE_ID = 'd'.repeat(24)
const KEY = `recordings/${PRINCIPAL_ID}/${SESSION_ID}-1723248000000.webm`

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.findOneAndUpdate.mockResolvedValue({ _id: BINDING_ID })
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
    await expect(
      claimRuntimeWriteCapability({
        workspaceId: WORKSPACE_ID,
        principalId: PRINCIPAL_ID,
        pathname: '/api/generate-feedback',
        method: 'POST',
      }),
    ).rejects.toMatchObject({ status: 410 })
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
