import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

const mockFindById = vi.fn()

vi.mock('@shared/db/models/User', () => ({
  User: {
    findById: (...args: unknown[]) => ({
      select: () => ({ lean: () => mockFindById(...args) }),
    }),
  },
}))

import { buildInterviewConfig } from '@resume/services/resumeService'

describe('buildInterviewConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns null when user not found', async () => {
    mockFindById.mockResolvedValue(null)
    const result = await buildInterviewConfig('user123', 'resume1')
    expect(result).toBeNull()
  })

  it('returns null when resume not found', async () => {
    mockFindById.mockResolvedValue({ savedResumes: [] })
    const result = await buildInterviewConfig('user123', 'resume1')
    expect(result).toBeNull()
  })

  it('infers PM domain from targetRole', async () => {
    mockFindById.mockResolvedValue({
      savedResumes: [{
        id: 'r1',
        name: 'My Resume',
        targetRole: 'Product Manager',
        targetCompany: 'Google',
        fullText: 'Resume content here',
        experience: [],
      }],
    })

    const result = await buildInterviewConfig('user123', 'r1')
    expect(result).not.toBeNull()
    expect(result!.domain).toBe('pm')
    expect(result!.resumeName).toBe('My Resume')
    expect(result!.targetCompany).toBe('Google')
  })

  it('infers backend domain from software engineer role', async () => {
    mockFindById.mockResolvedValue({
      savedResumes: [{
        id: 'r1', name: 'Dev Resume', targetRole: 'Senior Software Engineer',
        fullText: 'text', experience: [],
      }],
    })

    const result = await buildInterviewConfig('user123', 'r1')
    expect(result!.domain).toBe('backend')
  })

  it('infers data-science domain from data analyst role', async () => {
    mockFindById.mockResolvedValue({
      savedResumes: [{
        id: 'r1', name: 'DS Resume', targetRole: 'Data Scientist',
        fullText: 'text', experience: [],
      }],
    })

    const result = await buildInterviewConfig('user123', 'r1')
    expect(result!.domain).toBe('data-science')
  })

  it('returns null domain for unknown role', async () => {
    mockFindById.mockResolvedValue({
      savedResumes: [{
        id: 'r1', name: 'Resume', targetRole: 'Chief Fun Officer',
        fullText: 'text', experience: [],
      }],
    })

    const result = await buildInterviewConfig('user123', 'r1')
    expect(result!.domain).toBeNull()
  })

  it('infers experience level from resume entries', async () => {
    const now = new Date()
    const eightYearsAgo = new Date(now)
    eightYearsAgo.setFullYear(now.getFullYear() - 8)

    mockFindById.mockResolvedValue({
      savedResumes: [{
        id: 'r1', name: 'Resume', targetRole: 'PM',
        fullText: 'text',
        experience: [
          { startDate: eightYearsAgo.toISOString(), endDate: now.toISOString() },
        ],
      }],
    })

    const result = await buildInterviewConfig('user123', 'r1')
    expect(result!.experience).toBe('7+')
  })

  it('infers 0-2 experience when no experience entries', async () => {
    mockFindById.mockResolvedValue({
      savedResumes: [{
        id: 'r1', name: 'Resume', targetRole: 'PM',
        fullText: 'text', experience: [],
      }],
    })

    const result = await buildInterviewConfig('user123', 'r1')
    expect(result!.experience).toBe('0-2')
  })
})
