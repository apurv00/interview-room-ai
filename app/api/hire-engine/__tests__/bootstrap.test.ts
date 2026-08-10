import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  activeBinding: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@modules/hire-runtime/services/bindingService', async () => {
  const actual = await vi.importActual<
    typeof import('@modules/hire-runtime/services/bindingService')
  >('@modules/hire-runtime/services/bindingService')
  return { ...actual, activeBindingForPrincipal: mocks.activeBinding }
})

import { GET } from '../bootstrap/route'

const PRINCIPAL_ID = '1'.repeat(24)
const ROUND_ID = '2'.repeat(24)
const WORKSPACE_ID = '3'.repeat(24)
const CONFIG = {
  role: 'Backend engineer',
  interviewType: 'behavioral',
  experience: '3-6',
  duration: 20,
  jobDescription: 'Canonical requirement snapshot',
}

function objectId(value: string) {
  return { toString: () => value }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getServerSession.mockResolvedValue({
    user: { id: PRINCIPAL_ID, organizationId: WORKSPACE_ID },
  })
  mocks.activeBinding.mockResolvedValue({
    principalId: objectId(PRINCIPAL_ID),
    roundId: objectId(ROUND_ID),
    config: CONFIG,
    candidateEmail: 'must-not-cross@example.com',
  })
})

describe('GET /api/hire-engine/bootstrap', () => {
  it('returns only pseudonymous owner coordinates and canonical config', async () => {
    const response = await GET()
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({
      principalId: PRINCIPAL_ID,
      roundId: ROUND_ID,
      config: CONFIG,
    })
    expect(JSON.stringify(body)).not.toContain('must-not-cross@example.com')
    expect(mocks.activeBinding).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
    })
  })

  it('does not disclose bootstrap config without the runtime session', async () => {
    mocks.getServerSession.mockResolvedValue(null)
    const response = await GET()
    expect(response.status).toBe(401)
    expect(mocks.activeBinding).not.toHaveBeenCalled()
  })
})
