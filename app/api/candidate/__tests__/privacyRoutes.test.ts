import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => {
  class PrivacyError extends Error {
    constructor(
      message: string,
      readonly code: string,
      readonly status: number,
    ) {
      super(message)
      this.name = 'HirePrivacyError'
    }
  }
  return {
    PrivacyError,
    createRequest: vi.fn(),
    getTarget: vi.fn(),
    applyRequest: vi.fn(),
    issueOtp: vi.fn(),
    verifyOtp: vi.fn(),
    sendEmail: vi.fn(),
    checkRateLimit: vi.fn(),
  }
})

vi.mock('@hire/services/privacyService', () => ({
  HirePrivacyError: mocks.PrivacyError,
  PRIVACY_VERIFICATION_TTL_MS: 10 * 60 * 1000,
  createHirePrivacyRequestFromInvite: mocks.createRequest,
  getHirePrivacyVerificationTarget: mocks.getTarget,
  applyVerifiedHirePrivacyRequest: mocks.applyRequest,
}))
vi.mock('@shared/auth/mailboxOtp', () => ({
  issueOtp: mocks.issueOtp,
  verifyOtp: mocks.verifyOtp,
}))
vi.mock('@shared/services/emailService', () => ({
  sendEmail: mocks.sendEmail,
}))
vi.mock('@shared/middleware/checkRateLimit', () => ({
  checkRateLimit: mocks.checkRateLimit,
}))

import { POST as requestPrivacy } from '../[roundId]/privacy/request/route'
import { POST as verifyPrivacy } from '../privacy/verify/route'

const ROUND_ID = 'a'.repeat(24)
const REQUEST_ID = 'b'.repeat(24)
const WORKSPACE_ID = '1'.repeat(24)
const TOKEN = 'cd'.repeat(32)
const INVITE_CAPABILITY = `${WORKSPACE_ID}.${TOKEN}`
const REQUEST_CAPABILITY = `${WORKSPACE_ID}.${REQUEST_ID}.${'e'.repeat(64)}`
const EMAIL = 'candidate@example.com'

function post(url: string, body: Record<string, unknown>) {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.checkRateLimit.mockResolvedValue(null)
  mocks.createRequest.mockResolvedValue({
    request: {
      _id: { toString: () => REQUEST_ID },
      workspaceId: { toString: () => WORKSPACE_ID },
      verificationExpiresAt: new Date('2026-08-10T12:10:00.000Z'),
    },
    requestCapability: REQUEST_CAPABILITY,
    email: EMAIL,
    emailHint: 'c***@example.com',
  })
  mocks.issueOtp.mockResolvedValue({ code: '123456' })
  mocks.sendEmail.mockResolvedValue({ ok: true })
  mocks.getTarget.mockResolvedValue({
    request: {
      _id: { toString: () => REQUEST_ID },
      workspaceId: { toString: () => WORKSPACE_ID },
    },
    email: EMAIL,
  })
  mocks.verifyOtp.mockResolvedValue({ ok: true })
  mocks.applyRequest.mockResolvedValue({ workspaceId: 'w1', candidateId: 'c1' })
})

describe('candidate privacy APIs', () => {
  it('starts verification from the invite credential without checking live invite state', async () => {
    const response = await requestPrivacy(
      post(`http://localhost/api/candidate/${ROUND_ID}/privacy/request`, {
        capability: INVITE_CAPABILITY,
      }),
      { params: { roundId: ROUND_ID } },
    )

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({
      requestCapability: REQUEST_CAPABILITY,
      emailHint: 'c***@example.com',
    })
    expect(mocks.createRequest).toHaveBeenCalledWith({
      roundId: ROUND_ID,
      inviteCapability: INVITE_CAPABILITY,
    })
    expect(mocks.issueOtp).toHaveBeenCalledWith(
      `hire-privacy:${WORKSPACE_ID}:${REQUEST_ID}`,
      EMAIL,
    )
    expect(mocks.sendEmail.mock.calls[0][0]).toMatchObject({ to: EMAIL })
  })

  it('verifies the mailbox code before applying deletion', async () => {
    const response = await verifyPrivacy(
      post('http://localhost/api/candidate/privacy/verify', {
        requestCapability: REQUEST_CAPABILITY,
        code: '123456',
      }),
    )

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ accepted: true, status: 'processing' })
    expect(mocks.verifyOtp).toHaveBeenCalledWith(
      `hire-privacy:${WORKSPACE_ID}:${REQUEST_ID}`,
      EMAIL,
      '123456',
    )
    expect(mocks.applyRequest).toHaveBeenCalledWith({
      requestCapability: REQUEST_CAPABILITY,
    })
  })

  it('never applies deletion for a wrong or expired code', async () => {
    mocks.verifyOtp.mockResolvedValue({ ok: false, reason: 'mismatch' })

    const response = await verifyPrivacy(
      post('http://localhost/api/candidate/privacy/verify', {
        requestCapability: REQUEST_CAPABILITY,
        code: '000000',
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'OTP_INVALID' })
    expect(mocks.applyRequest).not.toHaveBeenCalled()
  })

  it('maps an invalid original invite to the generic deletion-link response', async () => {
    mocks.createRequest.mockRejectedValue(
      new mocks.PrivacyError('This privacy request link is invalid', 'PRIVACY_LINK_INVALID', 410),
    )

    const response = await requestPrivacy(
      post(`http://localhost/api/candidate/${ROUND_ID}/privacy/request`, {
        capability: INVITE_CAPABILITY,
      }),
      { params: { roundId: ROUND_ID } },
    )

    expect(response.status).toBe(410)
    expect(await response.json()).toMatchObject({ code: 'PRIVACY_LINK_INVALID' })
    expect(mocks.issueOtp).not.toHaveBeenCalled()
  })

  it('has no B2C User dependency in either API or the Hire privacy service', () => {
    const files = [
      'app/api/candidate/[roundId]/privacy/request/route.ts',
      'app/api/candidate/privacy/verify/route.ts',
      'modules/hire/services/privacyService.ts',
    ]
    for (const file of files) {
      const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8')
      expect(source).not.toContain('@shared/db/models')
      expect(source).not.toMatch(/\bUser\s*\.(?:find|findOne|exists|create|update)/)
    }
  })
})
