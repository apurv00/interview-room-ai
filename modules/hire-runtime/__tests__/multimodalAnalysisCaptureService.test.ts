import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HIRE_AI_CONSENT_VERSION } from '@hire/policies/aiInterviewConsent'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  bindingFindOne: vi.fn(),
  bindingUpdateOne: vi.fn(),
  outboxExists: vi.fn(),
  outboxCreate: vi.fn(),
  outboxDeleteMany: vi.fn(),
  sessionExists: vi.fn(),
  sessionUpdateOne: vi.fn(),
  uploadToR2: vi.fn(),
  deleteFromR2: vi.fn(),
  retentionExists: vi.fn(),
}))

vi.mock('../services/runtimeBoundary', () => ({
  connectHireRuntimeDB: mocks.connect,
}))
vi.mock('../models/HireRuntimeBinding', () => ({
  HireRuntimeBinding: {
    findOne: mocks.bindingFindOne,
    updateOne: mocks.bindingUpdateOne,
  },
}))
vi.mock('../models/HireRuntimeMultimodalAnalysisOutbox', () => ({
  HireRuntimeMultimodalAnalysisOutbox: {
    exists: mocks.outboxExists,
    create: mocks.outboxCreate,
    deleteMany: mocks.outboxDeleteMany,
  },
}))
vi.mock('@shared/db/models/InterviewSession', () => ({
  InterviewSession: {
    exists: mocks.sessionExists,
    updateOne: mocks.sessionUpdateOne,
  },
}))
vi.mock('@shared/storage/r2', () => ({
  uploadToR2: mocks.uploadToR2,
  deleteFromR2: mocks.deleteFromR2,
}))
vi.mock('../services/multimodalObservationRetentionService', () => ({
  isHireRuntimeMultimodalObservationRetentionPurged: mocks.retentionExists,
}))

import {
  __hireRuntimeMultimodalAnalysisCapture,
  captureHireRuntimeMultimodalAnalysis,
} from '../services/multimodalAnalysisCaptureService'

const IDS = {
  binding: 'a'.repeat(24),
  workspace: 'b'.repeat(24),
  application: 'c'.repeat(24),
  round: 'd'.repeat(24),
  principal: 'e'.repeat(24),
  session: 'f'.repeat(24),
}

function objectId(value: string) {
  return { toString: () => value }
}

function binding() {
  return {
    _id: objectId(IDS.binding),
    workspaceId: objectId(IDS.workspace),
    applicationId: objectId(IDS.application),
    roundId: objectId(IDS.round),
    principalId: objectId(IDS.principal),
    runtimeSessionId: objectId(IDS.session),
    attemptCount: 1,
    status: 'completed',
    consentVersion: HIRE_AI_CONSENT_VERSION,
  }
}

function capture() {
  return {
    sessionId: IDS.session,
    frames: [{
      ts: 1,
      gazeX: 0,
      gazeY: 0,
      headPoseYaw: 0,
      headPosePitch: 0,
      expression: 'focused' as const,
      eyeContactScore: 0.9,
      blendshapes: { browDownLeft: 0.2 },
    }],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.bindingFindOne.mockResolvedValue(binding())
  mocks.bindingUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.outboxExists.mockResolvedValue(null)
  mocks.outboxCreate.mockResolvedValue({})
  mocks.outboxDeleteMany.mockResolvedValue({ deletedCount: 1 })
  mocks.sessionExists.mockResolvedValue({ _id: objectId(IDS.session) })
  mocks.sessionUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.uploadToR2.mockResolvedValue(undefined)
  mocks.deleteFromR2.mockResolvedValue(undefined)
  mocks.retentionExists.mockResolvedValue(false)
})

describe('Hire full-analysis landmark capture', () => {
  it('uses a bounded nonce suffix under the exact principal/session prefix', () => {
    const key = __hireRuntimeMultimodalAnalysisCapture.runtimeLandmarkKey(
      IDS.principal,
      IDS.session,
      '1'.repeat(__hireRuntimeMultimodalAnalysisCapture.LANDMARK_CAPTURE_NONCE_HEX_LENGTH),
    )
    expect(key).toBe(
      `landmarks/${IDS.principal}/${IDS.session}-${'1'.repeat(32)}.json`,
    )
  })

  it('keeps the winning source object intact when simultaneous captures race on the outbox key', async () => {
    mocks.outboxCreate
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce({ code: 11000 })

    const outcomes = await Promise.all([
      captureHireRuntimeMultimodalAnalysis({
        workspaceId: IDS.workspace,
        principalId: IDS.principal,
        capture: capture(),
      }),
      captureHireRuntimeMultimodalAnalysis({
        workspaceId: IDS.workspace,
        principalId: IDS.principal,
        capture: capture(),
      }),
    ])

    expect(outcomes.sort()).toEqual(['accepted', 'already_captured'])
    const uploadedKeys = mocks.uploadToR2.mock.calls.map(([key]) => key)
    expect(new Set(uploadedKeys).size).toBe(2)
    const deletedKey = mocks.deleteFromR2.mock.calls[0]?.[0]
    expect(uploadedKeys).toContain(deletedKey)
    expect(mocks.deleteFromR2).toHaveBeenCalledTimes(1)
    expect(mocks.sessionUpdateOne).toHaveBeenCalledTimes(1)
  })
})
