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
import {
  HIRE_AI_CONSENT_VERSION,
  HIRE_AI_V5_CONSENT_VERSION,
} from '@hire/policies/aiInterviewConsent'

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

function hydratedConfig() {
  return {
    ...CONFIG,
    $isMongooseDocumentPrototype: true,
    toObject: () => CONFIG,
  }
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
    config: hydratedConfig(),
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
    expect(response.headers.get('X-Hire-Multimodal-Observations')).toBeNull()
    expect(response.headers.get('X-Hire-Display-Capture-Required')).toBeNull()
    expect(mocks.activeBinding).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
    })
  })

  it('emits authenticated V6 collection and display-capture markers only for current consent', async () => {
    mocks.activeBinding.mockResolvedValue({
      principalId: objectId(PRINCIPAL_ID),
      roundId: objectId(ROUND_ID),
      config: hydratedConfig(),
      consentVersion: HIRE_AI_CONSENT_VERSION,
    })

    const response = await GET()

    expect(response.status).toBe(200)
    expect(response.headers.get('X-Hire-Multimodal-Observations')).toBe('1')
    expect(response.headers.get('X-Hire-Display-Capture-Required')).toBe('1')
    expect(await response.json()).toEqual({
      principalId: PRINCIPAL_ID,
      roundId: ROUND_ID,
      config: CONFIG,
    })
  })

  it('keeps V5 observation collection enabled without requesting V6 display capture', async () => {
    mocks.activeBinding.mockResolvedValue({
      principalId: objectId(PRINCIPAL_ID),
      roundId: objectId(ROUND_ID),
      config: hydratedConfig(),
      consentVersion: HIRE_AI_V5_CONSENT_VERSION,
    })

    const response = await GET()

    expect(response.status).toBe(200)
    expect(response.headers.get('X-Hire-Multimodal-Observations')).toBe('1')
    expect(response.headers.get('X-Hire-Display-Capture-Required')).toBeNull()
  })

  it('does not disclose bootstrap config without the runtime session', async () => {
    mocks.getServerSession.mockResolvedValue(null)
    const response = await GET()
    expect(response.status).toBe(401)
    expect(mocks.activeBinding).not.toHaveBeenCalled()
  })
})
