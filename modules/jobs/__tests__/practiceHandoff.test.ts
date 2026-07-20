import { beforeEach, describe, expect, it, vi } from 'vitest'
import { gzipSync } from 'zlib'

const { mockPostingFindById, mockApplicationFindOne, mockConnectDB, mockGetActiveCatalog } = vi.hoisted(() => ({
  mockPostingFindById: vi.fn(),
  mockApplicationFindOne: vi.fn(),
  mockConnectDB: vi.fn(),
  mockGetActiveCatalog: vi.fn(),
}))

vi.mock('@shared/db/connection', () => ({ connectDB: mockConnectDB }))
vi.mock('@shared/db/models', () => ({
  JobPosting: { findById: mockPostingFindById },
  JobApplication: { findOne: mockApplicationFindOne },
}))
vi.mock('@interview/services/persona/domainCatalogService', () => ({
  getActiveInterviewDomainCatalog: mockGetActiveCatalog,
}))

import {
  mintPracticeHandoffToken,
  PRACTICE_HANDOFF_TTL_SECONDS,
  preparePracticeHandoffPosting,
  practiceHandoffHashOf,
  resolvePracticeHandoff,
} from '../services/practiceHandoff'
import { xrayHashOf } from '../services/xrayService'
import {
  INTERVIEW_JOB_DESCRIPTION_MAX_CHARS,
  INTERVIEW_TARGET_COMPANY_MAX_CHARS,
} from '@shared/interviewContract'

const USER_ID = '507f1f77bcf86cd799439010'
const OTHER_USER_ID = '507f1f77bcf86cd799439099'
const JOB_ID = '507f1f77bcf86cd799439011'
const NOW = new Date('2026-07-20T10:00:00Z')
const JD = 'Backend role requiring Node.js, MongoDB, and payment systems. '.repeat(3)
const DISPLAY_JD = JD.replace(/\. /g, '.\n\n').trim()
const HASH = practiceHandoffHashOf(JD)
const ACTIVE_CATALOG = {
  slugs: ['backend', 'frontend', 'general', 'mobile'],
  slugSet: new Set(['backend', 'frontend', 'general', 'mobile']),
  inferenceSlugSet: new Set(['backend', 'frontend', 'general', 'mobile']),
  revision: 'jd-role-v2:test',
  authoritative: true,
  source: 'cms' as const,
}

const selectLean = (value: unknown) => ({ select: () => ({ lean: () => Promise.resolve(value) }) })

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXTAUTH_SECRET', 'test-secret-longer-than-sixteen-characters')
  mockConnectDB.mockResolvedValue(undefined)
  mockGetActiveCatalog.mockResolvedValue(ACTIVE_CATALOG)
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

  it('falls back to canonical JD when the display twin cannot be inflated', async () => {
    const token = mintPracticeHandoffToken({ userId: USER_ID, jobId: JOB_ID, jdHash: HASH }, NOW)
    mockPostingFindById.mockReturnValue(selectLean({
      company: 'PhonePe',
      domain: 'backend',
      status: 'open',
      jdCompressed: gzipSync(Buffer.from(JD)),
      jdDisplayCompressed: Buffer.from('not-gzip'),
    }))

    expect((await resolvePracticeHandoff(token, USER_ID, NOW))?.jobDescription).toBe(JD)
  })

  it('keeps display text but withholds hash and role when canonical gzip is corrupt', async () => {
    expect(await preparePracticeHandoffPosting({
      domain: 'backend',
      jdCompressed: Buffer.from('not-gzip'),
      jdDisplayCompressed: gzipSync(Buffer.from(DISPLAY_JD)),
    })).toEqual({ jobDescription: DISPLAY_JD })
  })

  it('publishes readiness at the exact JD boundary and withholds it one character over', async () => {
    const atLimit = 'j'.repeat(INTERVIEW_JOB_DESCRIPTION_MAX_CHARS)
    const overLimit = `${atLimit}j`

    expect(await preparePracticeHandoffPosting({
      domain: 'backend',
      jdCompressed: gzipSync(Buffer.from(atLimit)),
    })).toEqual({
      jobDescription: atLimit,
      jdHash: practiceHandoffHashOf(atLimit),
      role: 'backend',
    })
    expect(await preparePracticeHandoffPosting({
      domain: 'backend',
      jdCompressed: gzipSync(Buffer.from(overLimit)),
    })).toEqual({ jobDescription: overLimit })
  })

  it('withholds readiness for a whitespace-only canonical JD', async () => {
    expect(await preparePracticeHandoffPosting({
      domain: 'backend',
      jdCompressed: gzipSync(Buffer.from('   \n\t  ')),
      jdDisplayCompressed: gzipSync(Buffer.from('Readable display text')),
    })).toEqual({ jobDescription: 'Readable display text' })
  })

  it('falls back to schema-safe canonical text when a matching display twin is oversized', async () => {
    const canonical = 'A '.repeat(25_000).trim()
    const oversizedDisplay = canonical.replaceAll(' ', '  ')
    expect(canonical.length).toBe(INTERVIEW_JOB_DESCRIPTION_MAX_CHARS - 1)
    expect(oversizedDisplay.length).toBeGreaterThan(INTERVIEW_JOB_DESCRIPTION_MAX_CHARS)

    expect(await preparePracticeHandoffPosting({
      domain: 'backend',
      jdCompressed: gzipSync(Buffer.from(canonical)),
      jdDisplayCompressed: gzipSync(Buffer.from(oversizedDisplay)),
    })).toEqual({
      jobDescription: canonical,
      jdHash: practiceHandoffHashOf(canonical),
      role: 'backend',
    })
  })

  it('bounds the server-resolved company to the interview schema', async () => {
    const token = mintPracticeHandoffToken({ userId: USER_ID, jobId: JOB_ID, jdHash: HASH }, NOW)
    mockPostingFindById.mockReturnValue(selectLean({
      company: 'c'.repeat(INTERVIEW_TARGET_COMPANY_MAX_CHARS + 1),
      domain: 'backend',
      status: 'open',
      jdCompressed: gzipSync(Buffer.from(JD)),
    }))

    expect((await resolvePracticeHandoff(token, USER_ID, NOW))?.company).toHaveLength(
      INTERVIEW_TARGET_COMPANY_MAX_CHARS,
    )
  })

  it('uses inferred role only when its parse cache belongs to the signed JD', async () => {
    const token = mintPracticeHandoffToken({ userId: USER_ID, jobId: JOB_ID, jdHash: HASH }, NOW)
    mockPostingFindById
      .mockReturnValueOnce(selectLean({
        company: 'PhonePe',
        status: 'open',
        parsedJD: { inferredDomain: 'frontend' },
        parsedJDHash: 'stale-cache-hash',
        parsedJDRoleVersion: ACTIVE_CATALOG.revision,
        jdCompressed: gzipSync(Buffer.from(JD)),
      }))
      .mockReturnValueOnce(selectLean({
        company: 'PhonePe',
        status: 'open',
        parsedJD: { inferredDomain: 'frontend' },
        parsedJDHash: xrayHashOf(JD),
        parsedJDRoleVersion: ACTIVE_CATALOG.revision,
        jdCompressed: gzipSync(Buffer.from(JD)),
      }))

    expect((await resolvePracticeHandoff(token, USER_ID, NOW))?.role).toBeUndefined()
    expect((await resolvePracticeHandoff(token, USER_ID, NOW))?.role).toBe('frontend')
  })

  it('withholds a same-hash legacy role until X-ray refreshes its catalog revision', async () => {
    const prepared = await preparePracticeHandoffPosting({
      jdCompressed: gzipSync(Buffer.from(JD)),
      parsedJD: { inferredDomain: ' Frontend ' },
      parsedJDHash: xrayHashOf(JD),
      // No parsedJDRoleVersion: produced by the legacy incomplete prompt.
    })

    expect(prepared.jdHash).toBe(HASH)
    expect(prepared.role).toBeUndefined()
  })

  it('fails Practice readiness closed when the CMS catalog is unavailable', async () => {
    mockGetActiveCatalog.mockResolvedValue({
      ...ACTIVE_CATALOG,
      authoritative: false,
      source: 'seed-fallback',
      fallbackReason: 'unavailable',
    })

    const prepared = await preparePracticeHandoffPosting({
      domain: 'backend',
      jdCompressed: gzipSync(Buffer.from(JD)),
    })

    expect(prepared).toEqual({ jobDescription: JD, jdHash: HASH })
  })

  it('does not bypass a declared CMS-inactive domain with a cached inferred role', async () => {
    mockGetActiveCatalog.mockResolvedValue({
      ...ACTIVE_CATALOG,
      slugs: ['frontend', 'general'],
      slugSet: new Set(['frontend', 'general']),
      inferenceSlugSet: new Set(['frontend', 'general']),
    })

    const prepared = await preparePracticeHandoffPosting({
      domain: 'backend',
      parsedJD: { inferredDomain: 'frontend' },
      parsedJDHash: xrayHashOf(JD),
      parsedJDRoleVersion: ACTIVE_CATALOG.revision,
      jdCompressed: gzipSync(Buffer.from(JD)),
    })

    expect(prepared.jdHash).toBe(HASH)
    expect(prepared.role).toBeUndefined()
  })

  it('does not elevate an arbitrary cached LLM role into server configuration', async () => {
    const token = mintPracticeHandoffToken({ userId: USER_ID, jobId: JOB_ID, jdHash: HASH }, NOW)
    mockPostingFindById.mockReturnValue(selectLean({
      company: 'PhonePe',
      status: 'open',
      parsedJD: { inferredDomain: 'attacker-controlled-role' },
      parsedJDHash: xrayHashOf(JD),
      parsedJDRoleVersion: ACTIVE_CATALOG.revision,
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
