import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  roundFindOne: vi.fn(),
  candidateFindOne: vi.fn(),
  privacyFindOneAndUpdate: vi.fn(),
  privacyFindOne: vi.fn(),
}))

vi.mock('../services/hireControlBoundary', () => ({
  connectHireControlDB: mocks.connect,
}))
vi.mock('../models/HireRound', () => ({
  HireRound: { findOne: mocks.roundFindOne, updateMany: vi.fn(), find: vi.fn() },
}))
vi.mock('../models/HireCandidate', () => ({
  HireCandidate: { findOne: mocks.candidateFindOne, updateOne: vi.fn() },
}))
vi.mock('../models/HirePrivacyRequest', () => ({
  HirePrivacyRequest: {
    findOneAndUpdate: mocks.privacyFindOneAndUpdate,
    findOne: mocks.privacyFindOne,
    create: vi.fn(),
  },
}))
vi.mock('../models/HireApplication', () => ({ HireApplication: { updateMany: vi.fn() } }))
vi.mock('../models/HireEngineHandoff', () => ({ HireEngineHandoff: { updateMany: vi.fn() } }))
vi.mock('../models/HireGuestSession', () => ({ HireGuestSession: { updateMany: vi.fn() } }))
vi.mock('../models/HireInterviewAttempt', () => ({ HireInterviewAttempt: { updateMany: vi.fn() } }))
vi.mock('../models/HireInterviewResult', () => ({ HireInterviewResult: { updateMany: vi.fn() } }))
vi.mock('../models/HireMediaAsset', () => ({ HireMediaAsset: { updateMany: vi.fn() } }))
vi.mock('../services/engineRevocationService', () => ({
  deliverRuntimeRevocation: vi.fn(),
}))

import {
  __privacy,
  createHirePrivacyRequestFromInvite,
  getHirePrivacyVerificationTarget,
} from '../services/privacyService'

const IDS = {
  workspace: '1'.repeat(24),
  candidate: '2'.repeat(24),
  round: '3'.repeat(24),
  request: '4'.repeat(24),
}
const INVITE_SECRET = 'a'.repeat(64)
const EMAIL = 'candidate@example.com'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.roundFindOne.mockReturnValue({
    lean: vi.fn().mockResolvedValue({
      _id: IDS.round,
      workspaceId: IDS.workspace,
      candidateId: IDS.candidate,
    }),
  })
  mocks.candidateFindOne.mockReturnValue({
    select: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: IDS.candidate,
        workspaceId: IDS.workspace,
        email: EMAIL,
      }),
    }),
  })
  mocks.privacyFindOneAndUpdate.mockResolvedValue({
    _id: IDS.request,
    workspaceId: IDS.workspace,
    candidateId: IDS.candidate,
    status: 'pending_verification',
  })
})

describe('privacy capability tenant scope', () => {
  it('uses the authenticated workspace coordinate in the very first invite lookup', async () => {
    const result = await createHirePrivacyRequestFromInvite({
      roundId: IDS.round,
      inviteCapability: `${IDS.workspace}.${INVITE_SECRET}`,
    })

    expect(mocks.roundFindOne).toHaveBeenCalledWith({
      _id: IDS.round,
      workspaceId: IDS.workspace,
      inviteTokenHash: __privacy.digest(INVITE_SECRET),
    })
    expect(mocks.privacyFindOneAndUpdate.mock.calls[0][0]).toMatchObject({
      workspaceId: IDS.workspace,
      candidateId: IDS.candidate,
    })
    expect(result.requestCapability).toMatch(
      new RegExp(`^${IDS.workspace}\\.${IDS.request}\\.[a-f0-9]{64}$`),
    )
  })

  it('scopes the verification-request lookup before resolving candidate email', async () => {
    const secret = 'b'.repeat(64)
    mocks.privacyFindOne.mockResolvedValue({
      _id: IDS.request,
      workspaceId: IDS.workspace,
      candidateId: IDS.candidate,
      verificationEmailHash: __privacy.digest(EMAIL),
    })

    await getHirePrivacyVerificationTarget({
      requestCapability: `${IDS.workspace}.${IDS.request}.${secret}`,
    })

    expect(mocks.privacyFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: IDS.request,
        workspaceId: IDS.workspace,
        verificationCapabilityHash: __privacy.digest(secret),
      }),
    )
    expect(mocks.candidateFindOne).toHaveBeenCalledWith({
      _id: IDS.candidate,
      workspaceId: IDS.workspace,
    })
  })
})
