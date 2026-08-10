import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  completionBinding: vi.fn(),
  interviewFindOne: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@modules/hire-runtime/services/bindingService', async () => {
  const actual = await vi.importActual<
    typeof import('@modules/hire-runtime/services/bindingService')
  >('@modules/hire-runtime/services/bindingService')
  return { ...actual, completionBindingForPrincipal: mocks.completionBinding }
})
vi.mock('@shared/db/models/InterviewSession', () => ({
  InterviewSession: { findOne: mocks.interviewFindOne },
}))

import { GET } from '../completion-status/route'

const PRINCIPAL_ID = '1'.repeat(24)
const SESSION_ID = '2'.repeat(24)
const WORKSPACE_ID = '3'.repeat(24)

function objectId(value: string) {
  return { toString: () => value }
}

function interviewQuery(result: unknown) {
  const query = {
    select: vi.fn(),
    lean: vi.fn().mockResolvedValue(result),
  }
  query.select.mockReturnValue(query)
  return query
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getServerSession.mockResolvedValue({
    user: { id: PRINCIPAL_ID, organizationId: WORKSPACE_ID },
  })
  mocks.completionBinding.mockResolvedValue({
    principalId: objectId(PRINCIPAL_ID),
    runtimeSessionId: objectId(SESSION_ID),
  })
  mocks.interviewFindOne.mockReturnValue(interviewQuery({
    status: 'completed',
    completedAt: new Date('2026-08-10T10:00:00.000Z'),
  }))
})

describe('GET /api/hire-engine/completion-status', () => {
  it('confirms only the exact workspace-bound principal session', async () => {
    const response = await GET()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({ state: 'completed' })
    expect(mocks.completionBinding).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
    })
    const filter = mocks.interviewFindOne.mock.calls[0][0]
    expect(filter._id.toString()).toBe(SESSION_ID)
    expect(filter.userId.toString()).toBe(PRINCIPAL_ID)
    expect(filter.organizationId).toBe(WORKSPACE_ID)
  })

  it('does not claim submission while the bound engine session is incomplete', async () => {
    mocks.interviewFindOne.mockReturnValue(interviewQuery({ status: 'in_progress' }))
    const response = await GET()
    await expect(response.json()).resolves.toEqual({ state: 'pending' })
  })

  it('treats a missing bound session as pending rather than fabricating completion', async () => {
    mocks.interviewFindOne.mockReturnValue(interviewQuery(null))
    const response = await GET()
    await expect(response.json()).resolves.toEqual({ state: 'pending' })
  })

  it('does not reveal runtime completion without the host-only session', async () => {
    mocks.getServerSession.mockResolvedValue(null)
    const response = await GET()
    expect(response.status).toBe(401)
    expect(mocks.completionBinding).not.toHaveBeenCalled()
    expect(mocks.interviewFindOne).not.toHaveBeenCalled()
  })
})
