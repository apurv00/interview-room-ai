import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  verifyRoundToken: vi.fn(),
  attemptFindOne: vi.fn(),
  consentFindOne: vi.fn(),
  jobFindOne: vi.fn(),
  workspaceFindOne: vi.fn(),
  obfuscateHireEmail: vi.fn(),
}))

vi.mock('@shared/middleware/checkRateLimit', () => ({
  checkRateLimit: mocks.checkRateLimit,
}))
vi.mock('@hire/services/aiRoundService', () => ({
  verifyRoundToken: mocks.verifyRoundToken,
}))
vi.mock('@hire/models/HireInterviewAttempt', () => ({
  HireInterviewAttempt: { findOne: mocks.attemptFindOne },
}))
vi.mock('@hire/models/HireConsentReceipt', () => ({
  HireConsentReceipt: { findOne: mocks.consentFindOne },
}))
vi.mock('@hire/models/HireJob', () => ({
  HireJob: { findOne: mocks.jobFindOne },
}))
vi.mock('@hire/models/HireWorkspace', () => ({
  HireWorkspace: { findOne: mocks.workspaceFindOne },
}))
vi.mock('@hire/services/privacyService', () => ({
  obfuscateHireEmail: mocks.obfuscateHireEmail,
}))

import { POST } from '../bootstrap/route'
import {
  HIRE_AI_CONSENT_VERSION,
  HIRE_AI_DISCLOSURE_DIGEST,
  HIRE_AI_V2_CONSENT_VERSION,
  HIRE_AI_V2_DISCLOSURE_DIGEST,
  HIRE_AI_V3_CONSENT_VERSION,
  HIRE_AI_V3_DISCLOSURE_DIGEST,
  HIRE_AI_V4_CONSENT_VERSION,
  HIRE_AI_V4_DISCLOSURE_DIGEST,
  HIRE_AI_V5_CONSENT_VERSION,
  HIRE_AI_V5_DISCLOSURE_DIGEST,
} from '@hire/policies/aiInterviewConsent'

const ROUND_ID = '555555555555555555555555'
const IDS = {
  workspaceId: '111111111111111111111111',
  applicationId: '222222222222222222222222',
  jobId: '333333333333333333333333',
  candidateId: '444444444444444444444444',
  roundId: ROUND_ID,
  attemptId: '666666666666666666666666',
  receiptId: '777777777777777777777777',
}

function selected(value: unknown) {
  return {
    select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(value) }),
  }
}

function request() {
  return new NextRequest(`http://localhost/api/candidate/${ROUND_ID}/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      capability: `${IDS.workspaceId}.${'ab'.repeat(32)}`,
    }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.checkRateLimit.mockResolvedValue(null)
  mocks.verifyRoundToken.mockResolvedValue({
    state: 'ok',
    round: {
      _id: IDS.roundId,
      workspaceId: IDS.workspaceId,
      applicationId: IDS.applicationId,
      jobId: IDS.jobId,
      candidateId: IDS.candidateId,
      candidateEmail: 'candidate@example.com',
      config: { duration: 30 },
      authMode: 'magic_link',
      consentAt: new Date('2026-08-10T00:00:00.000Z'),
      consentVersion: HIRE_AI_V2_CONSENT_VERSION,
    },
  })
  mocks.jobFindOne.mockReturnValue(selected({ title: 'Engineer' }))
  mocks.workspaceFindOne.mockReturnValue(selected({ name: 'Example Co' }))
  mocks.attemptFindOne.mockReturnValue(
    selected({ _id: IDS.attemptId, consentReceiptId: IDS.receiptId }),
  )
  mocks.consentFindOne.mockReturnValue(
    selected({
      consentVersion: HIRE_AI_V2_CONSENT_VERSION,
      disclosureDigest: HIRE_AI_V2_DISCLOSURE_DIGEST,
    }),
  )
  mocks.obfuscateHireEmail.mockReturnValue('c***@example.com')
})

describe('POST /api/candidate/[roundId]/bootstrap legacy consent mode', () => {
  it('exposes legacy continuation for the exact active V2 receipt pair', async () => {
    const response = await POST(request(), {
      params: Promise.resolve({ roundId: ROUND_ID }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      state: 'ok',
      legacyConsentAttempt: true,
    })
    expect(mocks.consentFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: IDS.receiptId,
        attemptId: IDS.attemptId,
        'accepted.recording': true,
        'accepted.identityPhoto': true,
        'accepted.attentionMonitoring': true,
        'accepted.aiEvaluation': true,
      }),
    )
  })

  it('exposes legacy continuation for the exact active V3 receipt pair', async () => {
    mocks.verifyRoundToken.mockResolvedValueOnce({
      state: 'ok',
      round: {
        _id: IDS.roundId,
        workspaceId: IDS.workspaceId,
        applicationId: IDS.applicationId,
        jobId: IDS.jobId,
        candidateId: IDS.candidateId,
        candidateEmail: 'candidate@example.com',
        config: { duration: 30 },
        authMode: 'magic_link',
        consentAt: new Date('2026-08-10T00:00:00.000Z'),
        consentVersion: HIRE_AI_V3_CONSENT_VERSION,
      },
    })
    mocks.consentFindOne.mockReturnValueOnce(
      selected({
        consentVersion: HIRE_AI_V3_CONSENT_VERSION,
        disclosureDigest: HIRE_AI_V3_DISCLOSURE_DIGEST,
      }),
    )

    const response = await POST(request(), {
      params: Promise.resolve({ roundId: ROUND_ID }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      state: 'ok',
      legacyConsentAttempt: true,
    })
  })

  it('exposes legacy continuation for the exact active V4 receipt pair', async () => {
    mocks.verifyRoundToken.mockResolvedValueOnce({
      state: 'ok',
      round: {
        _id: IDS.roundId,
        workspaceId: IDS.workspaceId,
        applicationId: IDS.applicationId,
        jobId: IDS.jobId,
        candidateId: IDS.candidateId,
        candidateEmail: 'candidate@example.com',
        config: { duration: 30 },
        authMode: 'magic_link',
        consentAt: new Date('2026-08-10T00:00:00.000Z'),
        consentVersion: HIRE_AI_V4_CONSENT_VERSION,
      },
    })
    mocks.consentFindOne.mockReturnValueOnce(
      selected({
        consentVersion: HIRE_AI_V4_CONSENT_VERSION,
        disclosureDigest: HIRE_AI_V4_DISCLOSURE_DIGEST,
      }),
    )

    const response = await POST(request(), {
      params: Promise.resolve({ roundId: ROUND_ID }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      state: 'ok',
      legacyConsentAttempt: true,
    })
  })

  it('exposes legacy continuation for the exact active V5 receipt pair', async () => {
    mocks.verifyRoundToken.mockResolvedValueOnce({
      state: 'ok',
      round: {
        _id: IDS.roundId,
        workspaceId: IDS.workspaceId,
        applicationId: IDS.applicationId,
        jobId: IDS.jobId,
        candidateId: IDS.candidateId,
        candidateEmail: 'candidate@example.com',
        config: { duration: 30 },
        authMode: 'magic_link',
        consentAt: new Date('2026-08-10T00:00:00.000Z'),
        consentVersion: HIRE_AI_V5_CONSENT_VERSION,
      },
    })
    mocks.consentFindOne.mockReturnValueOnce(
      selected({
        consentVersion: HIRE_AI_V5_CONSENT_VERSION,
        disclosureDigest: HIRE_AI_V5_DISCLOSURE_DIGEST,
      }),
    )

    const response = await POST(request(), {
      params: Promise.resolve({ roundId: ROUND_ID }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      state: 'ok',
      legacyConsentAttempt: true,
    })
  })

  it('keeps a current V6 receipt on the normal V6 consent path', async () => {
    mocks.verifyRoundToken.mockResolvedValueOnce({
      state: 'ok',
      round: {
        _id: IDS.roundId,
        workspaceId: IDS.workspaceId,
        applicationId: IDS.applicationId,
        jobId: IDS.jobId,
        candidateId: IDS.candidateId,
        candidateEmail: 'candidate@example.com',
        config: { duration: 30 },
        authMode: 'magic_link',
        consentAt: new Date('2026-08-10T00:00:00.000Z'),
        consentVersion: HIRE_AI_CONSENT_VERSION,
      },
    })
    mocks.consentFindOne.mockReturnValueOnce(
      selected({
        consentVersion: HIRE_AI_CONSENT_VERSION,
        disclosureDigest: HIRE_AI_DISCLOSURE_DIGEST,
      }),
    )

    const response = await POST(request(), {
      params: Promise.resolve({ roundId: ROUND_ID }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      state: 'ok',
      legacyConsentAttempt: false,
    })
    expect(mocks.attemptFindOne).not.toHaveBeenCalled()
  })

  it('does not expose legacy continuation for a V2 version paired with a changed digest', async () => {
    mocks.consentFindOne.mockReturnValueOnce(
      selected({
        consentVersion: HIRE_AI_V2_CONSENT_VERSION,
        disclosureDigest: 'f'.repeat(64),
      }),
    )

    const response = await POST(request(), {
      params: Promise.resolve({ roundId: ROUND_ID }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      state: 'ok',
      legacyConsentAttempt: false,
    })
  })
})
