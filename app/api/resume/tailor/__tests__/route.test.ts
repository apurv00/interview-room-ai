import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  redisIncr: vi.fn(),
  redisPexpire: vi.fn(),
  tailorResume: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/redis', () => ({
  redis: {
    incr: mocks.redisIncr,
    pexpire: mocks.redisPexpire,
  },
}))
vi.mock('@shared/logger', () => ({
  aiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@resume/services/resumeAIService', () => ({ tailorResume: mocks.tailorResume }))

import { POST } from '../route'

const USER_A_ID = '507f1f77bcf86cd799439010'
const USER_B_ID = '507f1f77bcf86cd799439011'
const validBody = {
  resumeText: 'A'.repeat(80),
  jobDescription: 'B'.repeat(80),
  companyName: 'Acme',
}
const result = {
  tailoredResume: 'TAILORED',
  changes: [],
  matchScore: 80,
  missingKeywords: [],
  addedKeywords: [],
}

function request(body: Record<string, unknown>, originUserId?: string) {
  return new NextRequest('http://localhost/api/resume/tailor', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(originUserId !== undefined ? { 'x-origin-user-id': originUserId } : {}),
    },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getServerSession.mockResolvedValue({ user: { id: USER_B_ID, plan: 'free' } })
  mocks.redisIncr.mockResolvedValue(1)
  mocks.redisPexpire.mockResolvedValue(1)
  mocks.tailorResume.mockResolvedValue(result)
})

describe('POST /api/resume/tailor session provenance', () => {
  it('rejects a different originating user before quota or model work', async () => {
    const response = await POST(
      request({ ...validBody, originUserId: USER_A_ID }, USER_A_ID),
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: 'sign-in session changed',
      code: 'SESSION_CHANGED',
    })
    expect(mocks.redisIncr).not.toHaveBeenCalled()
    expect(mocks.redisPexpire).not.toHaveBeenCalled()
    expect(mocks.tailorResume).not.toHaveBeenCalled()
  })

  it('accepts an exact authenticated origin and keeps it out of the model payload', async () => {
    const response = await POST(
      request({ ...validBody, originUserId: USER_B_ID }, USER_B_ID),
    )

    expect(response.status).toBe(200)
    expect(mocks.redisIncr).toHaveBeenCalledTimes(1)
    expect(mocks.tailorResume).toHaveBeenCalledWith(validBody)
  })

  it('preserves authenticated callers that omit originUserId', async () => {
    const response = await POST(request(validBody))

    expect(response.status).toBe(200)
    expect(mocks.redisIncr).toHaveBeenCalledTimes(1)
    expect(mocks.tailorResume).toHaveBeenCalledWith(validBody)
  })

  it('preserves anonymous callers that omit originUserId', async () => {
    mocks.getServerSession.mockResolvedValue(null)

    const response = await POST(request(validBody))

    expect(response.status).toBe(200)
    expect(mocks.redisIncr).toHaveBeenCalledTimes(2)
    expect(mocks.tailorResume).toHaveBeenCalledWith(validBody)
  })
})
