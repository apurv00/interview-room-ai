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

import { activeBindingForPrincipal } from '../services/bindingService'
import { claimRuntimeWriteCapability } from '../services/runtimeWriteFence'

const WORKSPACE_A = 'a'.repeat(24)
const WORKSPACE_B = 'b'.repeat(24)
const PRINCIPAL_ID = 'c'.repeat(24)
const bindingA = {
  _id: { toString: () => 'd'.repeat(24) },
  workspaceId: { toString: () => WORKSPACE_A },
  principalId: { toString: () => PRINCIPAL_ID },
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.findOne.mockImplementation(async (filter) =>
    filter.workspaceId === WORKSPACE_A ? bindingA : null,
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
})
