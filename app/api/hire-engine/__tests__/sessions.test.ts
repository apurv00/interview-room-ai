import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  acquireLease: vi.fn(),
  attachSession: vi.fn(),
  releaseLease: vi.fn(),
  ensurePrincipal: vi.fn(),
  interviewFindOne: vi.fn(),
  createSession: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@modules/hire-runtime/services/bindingService', async () => {
  const actual = await vi.importActual<
    typeof import('@modules/hire-runtime/services/bindingService')
  >('@modules/hire-runtime/services/bindingService')
  return {
    ...actual,
    acquireSessionProvisioningLease: mocks.acquireLease,
    attachRuntimeSession: mocks.attachSession,
    releaseSessionProvisioningLease: mocks.releaseLease,
  }
})
vi.mock('@modules/hire-runtime/services/runtimePrincipalService', () => ({
  ensureRuntimePrincipal: mocks.ensurePrincipal,
}))
vi.mock('@shared/db/models/InterviewSession', () => ({
  InterviewSession: { findOne: mocks.interviewFindOne },
}))
vi.mock('@interview/services/core/interviewService', () => ({
  createSession: mocks.createSession,
}))

import { POST } from '../sessions/route'

const PRINCIPAL_ID = '1'.repeat(24)
const ROUND_ID = '2'.repeat(24)
const SESSION_ID = '3'.repeat(24)
const BINDING_ID = '4'.repeat(24)
const WORKSPACE_ID = '5'.repeat(24)
const CANONICAL_CONFIG = {
  role: 'Backend engineer',
  interviewType: 'behavioral',
  experience: '3-6' as const,
  duration: 20,
  jobDescription: 'Canonical server-owned JD',
  targetCompany: 'Example Co',
}

function objectId(value: string) {
  return { toString: () => value }
}

function binding(runtimeSessionId?: string) {
  return {
    _id: objectId(BINDING_ID),
    workspaceId: objectId(WORKSPACE_ID),
    principalId: objectId(PRINCIPAL_ID),
    roundId: objectId(ROUND_ID),
    config: CANONICAL_CONFIG,
    createdAt: new Date('2026-08-10T00:00:00.000Z'),
    ...(runtimeSessionId ? { runtimeSessionId: objectId(runtimeSessionId) } : {}),
  }
}

function noOrphanQuery() {
  const query = {
    sort: vi.fn(),
    select: vi.fn(),
    lean: vi.fn().mockResolvedValue(null),
  }
  query.sort.mockReturnValue(query)
  query.select.mockReturnValue(query)
  return query
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getServerSession.mockResolvedValue({
    user: { id: PRINCIPAL_ID, organizationId: WORKSPACE_ID },
  })
  mocks.acquireLease.mockResolvedValue({ binding: binding(), leaseToken: 'a'.repeat(64) })
  mocks.interviewFindOne.mockReturnValue(noOrphanQuery())
  mocks.ensurePrincipal.mockResolvedValue({ _id: objectId(PRINCIPAL_ID) })
  mocks.createSession.mockResolvedValue({ _id: objectId(SESSION_ID) })
  mocks.attachSession.mockResolvedValue({ runtimeSessionId: objectId(SESSION_ID) })
})

describe('POST /api/hire-engine/sessions', () => {
  it('ignores a tampered browser body and provisions only the canonical binding config', async () => {
    const req = new NextRequest('http://engine.test/api/interviews', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'RuntimeTest/1' },
      body: JSON.stringify({
        config: {
          role: 'Attacker-selected role',
          jobDescription: 'Attacker-selected JD',
        },
        candidateEmail: 'candidate@example.com',
        candidateName: 'Candidate Name',
      }),
    })
    const response = await POST(req)
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ sessionId: SESSION_ID })

    expect(mocks.createSession).toHaveBeenCalledWith({
      userId: PRINCIPAL_ID,
      organizationId: WORKSPACE_ID,
      config: CANONICAL_CONFIG,
      jobDescription: CANONICAL_CONFIG.jobDescription,
      userAgent: 'RuntimeTest/1',
    })
    const engineInput = mocks.createSession.mock.calls[0][0]
    expect(engineInput).not.toHaveProperty('candidateEmail')
    expect(engineInput).not.toHaveProperty('candidateName')
    expect(JSON.stringify(engineInput)).not.toContain('candidate@example.com')
    expect(mocks.acquireLease).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
    })
    expect(mocks.interviewFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: WORKSPACE_ID }),
    )
  })

  it('returns the already-bound session idempotently without calling the engine', async () => {
    mocks.acquireLease.mockResolvedValue({ binding: binding(SESSION_ID) })
    const response = await POST(
      new NextRequest('http://engine.test/api/interviews', { method: 'POST' }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ sessionId: SESSION_ID })
    expect(mocks.createSession).not.toHaveBeenCalled()
  })
})
