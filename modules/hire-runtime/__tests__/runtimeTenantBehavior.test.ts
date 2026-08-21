import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  findOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
}))

vi.mock('../services/runtimeBoundary', () => ({
  connectHireRuntimeDB: mocks.connect,
}))
vi.mock('../models/HireRuntimeBinding', () => ({
  HireRuntimeBinding: {
    findOne: mocks.findOne,
    findOneAndUpdate: mocks.findOneAndUpdate,
  },
}))
vi.mock('../models/HireRuntimeRevocation', () => ({
  HireRuntimeRevocation: {},
}))
vi.mock('@shared/db/models/InterviewSession', () => ({ InterviewSession: {} }))
vi.mock('@shared/db/models/User', () => ({ User: {} }))

import {
  activeBindingForPrincipal,
  completionBoundaryForPrincipal,
  completionBindingForPrincipal,
} from '../services/bindingService'
import { claimRuntimeWriteCapability } from '../services/runtimeWriteFence'

const WORKSPACE_A = 'a'.repeat(24)
const WORKSPACE_B = 'b'.repeat(24)
const PRINCIPAL_ID = 'c'.repeat(24)
const bindingA = {
  _id: { toString: () => 'd'.repeat(24) },
  workspaceId: { toString: () => WORKSPACE_A },
  principalId: { toString: () => PRINCIPAL_ID },
}

function bindingQuery(value: unknown) {
  const promise = Promise.resolve(value)
  const query = {
    select: vi.fn(),
    lean: vi.fn().mockResolvedValue(value),
    then: promise.then.bind(promise),
  }
  query.select.mockReturnValue(query)
  return query
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.findOne.mockImplementation((filter) =>
    bindingQuery(filter.workspaceId === WORKSPACE_A ? bindingA : null),
  )
  mocks.findOneAndUpdate.mockImplementation(async (filter) =>
    filter.workspaceId === WORKSPACE_A ? bindingA : null,
  )
})

describe('isolated runtime two-tenant behavior', () => {
  it('does not resolve a principal through another workspace read scope', async () => {
    await expect(activeBindingForPrincipal({
      workspaceId: WORKSPACE_A,
      principalId: PRINCIPAL_ID,
    })).resolves.toBe(bindingA)
    await expect(activeBindingForPrincipal({
      workspaceId: WORKSPACE_B,
      principalId: PRINCIPAL_ID,
    })).rejects.toMatchObject({ code: 'not_found', status: 404 })

    expect(mocks.findOne.mock.calls.map(([filter]) => filter.workspaceId)).toEqual([
      WORKSPACE_A,
      WORKSPACE_B,
    ])
  })

  it('does not grant a write capability through another workspace scope', async () => {
    await expect(claimRuntimeWriteCapability({
      workspaceId: WORKSPACE_A,
      principalId: PRINCIPAL_ID,
      pathname: '/api/generate-feedback',
      method: 'POST',
    })).resolves.toBe(bindingA)
    await expect(claimRuntimeWriteCapability({
      workspaceId: WORKSPACE_B,
      principalId: PRINCIPAL_ID,
      pathname: '/api/generate-feedback',
      method: 'POST',
    })).rejects.toMatchObject({ status: 410 })

    expect(
      mocks.findOneAndUpdate.mock.calls.map(([filter]) => filter.workspaceId),
    ).toEqual([WORKSPACE_A, WORKSPACE_B])
  })

  it('checks completion in the exact workspace without reapplying invite expiry', async () => {
    await expect(completionBindingForPrincipal({
      workspaceId: WORKSPACE_A,
      principalId: PRINCIPAL_ID,
    })).resolves.toBe(bindingA)

    expect(mocks.findOne).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_A,
      principalId: PRINCIPAL_ID,
      runtimeSessionId: { $exists: true },
      status: { $in: ['active', 'completed'] },
      revokedAt: { $exists: false },
      purgePersonalData: { $ne: true },
    })
    expect(mocks.findOne.mock.calls[0][0]).not.toHaveProperty('inviteExpiresAt')
  })

  it.each([
    ['revoked', { ...bindingA, status: 'revoked', revokedAt: new Date() }],
    [
      'purging',
      {
        ...bindingA,
        status: 'revoked',
        purgePersonalData: true,
        runtimeSessionId: undefined,
      },
    ],
  ] as const)('returns a completion-only %s privacy boundary', async (reason, binding) => {
    mocks.findOne.mockResolvedValueOnce(binding)

    await expect(completionBoundaryForPrincipal({
      workspaceId: WORKSPACE_A,
      principalId: PRINCIPAL_ID,
    })).resolves.toEqual({ state: 'account_unavailable', reason })

    expect(mocks.findOne).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_A,
      principalId: PRINCIPAL_ID,
    })
  })
})
