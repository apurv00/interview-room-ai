import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  bindingClaim: vi.fn(),
  bindingExists: vi.fn(),
  bindingUpdate: vi.fn(),
  revocationExists: vi.fn(),
  userUpsert: vi.fn(),
  userDelete: vi.fn(),
}))

vi.mock('../services/runtimeBoundary', () => ({
  connectHireRuntimeDB: mocks.connect,
}))
vi.mock('../models/HireRuntimeBinding', () => ({
  HireRuntimeBinding: {
    findOneAndUpdate: mocks.bindingClaim,
    exists: mocks.bindingExists,
    updateOne: mocks.bindingUpdate,
  },
}))
vi.mock('../models/HireRuntimeRevocation', () => ({
  HireRuntimeRevocation: { exists: mocks.revocationExists },
}))
vi.mock('@shared/db/models/User', () => ({
  User: {
    findOneAndUpdate: mocks.userUpsert,
    deleteOne: mocks.userDelete,
  },
}))

import { ensureRuntimePrincipal } from '../services/runtimePrincipalService'

const WORKSPACE_ID = 'a'.repeat(24)
const APPLICATION_ID = 'b'.repeat(24)
const ROUND_ID = 'c'.repeat(24)
const PRINCIPAL_ID = 'd'.repeat(24)
const BINDING_ID = 'e'.repeat(24)

function objectId(value: string) {
  return { toString: () => value }
}

const binding = {
  _id: objectId(BINDING_ID),
  workspaceId: objectId(WORKSPACE_ID),
  applicationId: objectId(APPLICATION_ID),
  roundId: objectId(ROUND_ID),
  principalId: objectId(PRINCIPAL_ID),
  status: 'provisioned',
  config: { experience: '3-6' },
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.bindingClaim.mockResolvedValue(binding)
  mocks.bindingExists.mockResolvedValue({ _id: BINDING_ID })
  mocks.bindingUpdate.mockResolvedValue({ acknowledged: true, matchedCount: 1 })
  mocks.revocationExists.mockResolvedValue(false)
  mocks.userUpsert.mockResolvedValue({ _id: PRINCIPAL_ID })
  mocks.userDelete.mockResolvedValue({ acknowledged: true, deletedCount: 1 })
})

describe('runtime principal creation versus privacy revocation', () => {
  it('claims a bounded writer lease before creating the synthetic principal', async () => {
    await expect(ensureRuntimePrincipal(binding as never)).resolves.toEqual({
      _id: PRINCIPAL_ID,
    })

    expect(mocks.bindingClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: binding._id,
        revokedAt: { $exists: false },
        purgePersonalData: { $ne: true },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          principalLeaseToken: expect.stringMatching(/^[a-f0-9]{64}$/),
          principalLeaseExpiresAt: expect.any(Date),
        }),
      }),
      { new: true },
    )
    expect(mocks.userUpsert).toHaveBeenCalledWith(
      {
        _id: binding.principalId,
        email: `round-${ROUND_ID}@guests.interviewprep.internal`,
        organizationId: binding.workspaceId,
      },
      expect.objectContaining({
        $setOnInsert: expect.not.objectContaining({
          candidateEmail: expect.anything(),
        }),
      }),
      expect.objectContaining({ upsert: true }),
    )
    expect(mocks.bindingUpdate.mock.calls.at(-1)?.[1]).toEqual({
      $unset: { principalLeaseToken: 1, principalLeaseExpiresAt: 1 },
    })
  })

  it('does not create a User when the durable revocation tombstone already won', async () => {
    mocks.revocationExists.mockResolvedValueOnce(true)
    await expect(ensureRuntimePrincipal(binding as never)).resolves.toBeNull()
    expect(mocks.userUpsert).not.toHaveBeenCalled()
    expect(mocks.bindingUpdate).toHaveBeenCalledOnce()
  })

  it('deletes a principal created in the narrow post-upsert tombstone race', async () => {
    mocks.revocationExists
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)

    await expect(ensureRuntimePrincipal(binding as never)).resolves.toBeNull()
    expect(mocks.userDelete).toHaveBeenCalledWith({
      _id: binding.principalId,
      email: `round-${ROUND_ID}@guests.interviewprep.internal`,
      organizationId: binding.workspaceId,
    })
    expect(mocks.bindingUpdate).toHaveBeenCalledOnce()
  })

  it('fails closed when the late-principal cleanup is not acknowledged', async () => {
    mocks.revocationExists
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    mocks.userDelete.mockResolvedValueOnce({ acknowledged: false, deletedCount: 0 })

    await expect(ensureRuntimePrincipal(binding as never)).rejects.toThrow(
      /cleanup was not acknowledged/,
    )
    expect(mocks.bindingUpdate).toHaveBeenCalledOnce()
  })
})
