import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  redisSet: vi.fn(),
  tombstoneFindOne: vi.fn(),
  tombstoneUpdate: vi.fn(),
  bindingFindOneAndUpdate: vi.fn(),
  bindingUpdate: vi.fn(),
  sessionFind: vi.fn(),
  sessionDeleteMany: vi.fn(),
  userFindOne: vi.fn(),
  userUpdate: vi.fn(),
  userDelete: vi.fn(),
  deleteObjects: vi.fn(),
  purgePrincipal: vi.fn(),
  events: [] as string[],
}))

vi.mock('@shared/redis', () => ({ redis: { set: mocks.redisSet } }))
vi.mock('../services/runtimeBoundary', () => ({
  connectHireRuntimeDB: mocks.connect,
}))
vi.mock('../models/HireRuntimeRevocation', () => ({
  HireRuntimeRevocation: {
    findOne: mocks.tombstoneFindOne,
    updateOne: mocks.tombstoneUpdate,
  },
}))
vi.mock('../models/HireRuntimeBinding', () => ({
  HireRuntimeBinding: {
    findOneAndUpdate: mocks.bindingFindOneAndUpdate,
    updateOne: mocks.bindingUpdate,
  },
}))
vi.mock('@shared/db/models/InterviewSession', () => ({
  InterviewSession: {
    find: mocks.sessionFind,
    deleteMany: mocks.sessionDeleteMany,
  },
}))
vi.mock('@shared/db/models/User', () => ({
  User: {
    findOne: mocks.userFindOne,
    updateOne: mocks.userUpdate,
    deleteOne: mocks.userDelete,
  },
}))
vi.mock('../services/runtimeMediaManifest', () => ({
  deleteRuntimePersonalObjects: mocks.deleteObjects,
}))
vi.mock('../services/runtimePersonalDataPurge', () => ({
  purgeRuntimePrincipalData: mocks.purgePrincipal,
}))

import { revokeRuntimeBinding } from '../services/revocationService'

const WORKSPACE_ID = 'a'.repeat(24)
const APPLICATION_ID = 'b'.repeat(24)
const ROUND_ID = 'c'.repeat(24)
const PRINCIPAL_ID = 'd'.repeat(24)
const SESSION_ID = 'e'.repeat(24)

function objectId(value: string) {
  return { toString: () => value }
}

function revocation(purgePersonalData?: boolean) {
  return {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    applicationId: APPLICATION_ID,
    roundId: ROUND_ID,
    revokedAt: '2026-08-10T00:00:00.000Z',
    reason: 'Candidate privacy request',
    ...(purgePersonalData === undefined ? {} : { purgePersonalData }),
  }
}

function binding(overrides: Record<string, unknown> = {}) {
  return {
    _id: objectId('f'.repeat(24)),
    workspaceId: objectId(WORKSPACE_ID),
    applicationId: objectId(APPLICATION_ID),
    roundId: objectId(ROUND_ID),
    principalId: objectId(PRINCIPAL_ID),
    status: 'revoked',
    runtimeSessionId: objectId(SESSION_ID),
    ...overrides,
  }
}

function leanQuery(value: unknown) {
  return { lean: async () => value }
}

function selectedLeanQuery(value: unknown) {
  return { select: () => ({ lean: async () => value }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.events.length = 0
  mocks.connect.mockResolvedValue(undefined)
  mocks.redisSet.mockResolvedValue('OK')
  mocks.tombstoneFindOne.mockReturnValue(leanQuery(null))
  mocks.tombstoneUpdate.mockImplementation(async (_filter, update) => {
    if (update.$set?.purgeStatus === 'completed') mocks.events.push('tombstone')
    return { acknowledged: true, matchedCount: 1 }
  })
  mocks.bindingFindOneAndUpdate.mockResolvedValue(binding())
  mocks.bindingUpdate.mockImplementation(async () => {
    mocks.events.push('binding')
    return { acknowledged: true, matchedCount: 1 }
  })
  mocks.sessionFind.mockReturnValue(
    selectedLeanQuery([
      {
        _id: objectId(SESSION_ID),
        recordingR2Key: `recordings/${PRINCIPAL_ID}/${SESSION_ID}-1723248000000.webm`,
        audioRecordingR2Key: `recordings/${PRINCIPAL_ID}/${SESSION_ID}-audio-1723248000001.webm`,
      },
    ]),
  )
  mocks.userFindOne.mockReturnValue(selectedLeanQuery(null))
  mocks.deleteObjects.mockImplementation(async () => {
    mocks.events.push('r2')
  })
  mocks.purgePrincipal.mockImplementation(async () => {
    mocks.events.push('purge')
    return new Date('2026-08-10T00:10:00.000Z')
  })
  mocks.sessionDeleteMany.mockImplementation(async () => {
    mocks.events.push('sessions')
    return { acknowledged: true, deletedCount: 1 }
  })
  mocks.userDelete.mockImplementation(async () => {
    mocks.events.push('user')
    return { acknowledged: true, deletedCount: 1 }
  })
  mocks.userUpdate.mockResolvedValue({ acknowledged: true })
})

describe('isolated runtime revocation and privacy purge', () => {
  it('defaults to ordinary revocation without deleting retained runtime data', async () => {
    await expect(revokeRuntimeBinding(revocation())).resolves.toEqual({
      outcome: 'revoked',
    })
    expect(mocks.userUpdate).toHaveBeenCalledOnce()
    expect(mocks.purgePrincipal).not.toHaveBeenCalled()
    expect(mocks.sessionDeleteMany).not.toHaveBeenCalled()
    expect(mocks.userDelete).not.toHaveBeenCalled()
  })

  it('deletes R2 first, then sessions and principal, and acknowledges only after tombstones', async () => {
    await expect(revokeRuntimeBinding(revocation(true))).resolves.toEqual({
      outcome: 'revoked',
    })
    expect(mocks.events).toEqual(['purge', 'binding', 'tombstone'])
    expect(mocks.purgePrincipal).toHaveBeenCalledWith({
      binding: expect.objectContaining({ principalId: expect.anything() }),
      roundId: ROUND_ID,
    })
    expect(mocks.bindingUpdate.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: { personalDataPurgedAt: expect.any(Date) },
      $unset: { runtimeSessionId: 1, pendingMediaManifest: 1 },
    })
  })

  it('does not delete DB data or acknowledge when runtime object purge fails', async () => {
    mocks.purgePrincipal.mockRejectedValueOnce(new Error('R2 unavailable'))
    await expect(revokeRuntimeBinding(revocation(true))).rejects.toThrow('R2 unavailable')
    expect(mocks.sessionDeleteMany).not.toHaveBeenCalled()
    expect(mocks.userDelete).not.toHaveBeenCalled()
    expect(mocks.bindingUpdate).not.toHaveBeenCalled()
    expect(
      mocks.tombstoneUpdate.mock.calls.some(([, update]) =>
        update.$set?.purgeStatus === 'completed'),
    ).toBe(false)
  })

  it('waits for an active provisioning lease instead of acknowledging a race', async () => {
    mocks.bindingFindOneAndUpdate.mockResolvedValueOnce(
      binding({
        sessionLeaseToken: 'lease',
        sessionLeaseExpiresAt: new Date(Date.now() + 60_000),
      }),
    )
    await expect(revokeRuntimeBinding(revocation(true))).rejects.toThrow(/waiting/)
    expect(mocks.purgePrincipal).not.toHaveBeenCalled()
  })

  it.each([
    {
      principalLeaseToken: 'principal-lease',
      principalLeaseExpiresAt: new Date(Date.now() + 60_000),
    },
    {
      feedbackRecoveryLeaseToken: 'feedback-lease',
      feedbackRecoveryLeaseExpiresAt: new Date(Date.now() + 60_000),
    },
    // Missing lease expiry is malformed and must fail closed instead of
    // treating a potentially live writer as expired.
    { principalLeaseToken: 'malformed-principal-lease' },
  ])('waits for every active runtime writer lease: %j', async (lease) => {
    mocks.bindingFindOneAndUpdate.mockResolvedValueOnce(binding(lease))
    await expect(revokeRuntimeBinding(revocation(true))).rejects.toThrow(/waiting/)
    expect(mocks.purgePrincipal).not.toHaveBeenCalled()
  })

  it('is idempotent when runtime objects and rows are already absent', async () => {
    mocks.tombstoneFindOne.mockReturnValue(
      leanQuery({ purgePersonalData: true, purgeStatus: 'pending' }),
    )
    mocks.sessionFind.mockReturnValue(selectedLeanQuery([]))
    mocks.userFindOne.mockReturnValue(selectedLeanQuery(null))
    mocks.sessionDeleteMany.mockResolvedValue({ acknowledged: true, deletedCount: 0 })
    mocks.userDelete.mockResolvedValue({ acknowledged: true, deletedCount: 0 })

    await expect(revokeRuntimeBinding(revocation(false))).resolves.toEqual({
      outcome: 'already-revoked',
    })
    expect(mocks.purgePrincipal).toHaveBeenCalledOnce()
    expect(mocks.tombstoneUpdate.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: { purgeStatus: 'completed' },
    })
  })

  it('completes a privacy tombstone when provisioning never occurred', async () => {
    mocks.bindingFindOneAndUpdate.mockResolvedValueOnce(null)
    await expect(revokeRuntimeBinding(revocation(true))).resolves.toEqual({
      outcome: 'not-provisioned',
    })
    expect(mocks.purgePrincipal).not.toHaveBeenCalled()
    expect(mocks.tombstoneUpdate.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: { purgeStatus: 'completed' },
    })
  })
})
