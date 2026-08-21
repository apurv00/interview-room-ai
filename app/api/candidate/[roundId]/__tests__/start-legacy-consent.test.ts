import { NextRequest, NextResponse } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  requireHireGuest: vi.fn(),
  hireGuestErrorResponse: vi.fn(),
  startHireInterviewAttempt: vi.fn(),
  issueHireEngineHandoff: vi.fn(),
  roundFindOne: vi.fn(),
  roundUpdateOne: vi.fn(),
  workspaceFindOne: vi.fn(),
}))

vi.mock('@shared/middleware/checkRateLimit', () => ({
  checkRateLimit: mocks.checkRateLimit,
}))
vi.mock('@hire/services/identityMediaService', () => ({
  startHireInterviewAttempt: mocks.startHireInterviewAttempt,
}))
vi.mock('@hire/services/engineHandoffService', () => ({
  issueHireEngineHandoff: mocks.issueHireEngineHandoff,
}))
vi.mock('@hire/models/HireRound', () => ({
  HireRound: {
    findOne: mocks.roundFindOne,
    updateOne: mocks.roundUpdateOne,
  },
}))
vi.mock('@hire/models/HireWorkspace', () => ({
  HireWorkspace: { findOne: mocks.workspaceFindOne },
}))
vi.mock('../../_lib/hireGuestHttp', () => ({
  requireHireGuest: mocks.requireHireGuest,
  hireGuestErrorResponse: mocks.hireGuestErrorResponse,
}))

import { POST } from '../start/route'
import {
  HIRE_AI_CONSENT_VERSION,
  HIRE_AI_V2_CONSENT_VERSION,
  HIRE_AI_V2_DISCLOSURE_DIGEST,
} from '@hire/policies/aiInterviewConsent'

const SCOPE = {
  sessionId: '999999999999999999999999',
  workspaceId: '111111111111111111111111',
  applicationId: '222222222222222222222222',
  jobId: '333333333333333333333333',
  candidateId: '444444444444444444444444',
  roundId: '555555555555555555555555',
  attemptId: '666666666666666666666666',
  expiresAt: new Date('2026-08-20T00:00:00.000Z'),
}
const CONSENT_AT = new Date('2026-08-10T00:00:00.000Z')

function selected(value: unknown) {
  return {
    select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(value) }),
  }
}

function request(headers?: Record<string, string>) {
  return new NextRequest(`http://localhost/api/candidate/${SCOPE.roundId}/start`, {
    method: 'POST',
    headers,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.checkRateLimit.mockResolvedValue(null)
  mocks.requireHireGuest.mockResolvedValue(SCOPE)
  mocks.hireGuestErrorResponse.mockImplementation(() =>
    NextResponse.json({ error: 'unexpected' }, { status: 500 }),
  )
  mocks.startHireInterviewAttempt.mockResolvedValue({
    attemptId: SCOPE.attemptId,
    recordingEpoch: new Date('2026-08-10T00:01:00.000Z'),
    consent: {
      consentVersion: HIRE_AI_V2_CONSENT_VERSION,
      disclosureDigest: HIRE_AI_V2_DISCLOSURE_DIGEST,
      acceptedAt: CONSENT_AT,
    },
  })
  mocks.roundFindOne.mockReturnValue(
    selected({
      config: {
        role: 'Engineer',
        interviewType: 'technical',
        experience: '3-6',
        duration: 30,
      },
      jdSnapshot: 'Job description',
      consentVersion: HIRE_AI_V2_CONSENT_VERSION,
      consentAt: CONSENT_AT,
      inviteTokenExpiry: new Date('2026-08-19T00:00:00.000Z'),
    }),
  )
  mocks.workspaceFindOne.mockReturnValue(selected({ name: 'Example Co' }))
  mocks.issueHireEngineHandoff.mockResolvedValue({
    handoffUrl: 'https://runtime.example/handoff#code=opaque',
    expiresAt: new Date('2026-08-10T00:02:00.000Z'),
  })
  mocks.roundUpdateOne.mockResolvedValue({ matchedCount: 1 })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('POST /api/candidate/[roundId]/start legacy consent', () => {
  it('blocks before attempt creation while issuance is draining', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('HIRE_HANDOFF_ISSUANCE_MODE', 'draining')

    const response = await POST(request(), { params: { roundId: SCOPE.roundId } })

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('30')
    expect(await response.json()).toMatchObject({ code: 'HANDOFF_ISSUANCE_PAUSED' })
    expect(mocks.checkRateLimit).not.toHaveBeenCalled()
    expect(mocks.requireHireGuest).not.toHaveBeenCalled()
    expect(mocks.startHireInterviewAttempt).not.toHaveBeenCalled()
    expect(mocks.issueHireEngineHandoff).not.toHaveBeenCalled()
  })

  it('keeps public issuance blocked in smoke mode and permits only the operator path', async () => {
    const token = 's'.repeat(64)
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('HIRE_HANDOFF_ISSUANCE_MODE', 'smoke')
    vi.stubEnv('HIRE_HANDOFF_SMOKE_TOKEN', token)

    const publicResponse = await POST(request(), { params: { roundId: SCOPE.roundId } })
    expect(publicResponse.status).toBe(503)
    expect(mocks.startHireInterviewAttempt).not.toHaveBeenCalled()

    const smokeResponse = await POST(
      request({ 'x-hire-handoff-smoke-token': token }),
      { params: { roundId: SCOPE.roundId } },
    )
    expect(smokeResponse.status).toBe(200)
    expect(mocks.startHireInterviewAttempt).toHaveBeenCalledOnce()
    expect(mocks.issueHireEngineHandoff).toHaveBeenCalledOnce()
  })

  it('issues a handoff from the active v2 attempt receipt rather than upgrading it to v3', async () => {
    const response = await POST(request(), { params: { roundId: SCOPE.roundId } })

    expect(response.status).toBe(200)
    expect(mocks.issueHireEngineHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: SCOPE.workspaceId,
        applicationId: SCOPE.applicationId,
        roundId: SCOPE.roundId,
        consentVersion: HIRE_AI_V2_CONSENT_VERSION,
        consentAt: CONSENT_AT,
      }),
    )
    expect(await response.json()).toMatchObject({ attemptId: SCOPE.attemptId })
  })

  it('fails closed when the mutable round no longer matches the attempt receipt', async () => {
    mocks.roundFindOne.mockReturnValueOnce(
      selected({
        config: {
          role: 'Engineer',
          interviewType: 'technical',
          experience: '3-6',
          duration: 30,
        },
        jdSnapshot: 'Job description',
        consentVersion: HIRE_AI_CONSENT_VERSION,
        consentAt: CONSENT_AT,
        inviteTokenExpiry: new Date('2026-08-19T00:00:00.000Z'),
      }),
    )

    const response = await POST(request(), { params: { roundId: SCOPE.roundId } })

    expect(response.status).toBe(409)
    expect(mocks.issueHireEngineHandoff).not.toHaveBeenCalled()
  })
})
