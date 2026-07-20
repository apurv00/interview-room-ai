import { beforeEach, describe, expect, it, vi } from 'vitest'
import { gzipSync } from 'zlib'

const { mockPostingFindById, mockApplicationFindOne, mockConnectDB } = vi.hoisted(() => ({
  mockPostingFindById: vi.fn(),
  mockApplicationFindOne: vi.fn(),
  mockConnectDB: vi.fn(),
}))

vi.mock('@shared/db/connection', () => ({ connectDB: mockConnectDB }))
vi.mock('@shared/db/models', () => ({
  JobPosting: { findById: mockPostingFindById },
  JobApplication: { findOne: mockApplicationFindOne },
}))

import {
  mintPracticeHandoffToken,
  PRACTICE_HANDOFF_TTL_SECONDS,
  practiceHandoffHashOf,
  resolvePracticeHandoff,
} from '../services/practiceHandoff'
import { xrayHashOf } from '../services/xrayService'

const USER_ID = '507f1f77bcf86cd799439010'
const OTHER_USER_ID = '507f1f77bcf86cd799439099'
const JOB_ID = '507f1f77bcf86cd799439011'
const NOW = new Date('2026-07-20T10:00:00Z')
const JD = 'Backend role requiring Node.js, MongoDB, and payment systems. '.repeat(3)
const DISPLAY_JD = JD.replace(/\. /g, '.\n\n').trim()
const HASH = practiceHandoffHashOf(JD)

const selectLean = (value: unknown) => ({ select: () => ({ lean: () => Promise.resolve(value) }) })

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXTAUTH_SECRET', 'test-secret-longer-than-sixteen-characters')
  mockConnectDB.mockResolvedValue(undefined)
  mockPostingFindById.mockReturnValue(selectLean({
    company: 'PhonePe',
    domain: 'backend',
    status: 'open',
    jdCompressed: gzipSync(Buffer.from(JD)),
    // Different formatting, identical normalized xray hash.
    jdDisplayCompressed: gzipSync(Buffer.from(DISPLAY_JD)),
  }))
  mockApplicationFindOne.mockReturnValue(selectLean({ _id: 'app-canonical' }))
})

describe('Jobs practice handoff', () => {
  it('resolves a signed user+job+JD intent and canonical application server-side', async () => {
    const token = mintPracticeHandoffToken({ userId: USER_ID, jobId: JOB_ID, jdHash: HASH }, NOW)

    const resolved = await resolvePracticeHandoff(token, USER_ID, NOW)

    expect(resolved).toEqual({
      jobId: JOB_ID,
      jobDescription: DISPLAY_JD,
      jdHash: HASH,
      company: 'PhonePe',
      role: 'backend',
      applicationId: 'app-canonical',
    })
    expect(mockApplicationFindOne).toHaveBeenCalledWith({ userId: USER_ID, jobPostingId: JOB_ID })
  })

  it('rejects cross-user replay, signature tampering, and expiry before database reads', async () => {
    const token = mintPracticeHandoffToken({ userId: USER_ID, jobId: JOB_ID, jdHash: HASH }, NOW)
    const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`
    const expiredAt = new Date(NOW.getTime() + (PRACTICE_HANDOFF_TTL_SECONDS + 1) * 1000)

    expect(await resolvePracticeHandoff(token, OTHER_USER_ID, NOW)).toBeNull()
    expect(await resolvePracticeHandoff(tampered, USER_ID, NOW)).toBeNull()
    expect(await resolvePracticeHandoff(token, USER_ID, expiredAt)).toBeNull()
    expect(mockPostingFindById).not.toHaveBeenCalled()
  })

  it('rejects a posting that closed or changed JD after token minting', async () => {
    const token = mintPracticeHandoffToken({ userId: USER_ID, jobId: JOB_ID, jdHash: HASH }, NOW)
    mockPostingFindById
      .mockReturnValueOnce(selectLean({
        company: 'PhonePe', status: 'closed', jdCompressed: gzipSync(Buffer.from(JD)),
      }))
      .mockReturnValueOnce(selectLean({
        company: 'PhonePe', status: 'open', jdCompressed: gzipSync(Buffer.from('A changed JD body')),
      }))

    expect(await resolvePracticeHandoff(token, USER_ID, NOW)).toBeNull()
    expect(await resolvePracticeHandoff(token, USER_ID, NOW)).toBeNull()
    expect(mockApplicationFindOne).not.toHaveBeenCalled()
  })

  it('falls back to canonical JD when a corrupt display twin does not match the signed hash', async () => {
    const token = mintPracticeHandoffToken({ userId: USER_ID, jobId: JOB_ID, jdHash: HASH }, NOW)
    mockPostingFindById.mockReturnValue(selectLean({
      company: 'PhonePe',
      status: 'open',
      jdCompressed: gzipSync(Buffer.from(JD)),
      jdDisplayCompressed: gzipSync(Buffer.from('Wrong display twin')),
    }))

    const resolved = await resolvePracticeHandoff(token, USER_ID, NOW)

    expect(resolved?.jobDescription).toBe(JD)
  })

  it('uses inferred role only when its parse cache belongs to the signed JD', async () => {
    const token = mintPracticeHandoffToken({ userId: USER_ID, jobId: JOB_ID, jdHash: HASH }, NOW)
    mockPostingFindById
      .mockReturnValueOnce(selectLean({
        company: 'PhonePe',
        status: 'open',
        parsedJD: { inferredDomain: 'frontend' },
        parsedJDHash: 'stale-cache-hash',
        jdCompressed: gzipSync(Buffer.from(JD)),
      }))
      .mockReturnValueOnce(selectLean({
        company: 'PhonePe',
        status: 'open',
        parsedJD: { inferredDomain: 'frontend' },
        parsedJDHash: xrayHashOf(JD),
        jdCompressed: gzipSync(Buffer.from(JD)),
      }))

    expect((await resolvePracticeHandoff(token, USER_ID, NOW))?.role).toBeUndefined()
    expect((await resolvePracticeHandoff(token, USER_ID, NOW))?.role).toBe('frontend')
  })

  it('does not elevate an arbitrary cached LLM role into server configuration', async () => {
    const token = mintPracticeHandoffToken({ userId: USER_ID, jobId: JOB_ID, jdHash: HASH }, NOW)
    mockPostingFindById.mockReturnValue(selectLean({
      company: 'PhonePe',
      status: 'open',
      parsedJD: { inferredDomain: 'attacker-controlled-role' },
      parsedJDHash: xrayHashOf(JD),
      jdCompressed: gzipSync(Buffer.from(JD)),
    }))

    expect((await resolvePracticeHandoff(token, USER_ID, NOW))?.role).toBeUndefined()
  })

  it('fails closed without the authentication secret', async () => {
    vi.stubEnv('NEXTAUTH_SECRET', '')
    expect(() => mintPracticeHandoffToken({ userId: USER_ID, jobId: JOB_ID, jdHash: HASH }, NOW)).toThrow(
      'refusing to mint'
    )
    expect(await resolvePracticeHandoff('malformed.token', USER_ID, NOW)).toBeNull()
  })
})
