import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyOptionIdOf } from '../services/applyOptionIdentity'

const {
  mockFindOne,
  mockRead,
  mockSelect,
  mockLean,
  mockIsJobsAccountActive,
} = vi.hoisted(() => ({
  mockFindOne: vi.fn(),
  mockRead: vi.fn(),
  mockSelect: vi.fn(),
  mockLean: vi.fn(),
  mockIsJobsAccountActive: vi.fn(),
}))

vi.mock('@shared/db/models', () => ({
  JobPosting: { findOne: mockFindOne },
}))

vi.mock('@shared/services/jobsAccountFence', () => ({
  JobsAccountInactiveError: class JobsAccountInactiveError extends Error {
    constructor(public readonly userId: string) {
      super('account is missing or being deleted')
    }
  },
  isJobsAccountActive: mockIsJobsAccountActive,
}))

import { JobsAccountInactiveError } from '@shared/services/jobsAccountFence'
import { resolveLiveApplyRedirect } from '../services/applyRedirectService'

const USER_ID = '507f1f77bcf86cd799439001'
const POSTING_ID = '507f1f77bcf86cd799439011'
const SOURCE = {
  sourceKey: 'greenhouse:acme:123',
  applyUrl: 'https://boards.greenhouse.io/acme/jobs/123',
  applyTier: 'direct-ats' as const,
  viaSite: 'Greenhouse',
}
const OPTION_ID = applyOptionIdOf({
  sourceKey: SOURCE.sourceKey,
  url: SOURCE.applyUrl,
  tier: SOURCE.applyTier,
})

beforeEach(() => {
  mockFindOne.mockReset().mockReturnValue({ read: mockRead })
  mockRead.mockReset().mockReturnValue({ select: mockSelect })
  mockSelect.mockReset().mockReturnValue({ lean: mockLean })
  mockLean.mockReset().mockResolvedValue({ provenance: [SOURCE] })
  mockIsJobsAccountActive.mockReset().mockResolvedValue(true)
})

describe('resolveLiveApplyRedirect', () => {
  it('returns only a safe option resolved from the current live posting', async () => {
    await expect(resolveLiveApplyRedirect(USER_ID, POSTING_ID, OPTION_ID))
      .resolves.toBe(SOURCE.applyUrl)

    expect(mockFindOne).toHaveBeenCalledWith({ _id: POSTING_ID, status: 'open' })
    expect(mockRead).toHaveBeenCalledWith('primary')
    expect(mockSelect).toHaveBeenCalledWith({ provenance: 1 })
    expect(mockIsJobsAccountActive).toHaveBeenCalledTimes(2)
  })

  it('rejects a source-revoked posting because the live read no longer matches', async () => {
    mockLean.mockResolvedValueOnce(null)

    await expect(resolveLiveApplyRedirect(USER_ID, POSTING_ID, OPTION_ID))
      .resolves.toBeNull()
  })

  it('rejects an opaque id after its canonical option is replaced', async () => {
    mockLean.mockResolvedValueOnce({
      provenance: [{ ...SOURCE, applyUrl: 'https://boards.greenhouse.io/acme/jobs/456' }],
    })

    await expect(resolveLiveApplyRedirect(USER_ID, POSTING_ID, OPTION_ID))
      .resolves.toBeNull()
  })

  it('fails closed when the account is inactive before or after resolution', async () => {
    mockIsJobsAccountActive.mockResolvedValueOnce(false)
    await expect(resolveLiveApplyRedirect(USER_ID, POSTING_ID, OPTION_ID))
      .rejects.toBeInstanceOf(JobsAccountInactiveError)
    expect(mockFindOne).not.toHaveBeenCalled()

    mockIsJobsAccountActive.mockReset()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    await expect(resolveLiveApplyRedirect(USER_ID, POSTING_ID, OPTION_ID))
      .rejects.toBeInstanceOf(JobsAccountInactiveError)
  })
})
