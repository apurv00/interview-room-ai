import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  bindingFindOne: vi.fn(),
  bindingUpdate: vi.fn(),
  sessionDelete: vi.fn(),
  userDelete: vi.fn(),
}))

vi.mock('../services/runtimeBoundary', () => ({
  connectHireRuntimeDB: mocks.connect,
}))
vi.mock('../models/HireRuntimeBinding', () => ({
  HireRuntimeBinding: {
    findOne: mocks.bindingFindOne,
    updateOne: mocks.bindingUpdate,
  },
}))
vi.mock('../models/HireRuntimeRevocation', () => ({
  HireRuntimeRevocation: {},
}))
vi.mock('@shared/db/models/InterviewSession', () => ({
  InterviewSession: { deleteOne: mocks.sessionDelete },
}))
vi.mock('@shared/db/models/User', () => ({
  User: { deleteOne: mocks.userDelete },
}))

import { attachRuntimeSessionAfterRevocation } from '../services/bindingService'

const BINDING_ID = 'a'.repeat(24)
const ROUND_ID = 'b'.repeat(24)
const PRINCIPAL_ID = 'c'.repeat(24)
const SESSION_ID = 'd'.repeat(24)
const WORKSPACE_ID = 'e'.repeat(24)

function objectId(value: string) {
  return { toString: () => value }
}

function selected(value: unknown) {
  return { select: () => ({ lean: async () => value }) }
}

const privacyBinding = {
  principalId: objectId(PRINCIPAL_ID),
  roundId: objectId(ROUND_ID),
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.sessionDelete.mockResolvedValue({ acknowledged: true, deletedCount: 1 })
  mocks.userDelete.mockResolvedValue({ acknowledged: true, deletedCount: 1 })
})

describe('session create versus privacy revocation race', () => {
  it('discards a late engine session and pseudonymous user instead of attaching it', async () => {
    mocks.bindingFindOne.mockReturnValue(selected(privacyBinding))

    await expect(
      attachRuntimeSessionAfterRevocation({
        workspaceId: WORKSPACE_ID,
        bindingId: BINDING_ID,
        runtimeSessionId: SESSION_ID,
      }),
    ).resolves.toBe(false)

    expect(mocks.bindingUpdate).not.toHaveBeenCalled()
    expect(mocks.sessionDelete).toHaveBeenCalledWith({
      _id: SESSION_ID,
      userId: privacyBinding.principalId,
      organizationId: WORKSPACE_ID,
    })
    expect(mocks.userDelete).toHaveBeenCalledWith({
      _id: privacyBinding.principalId,
      email: `round-${ROUND_ID}@guests.interviewprep.internal`,
      organizationId: WORKSPACE_ID,
    })
  })

  it('closes the flag-change race when privacy purge starts during fallback attach', async () => {
    mocks.bindingFindOne
      .mockReturnValueOnce(selected(null))
      .mockReturnValueOnce(selected(privacyBinding))
    mocks.bindingUpdate.mockResolvedValue({ acknowledged: true, matchedCount: 0 })

    await expect(
      attachRuntimeSessionAfterRevocation({
        workspaceId: WORKSPACE_ID,
        bindingId: BINDING_ID,
        runtimeSessionId: SESSION_ID,
      }),
    ).resolves.toBe(false)
    expect(mocks.sessionDelete).toHaveBeenCalledOnce()
    expect(mocks.userDelete).toHaveBeenCalledOnce()
  })

  it('retains the audit session for an ordinary non-privacy revocation', async () => {
    mocks.bindingFindOne.mockReturnValue(selected(null))
    mocks.bindingUpdate.mockResolvedValue({ acknowledged: true, matchedCount: 1 })

    await expect(
      attachRuntimeSessionAfterRevocation({
        workspaceId: WORKSPACE_ID,
        bindingId: BINDING_ID,
        runtimeSessionId: SESSION_ID,
      }),
    ).resolves.toBe(true)
    expect(mocks.sessionDelete).not.toHaveBeenCalled()
    expect(mocks.userDelete).not.toHaveBeenCalled()
  })
})
