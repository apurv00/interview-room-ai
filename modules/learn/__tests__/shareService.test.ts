import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(),
  findOne: vi.fn(),
  isJobsAccountActive: vi.fn(),
}))

vi.mock('@shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('@shared/db/models/InterviewSession', () => ({
  InterviewSession: { findOne: mocks.findOne },
}))
vi.mock('@shared/services/jobsAccountFence', () => ({
  isJobsAccountActive: mocks.isJobsAccountActive,
}))
vi.mock('@shared/logger', () => ({
  aiLogger: { error: vi.fn() },
}))

import { getPublicScorecard } from '../services/shareService'

const OWNER_ID = '507f1f77bcf86cd799439010'

function publicSession() {
  return {
    userId: { toString: () => OWNER_ID },
    config: { role: 'backend', interviewType: 'behavioral', experience: '3-6' },
    feedback: {
      overall_score: 84,
      dimensions: {
        answer_quality: { score: 82, strengths: ['Clear evidence'] },
        communication: { score: 85 },
        engagement_signals: { score: 86 },
      },
    },
    evaluations: [{}, {}],
    durationActualSeconds: 1200,
    createdAt: new Date('2026-07-20T10:00:00.000Z'),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connectDB.mockResolvedValue(undefined)
  mocks.isJobsAccountActive.mockResolvedValue(true)
  mocks.findOne.mockReturnValue({
    select: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(publicSession()),
    }),
  })
})

describe('getPublicScorecard account lifecycle', () => {
  it('returns the public projection while the owner remains active', async () => {
    const result = await getPublicScorecard('valid-token')

    expect(result).toMatchObject({
      domain: 'backend',
      overallScore: 84,
      strengths: ['Clear evidence'],
    })
    expect(mocks.isJobsAccountActive).toHaveBeenCalledWith(OWNER_ID)
  })

  it('revokes a retained public link when its owner is deleting', async () => {
    mocks.isJobsAccountActive.mockResolvedValue(false)

    await expect(getPublicScorecard('retained-token')).resolves.toBeNull()
    expect(mocks.isJobsAccountActive).toHaveBeenCalledWith(OWNER_ID)
  })
})
