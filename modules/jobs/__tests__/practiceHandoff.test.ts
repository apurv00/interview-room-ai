import { beforeEach, describe, expect, it, vi } from 'vitest'
import { gzipSync } from 'zlib'

const {
  mockPostingFindById,
  mockPostingExists,
  mockPostingUpdateOne,
  mockApplicationFindOne,
  mockApplicationExists,
  mockApplicationUpdateOne,
  mockUserFindById,
  mockUserExists,
  mockConnectDB,
  mockGetActiveCatalog,
  mockGetOrParseXray,
  mockIsJobsAccountActive,
} = vi.hoisted(() => ({
  mockPostingFindById: vi.fn(),
  mockPostingExists: vi.fn().mockResolvedValue({ _id: 'posting-authoritative' }),
  mockPostingUpdateOne: vi.fn(),
  mockApplicationFindOne: vi.fn(),
  mockApplicationExists: vi.fn().mockResolvedValue({ _id: 'application-authoritative' }),
  mockApplicationUpdateOne: vi.fn(),
  mockUserFindById: vi.fn(),
  mockUserExists: vi.fn(),
  mockConnectDB: vi.fn(),
  mockGetActiveCatalog: vi.fn(),
  mockGetOrParseXray: vi.fn(),
  mockIsJobsAccountActive: vi.fn(),
}))

vi.mock('@shared/db/connection', () => ({ connectDB: mockConnectDB }))
vi.mock('@shared/db/models', () => ({
  JobPosting: {
    findById: mockPostingFindById,
    exists: mockPostingExists,
    updateOne: mockPostingUpdateOne,
  },
  JobApplication: {
    findOne: mockApplicationFindOne,
    exists: mockApplicationExists,
    updateOne: mockApplicationUpdateOne,
  },
  User: { findById: mockUserFindById, exists: mockUserExists },
}))
vi.mock('@interview/services/persona/domainCatalogService', () => ({
  getActiveInterviewDomainCatalog: mockGetActiveCatalog,
}))
vi.mock('@shared/services/jobsAccountFence', () => ({
  isJobsAccountActive: mockIsJobsAccountActive,
  activeJobsAccountFilter: (userId: string) => ({
    _id: userId,
    $or: [
      { accountState: 'active' },
      { accountState: { $exists: false } },
    ],
  }),
}))
vi.mock('../services/xrayService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/xrayService')>()
  return { ...actual, getOrParseXray: mockGetOrParseXray }
})

import {
  mintPracticeHandoffToken,
  fencePracticeSessionWrite,
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
const PARSED_JD = {
  rawText: JD,
  company: 'PhonePe',
  role: 'Backend Engineer',
  inferredDomain: 'backend',
  requirements: [{
    id: 'req-1',
    category: 'technical' as const,
    requirement: 'Build Node.js services',
    importance: 'must-have' as const,
    targetCompetencies: ['backend'],
  }],
  keyThemes: ['payments'],
}
const RESOLVED_PARSED_JD = {
  ...PARSED_JD,
  rawText: DISPLAY_JD,
  modelParsingSuppressed: true as const,
}

const selectLean = (value: unknown) => ({ select: () => ({ lean: () => Promise.resolve(value) }) })
const transactionalSelectLean = (value: unknown) => ({
  select: () => {
    const query = {
      session: () => query,
      lean: () => Promise.resolve(value),
    }
    return query
  },
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXTAUTH_SECRET', 'test-secret-longer-than-sixteen-characters')
  mockConnectDB.mockResolvedValue(undefined)
  mockGetActiveCatalog.mockResolvedValue(ACTIVE_CATALOG)
  mockGetOrParseXray.mockResolvedValue({ parsed: PARSED_JD })
  mockIsJobsAccountActive.mockResolvedValue(true)
  mockUserFindById.mockReturnValue(selectLean({ experienceLevel: '3-6' }))
  mockUserExists.mockResolvedValue({ _id: USER_ID })
  mockPostingFindById.mockReturnValue(selectLean({
    company: 'PhonePe',
    domain: 'backend',
    status: 'open',
    parsedJD: PARSED_JD,
    parsedJDHash: xrayHashOf(JD),
    parsedJDRoleVersion: ACTIVE_CATALOG.revision,
    jdCompressed: gzipSync(Buffer.from(JD)),
    // Different formatting, identical normalized xray hash.
    jdDisplayCompressed: gzipSync(Buffer.from(DISPLAY_JD)),
  }))
  mockApplicationFindOne.mockReturnValue(selectLean({ _id: 'app-canonical' }))
  mockPostingUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mockApplicationUpdateOne.mockResolvedValue({ matchedCount: 1 })
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
      experience: '3-6',
      parsedJobDescription: RESOLVED_PARSED_JD,
      role: 'backend',
      applicationId: 'app-canonical',
    })
    expect(mockApplicationFindOne).toHaveBeenCalledWith({ userId: USER_ID, jobPostingId: JOB_ID })
    expect(mockGetOrParseXray).not.toHaveBeenCalled()
  })

  it('routes a live cache miss through the posting X-ray cache exactly once', async () => {
    mockPostingFindById.mockReturnValue(selectLean({
      company: 'PhonePe',
      domain: 'backend',
      status: 'open',
      jdCompressed: gzipSync(Buffer.from(JD)),
      jdDisplayCompressed: gzipSync(Buffer.from(DISPLAY_JD)),
    }))
    const token = mintPracticeHandoffToken({ userId: USER_ID, jobId: JOB_ID, jdHash: HASH }, NOW)

    const resolved = await resolvePracticeHandoff(token, USER_ID, NOW)

    expect(mockGetOrParseXray).toHaveBeenCalledOnce()
    expect(mockGetOrParseXray).toHaveBeenCalledWith(JOB_ID, USER_ID)
    expect(mockPostingFindById).toHaveBeenCalledTimes(2)
    expect(resolved?.parsedJobDescription).toEqual(RESOLVED_PARSED_JD)
  })

  it('does not re-enter X-ray when the final session fence follows a live parser fallback', async () => {
    const posting = {
      company: 'PhonePe',
      domain: 'backend',
      status: 'open' as const,
      jdCompressed: gzipSync(Buffer.from(JD)),
      jdDisplayCompressed: gzipSync(Buffer.from(DISPLAY_JD)),
      updatedAt: NOW,
    }
    mockPostingFindById.mockReturnValue(transactionalSelectLean(posting))
    mockGetOrParseXray.mockResolvedValueOnce({
      parsed: {
        company: '',
        role: '',
        inferredDomain: '',
        requirements: [],
        keyThemes: [],
      },
      cached: false,
    })
    const token = mintPracticeHandoffToken({ userId: USER_ID, jobId: JOB_ID, jdHash: HASH }, NOW)
    const resolved = await resolvePracticeHandoff(token, USER_ID, NOW)
    if (!resolved?.role) throw new Error('expected resolved live handoff')
    const dbSession = { id: 'practice-transaction' }

    const fenced = await fencePracticeSessionWrite({
      userId: USER_ID,
      jobId: resolved.jobId,
      jdHash: resolved.jdHash,
      role: resolved.role,
      applicationId: resolved.applicationId,
    }, dbSession as never)

    expect(fenced).toBe(true)
    expect(mockGetOrParseXray).toHaveBeenCalledOnce()
    expect(mockPostingUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: JOB_ID,
        status: 'open',
        jdCompressed: posting.jdCompressed,
      }),
      { $inc: { derivedAuthorityRevision: 1 } },
      { session: dbSession, timestamps: false },
    )
    expect(mockApplicationUpdateOne).toHaveBeenCalledWith(
      {
        _id: 'app-canonical',
        userId: USER_ID,
        jobPostingId: JOB_ID,
      },
      { $inc: { derivedAuthorityRevision: 1 } },
      { session: dbSession, timestamps: false },
    )
  })

  it('rejects a revoke-first transaction before any posting or session authority write', async () => {
    mockPostingFindById.mockReturnValue(transactionalSelectLean({
      company: 'PhonePe',
      domain: 'backend',
      status: 'closed',
      closedReason: 'source-revoked',
      jdCompressed: gzipSync(Buffer.from(JD)),
      updatedAt: NOW,
    }))
    const dbSession = { id: 'revoke-first' }

    const fenced = await fencePracticeSessionWrite({
      userId: USER_ID,
      jobId: JOB_ID,
      jdHash: HASH,
      role: 'backend',
      applicationId: 'app-canonical',
    }, dbSession as never)

    expect(fenced).toBe(false)
    expect(mockPostingUpdateOne).not.toHaveBeenCalled()
    expect(mockApplicationUpdateOne).not.toHaveBeenCalled()
    expect(mockGetOrParseXray).not.toHaveBeenCalled()
  })

  it('keeps an unparsed normal archive on raw JD without new X-ray spend', async () => {
    mockPostingFindById.mockReturnValue(selectLean({
      company: 'PhonePe',
      domain: 'backend',
      status: 'closed',
      closedReason: 'aged-out',
      jdCompressed: gzipSync(Buffer.from(JD)),
    }))
    const token = mintPracticeHandoffToken({ userId: USER_ID, jobId: JOB_ID, jdHash: HASH }, NOW)

    const resolved = await resolvePracticeHandoff(token, USER_ID, NOW)

    expect(mockGetOrParseXray).not.toHaveBeenCalled()
    expect(resolved?.parsedJobDescription).toEqual({
      rawText: JD,
      company: '',
      role: '',
      inferredDomain: '',
      requirements: [],
      keyThemes: [],
      modelParsingSuppressed: true,
    })
  })

  it('rejects cross-user replay, signature tampering, and expiry before database reads', async () => {
    const token = mintPracticeHandoffToken({ userId: USER_ID, jobId: JOB_ID, jdHash: HASH }, NOW)
    const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`
    const expiredAt = new Date(NOW.getTime() + (PRACTICE_HANDOFF_TTL_SECONDS + 1) * 1000)

    expect(await resolvePracticeHandoff(token, OTHER_USER_ID, NOW)).toBeNull()
    expect(await resolvePracticeHandoff(tampered, USER_ID, NOW)).toBeNull()
    expect(await resolvePracticeHandoff(token, USER_ID, expiredAt)).toBeNull()
    expect(mockPostingFindById).not.toHaveBeenCalled()
    expect(mockIsJobsAccountActive).not.toHaveBeenCalled()
  })

  it('rejects an inactive stale-JWT account before reading the posting or application', async () => {
    const token = mintPracticeHandoffToken({ userId: USER_ID, jobId: JOB_ID, jdHash: HASH }, NOW)
    mockIsJobsAccountActive.mockResolvedValue(false)

    expect(await resolvePracticeHandoff(token, USER_ID, NOW)).toBeNull()

    expect(mockConnectDB).toHaveBeenCalledOnce()
    expect(mockIsJobsAccountActive).toHaveBeenCalledWith(USER_ID)
    expect(mockPostingFindById).not.toHaveBeenCalled()
    expect(mockApplicationFindOne).not.toHaveBeenCalled()
    expect(mockUserFindById).not.toHaveBeenCalled()
    expect(mockGetActiveCatalog).not.toHaveBeenCalled()
  })

  it('discards a prepared handoff when deletion commits during CMS preparation', async () => {
    const token = mintPracticeHandoffToken({ userId: USER_ID, jobId: JOB_ID, jdHash: HASH }, NOW)
    mockIsJobsAccountActive
      .mockResolvedValueOnce(true)
    mockUserExists.mockResolvedValueOnce(null)

    expect(await resolvePracticeHandoff(token, USER_ID, NOW)).toBeNull()

    expect(mockPostingFindById).toHaveBeenCalledOnce()
    expect(mockApplicationFindOne).toHaveBeenCalledOnce()
    expect(mockGetActiveCatalog).toHaveBeenCalledOnce()
    expect(mockPostingExists).toHaveBeenCalledOnce()
    expect(mockApplicationExists).toHaveBeenCalledOnce()
    expect(mockIsJobsAccountActive).toHaveBeenCalledOnce()
    expect(mockUserExists).toHaveBeenCalledWith(expect.objectContaining({
      _id: USER_ID,
      experienceLevel: '3-6',
    }))
  })

  it.each(['0-2', '7+'] as const)(
    'resolves the server profile experience %s into the trusted handoff',
    async (experienceLevel) => {
      mockUserFindById.mockReturnValueOnce(selectLean({ experienceLevel }))
      const token = mintPracticeHandoffToken({ userId: USER_ID, jobId: JOB_ID, jdHash: HASH }, NOW)

      expect(await resolvePracticeHandoff(token, USER_ID, NOW)).toMatchObject({ experience: experienceLevel })
    },
  )

  it('fails closed before reading the posting when profile experience is missing or malformed', async () => {
    const token = mintPracticeHandoffToken({ userId: USER_ID, jobId: JOB_ID, jdHash: HASH }, NOW)
    mockUserFindById.mockReturnValueOnce(selectLean({}))

    expect(await resolvePracticeHandoff(token, USER_ID, NOW)).toBeNull()
    expect(mockPostingFindById).not.toHaveBeenCalled()
    expect(mockApplicationFindOne).not.toHaveBeenCalled()
  })

  it('rejects a handoff when profile experience changes during preparation', async () => {
    const token = mintPracticeHandoffToken({ userId: USER_ID, jobId: JOB_ID, jdHash: HASH }, NOW)
    mockUserFindById.mockReturnValueOnce(selectLean({ experienceLevel: '0-2' }))
    mockUserExists.mockResolvedValueOnce(null)

    expect(await resolvePracticeHandoff(token, USER_ID, NOW)).toBeNull()
    expect(mockUserExists).toHaveBeenCalledWith(expect.objectContaining({
      _id: USER_ID,
      experienceLevel: '0-2',
    }))
  })

  it('normal archive owner can resolve an exact-JD historical inferred role after catalog revision drift', async () => {
    const token = mintPracticeHandoffToken({ userId: USER_ID, jobId: JOB_ID, jdHash: HASH }, NOW)
    mockPostingFindById.mockReturnValue(selectLean({
      company: 'PhonePe', status: 'closed', closedReason: 'aged-out',
      parsedJD: { inferredDomain: 'frontend' },
      parsedJDHash: xrayHashOf(JD),
      parsedJDRoleVersion: 'jd-role-v2:previous-catalog',
      jdCompressed: gzipSync(Buffer.from(JD)),
    }))

    expect(await resolvePracticeHandoff(token, USER_ID, NOW)).toMatchObject({
      jobId: JOB_ID,
      jobDescription: JD,
      applicationId: 'app-canonical',
      role: 'frontend',
    })
  })

  it('token alone never grants archive access, and restricted closures fail before JD preparation', async () => {
    const token = mintPracticeHandoffToken({ userId: USER_ID, jobId: JOB_ID, jdHash: HASH }, NOW)
    mockPostingFindById
      .mockReturnValueOnce(selectLean({
        company: 'PhonePe', status: 'closed', closedReason: 'aged-out', jdCompressed: gzipSync(Buffer.from(JD)),
      }))
      .mockReturnValueOnce(selectLean({
        company: 'PhonePe', status: 'closed', closedReason: 'source-revoked', jdCompressed: gzipSync(Buffer.from(JD)),
      }))
    mockApplicationFindOne.mockReturnValueOnce(selectLean(null))

    expect(await resolvePracticeHandoff(token, USER_ID, NOW)).toBeNull()
    expect(await resolvePracticeHandoff(token, USER_ID, NOW)).toBeNull()
    expect(mockApplicationFindOne).toHaveBeenCalledTimes(1)
  })

  it('rejects an exact token when the live JD changed after minting', async () => {
    const token = mintPracticeHandoffToken({ userId: USER_ID, jobId: JOB_ID, jdHash: HASH }, NOW)
    mockPostingFindById.mockReturnValue(selectLean({
      company: 'PhonePe', status: 'open', jdCompressed: gzipSync(Buffer.from('A changed JD body')),
    }))

    expect(await resolvePracticeHandoff(token, USER_ID, NOW)).toBeNull()
    expect(mockApplicationFindOne).not.toHaveBeenCalled()
  })

  it('returns no handoff when source revocation commits during CMS preparation', async () => {
    const token = mintPracticeHandoffToken({ userId: USER_ID, jobId: JOB_ID, jdHash: HASH }, NOW)
    mockPostingExists.mockResolvedValueOnce(null)

    expect(await resolvePracticeHandoff(token, USER_ID, NOW)).toBeNull()
    expect(mockPostingExists).toHaveBeenCalledWith(expect.objectContaining({
      _id: JOB_ID,
      status: 'open',
      closedReason: { $exists: false },
    }))
  })

  it('requires archived ownership to survive the preparation await', async () => {
    const token = mintPracticeHandoffToken({ userId: USER_ID, jobId: JOB_ID, jdHash: HASH }, NOW)
    mockPostingFindById.mockReturnValue(selectLean({
      company: 'PhonePe',
      domain: 'backend',
      status: 'closed',
      closedReason: 'aged-out',
      jdCompressed: gzipSync(Buffer.from(JD)),
    }))
    mockApplicationExists.mockResolvedValueOnce(null)

    expect(await resolvePracticeHandoff(token, USER_ID, NOW)).toBeNull()
    expect(mockApplicationExists).toHaveBeenCalledWith({
      _id: 'app-canonical',
      userId: USER_ID,
      jobPostingId: JOB_ID,
    })
  })

  it('omits a live application identity deleted during preparation without blocking practice', async () => {
    const token = mintPracticeHandoffToken({ userId: USER_ID, jobId: JOB_ID, jdHash: HASH }, NOW)
    mockApplicationExists.mockResolvedValueOnce(null)

    const resolved = await resolvePracticeHandoff(token, USER_ID, NOW)

    expect(resolved).toMatchObject({ jobId: JOB_ID, jobDescription: DISPLAY_JD })
    expect(resolved?.applicationId).toBeUndefined()
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

  it('publishes Practice readiness at the JD boundary but keeps only canonical identity one character over', async () => {
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
    })).toEqual({
      jobDescription: overLimit,
      jdHash: practiceHandoffHashOf(overLimit),
    })
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
    const stale = await preparePracticeHandoffPosting({
      status: 'open',
      parsedJD: { inferredDomain: 'frontend' },
      parsedJDHash: 'stale-cache-hash',
      parsedJDRoleVersion: ACTIVE_CATALOG.revision,
      jdCompressed: gzipSync(Buffer.from(JD)),
    })
    const exact = await preparePracticeHandoffPosting({
      status: 'open',
      parsedJD: { inferredDomain: 'frontend' },
      parsedJDHash: xrayHashOf(JD),
      parsedJDRoleVersion: ACTIVE_CATALOG.revision,
      jdCompressed: gzipSync(Buffer.from(JD)),
    })

    expect(stale.role).toBeUndefined()
    expect(exact.role).toBe('frontend')
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

  it('keeps a same-JD historical inferred role usable for a normal archive after catalog revision drift', async () => {
    const prepared = await preparePracticeHandoffPosting({
      status: 'closed',
      closedReason: 'aged-out',
      jdCompressed: gzipSync(Buffer.from(JD)),
      parsedJD: { inferredDomain: ' Frontend ' },
      parsedJDHash: xrayHashOf(JD),
      parsedJDRoleVersion: 'jd-role-v2:previous-catalog',
    })

    expect(prepared).toEqual({
      jobDescription: JD,
      jdHash: HASH,
      role: 'frontend',
    })
  })

  it('does not revive a historical inferred role for restricted archives or a slug removed from the current catalog', async () => {
    const historical = {
      status: 'closed' as const,
      jdCompressed: gzipSync(Buffer.from(JD)),
      parsedJD: { inferredDomain: 'frontend' },
      parsedJDHash: xrayHashOf(JD),
      parsedJDRoleVersion: 'jd-role-v2:previous-catalog',
    }

    expect((await preparePracticeHandoffPosting({
      ...historical,
      closedReason: 'source-revoked',
    })).role).toBeUndefined()

    mockGetActiveCatalog.mockResolvedValue({
      ...ACTIVE_CATALOG,
      slugs: ['backend', 'general'],
      slugSet: new Set(['backend', 'general']),
      inferenceSlugSet: new Set(['backend', 'general']),
      revision: 'jd-role-v2:without-frontend',
    })
    expect((await preparePracticeHandoffPosting({
      ...historical,
      closedReason: 'aged-out',
    })).role).toBeUndefined()
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
