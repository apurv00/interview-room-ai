import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const {
  mockAggregate,
  mockGetServerSession,
  mockRedisGet,
  mockRedisSetex,
} = vi.hoisted(() => ({
  mockAggregate: vi.fn(),
  mockGetServerSession: vi.fn(),
  mockRedisGet: vi.fn(),
  mockRedisSetex: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@shared/db/models', () => ({
  InterviewSession: { aggregate: mockAggregate, findOne: vi.fn() },
}))
vi.mock('@shared/redis', () => ({
  redis: { get: mockRedisGet, setex: mockRedisSetex },
}))
vi.mock('@shared/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

import { INTERVIEW_ROLE_SLUG_MAX_CHARS } from '@shared/interviewContract'
import { GET } from '../route'

describe('GET /api/analytics/peer-comparison role contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetServerSession.mockResolvedValue({ user: { id: '507f1f77bcf86cd799439010' } })
    mockRedisGet.mockResolvedValue(null)
    mockRedisSetex.mockResolvedValue('OK')
    mockAggregate.mockResolvedValue([])
  })

  it('accepts the exact CMS role limit without truncation and rejects one character over', async () => {
    const atLimit = 'r'.repeat(INTERVIEW_ROLE_SLUG_MAX_CHARS)
    const accepted = await GET(new NextRequest(
      `http://localhost/api/analytics/peer-comparison?role=${atLimit}&experience=3-6`,
    ))

    expect(accepted.status).toBe(200)
    expect(mockAggregate).toHaveBeenCalledTimes(1)
    const pipeline = mockAggregate.mock.calls[0][0] as Array<{ $match?: Record<string, unknown> }>
    expect(pipeline[0].$match?.['config.role']).toBe(atLimit)

    mockAggregate.mockClear()
    const rejected = await GET(new NextRequest(
      `http://localhost/api/analytics/peer-comparison?role=${atLimit}r&experience=3-6`,
    ))
    expect(rejected.status).toBe(400)
    expect(mockAggregate).not.toHaveBeenCalled()
  })
})
