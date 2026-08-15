import crypto from 'crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '@shared/errors'

const IDS = {
  workspace: '1'.repeat(24),
  application: '2'.repeat(24),
  job: '3'.repeat(24),
  candidate: '4'.repeat(24),
  link: '5'.repeat(24),
  member: '6'.repeat(24),
}
const SECRET = 'ab'.repeat(32)
const MEMBER_NAME = 'Hiring manager'
const CAPABILITY = `${IDS.workspace}.${IDS.application}.${IDS.job}.${IDS.candidate}.${IDS.link}.${SECRET}`

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  resolveAuthority: vi.fn(),
  withTransaction: vi.fn(),
  claimCandidate: vi.fn(),
  applicationFindOne: vi.fn(),
  applicationExists: vi.fn(),
  jobExists: vi.fn(),
  candidateExists: vi.fn(),
  privacyExists: vi.fn(),
  privacyFilter: vi.fn(),
  linkFindOne: vi.fn(),
  linkCreate: vi.fn(),
  linkUpdateOne: vi.fn(),
  linkFindOneAndUpdate: vi.fn(),
  linkUpdateMany: vi.fn(),
  linkFind: vi.fn(),
}))

function query<T>(value: T) {
  return {
    session: vi.fn().mockResolvedValue(value),
    select: vi.fn().mockResolvedValue(value),
  }
}

function privacyRequestMatchesFilter(
  filter: Record<string, any>,
  request: { status: string; verificationExpiresAt: Date },
): boolean {
  if (filter.live !== true) return false
  if (!Array.isArray(filter.$or)) return true
  return filter.$or.some((condition: Record<string, any>) => {
    if (condition.status !== request.status) return false
    if (!condition.verificationExpiresAt) return true
    return request.verificationExpiresAt > condition.verificationExpiresAt.$gt
  })
}

vi.mock('@hire/models/HireApplication', () => ({
  HireApplication: {
    findOne: mocks.applicationFindOne,
    exists: mocks.applicationExists,
  },
}))
vi.mock('@hire/models/HireCandidate', () => ({
  HireCandidate: { exists: mocks.candidateExists },
}))
vi.mock('@hire/models/HireJob', () => ({
  HireJob: { exists: mocks.jobExists },
}))
vi.mock('@hire/models/HirePrivacyRequest', () => ({
  HirePrivacyRequest: { exists: mocks.privacyExists },
  activeHirePrivacyRequestFilter: mocks.privacyFilter,
}))
vi.mock('../models', () => ({
  HireCandidateStatusLink: {
    findOne: mocks.linkFindOne,
    create: mocks.linkCreate,
    updateOne: mocks.linkUpdateOne,
    findOneAndUpdate: mocks.linkFindOneAndUpdate,
    updateMany: mocks.linkUpdateMany,
    find: mocks.linkFind,
  },
}))
vi.mock('../services/hireStatusBoundary', () => ({
  connectHireStatusDB: mocks.connect,
  resolveCandidateStatusWorkspaceAuthority: mocks.resolveAuthority,
  withCandidateStatusLinkTransaction: mocks.withTransaction,
  claimCandidateStatusLinkPiiFence: mocks.claimCandidate,
  CandidateStatusLinkPiiTombstoneError: class CandidateStatusLinkPiiTombstoneError extends Error {},
}))

import {
  __candidateStatusLink,
  issueCandidateStatusLink,
  listCandidateStatusLinks,
  resolveCandidateStatusLink,
  revokeCandidateStatusLink,
} from '../services/candidateStatusLinkService'

function application(overrides: Record<string, unknown> = {}) {
  return {
    _id: { toString: () => IDS.application },
    jobId: { toString: () => IDS.job },
    candidateId: { toString: () => IDS.candidate },
    issuedByMemberId: { toString: () => IDS.member },
    issuedByName: MEMBER_NAME,
    issuedByMemberId: { toString: () => IDS.member },
    issuedByName: MEMBER_NAME,
    stage: 'interviewing',
    candidateEmail: 'must-not-leak@example.com',
    decisionNote: 'internal decision note',
    ...overrides,
  }
}

function link(overrides: Record<string, unknown> = {}) {
  return {
    _id: { toString: () => IDS.link },
    workspaceId: { toString: () => IDS.workspace },
    applicationId: { toString: () => IDS.application },
    jobId: { toString: () => IDS.job },
    candidateId: { toString: () => IDS.candidate },
    issuanceOperationId: '11111111-1111-4111-8111-111111111111',
    secretHash: crypto.createHash('sha256').update(SECRET).digest('hex'),
    issuedAt: new Date('2099-08-14T10:00:00.000Z'),
    expiresAt: new Date('2099-09-13T10:00:00.000Z'),
    active: true,
    status: 'active',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.resolveAuthority.mockResolvedValue({ toString: () => IDS.member })
  mocks.withTransaction.mockImplementation(
    async (_workspace: unknown, _member: unknown, work: (session: object) => unknown) => work({}),
  )
  mocks.claimCandidate.mockResolvedValue(undefined)
  mocks.applicationFindOne.mockReturnValue(query(application()))
  mocks.applicationExists.mockResolvedValue({ _id: IDS.application })
  mocks.jobExists.mockReturnValue(query({ _id: IDS.job }))
  mocks.candidateExists.mockReturnValue(query({ _id: IDS.candidate }))
  mocks.privacyExists.mockReturnValue(query(null))
  mocks.privacyFilter.mockImplementation((now: Date) => ({
    live: true,
    $or: [
      { status: 'processing' },
      { status: 'pending_verification', verificationExpiresAt: { $gt: now } },
    ],
  }))
  mocks.linkUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.linkUpdateMany.mockResolvedValue({ modifiedCount: 1 })
  mocks.linkFind.mockReturnValue({ sort: vi.fn().mockResolvedValue([link()]) })
})

describe('candidate status-link service', () => {
  it('creates a distinct fragment URL and persists only a SHA-256 secret hash', async () => {
    mocks.linkFindOne.mockResolvedValueOnce(null)
    mocks.linkCreate.mockImplementation(async (rows: any[]) => [
      { ...rows[0], _id: { toString: () => IDS.link } },
    ])
    mocks.privacyExists.mockImplementation((filter: Record<string, any>) => query(
      privacyRequestMatchesFilter(filter, {
        status: 'pending_verification',
        verificationExpiresAt: new Date('2026-08-14T00:00:00.000Z'),
      }) ? { _id: 'expired-verification' } : null,
    ))
    vi.stubEnv('HIRE_PUBLIC_URL', 'https://hire.example/')
    const result = await issueCandidateStatusLink(
      { workspaceId: IDS.workspace, memberId: IDS.member, memberName: MEMBER_NAME },
      {
        applicationId: IDS.application,
        operationId: '11111111-1111-4111-8111-111111111111',
      },
    )
    expect(result.created).toBe(true)
    expect(result.statusUrl).toMatch(/^https:\/\/hire\.example\/candidate-status\//)
    expect(result.statusUrl).toContain('#status=')
    const created = mocks.linkCreate.mock.calls[0]?.[0]?.[0]
    const secret = decodeURIComponent(result.statusUrl!.split('#status=')[1]).split('.')[5]
    expect(created.secretHash).toBe(crypto.createHash('sha256').update(secret).digest('hex'))
    expect(created).toMatchObject({
      issuedByMemberId: expect.anything(),
      issuedByName: MEMBER_NAME,
    })
    expect(JSON.stringify(created)).not.toContain(secret)
    expect(mocks.claimCandidate).toHaveBeenCalledOnce()
    expect(mocks.privacyExists).toHaveBeenCalledWith(expect.objectContaining({
      live: true,
      $or: [
        { status: 'processing' },
        {
          status: 'pending_verification',
          verificationExpiresAt: { $gt: expect.any(Date) },
        },
      ],
    }))
  })

  it('does not reconstruct a raw capability on an idempotent retry', async () => {
    mocks.linkFindOne.mockResolvedValueOnce(link())
    await expect(
      issueCandidateStatusLink(
        { workspaceId: IDS.workspace, memberId: IDS.member, memberName: MEMBER_NAME },
        {
          applicationId: IDS.application,
          operationId: '11111111-1111-4111-8111-111111111111',
        },
      ),
    ).resolves.toMatchObject({
      created: false,
      statusUrl: null,
      link: { id: IDS.link },
    })
    expect(mocks.linkCreate).not.toHaveBeenCalled()
  })

  it('keeps a processing privacy request fail-closed for status-link issuance', async () => {
    mocks.linkFindOne.mockResolvedValue(null)
    mocks.privacyExists.mockImplementation((filter: Record<string, any>) => query(
      privacyRequestMatchesFilter(filter, {
        status: 'processing',
        verificationExpiresAt: new Date('2026-08-16T00:00:00.000Z'),
      }) ? { _id: 'processing' } : null,
    ))

    await expect(issueCandidateStatusLink(
      { workspaceId: IDS.workspace, memberId: IDS.member, memberName: MEMBER_NAME },
      {
        applicationId: IDS.application,
        operationId: '22222222-2222-4222-8222-222222222222',
      },
    )).rejects.toMatchObject({ code: 'CANDIDATE_PRIVACY_PENDING' })
    expect(mocks.linkCreate).not.toHaveBeenCalled()
    expect(mocks.claimCandidate).not.toHaveBeenCalled()
  })

  it('lists only the bounded member lifecycle DTO for one workspace application', async () => {
    await expect(
      listCandidateStatusLinks({
        workspaceId: IDS.workspace,
        applicationId: IDS.application,
      }),
    ).resolves.toEqual([
      {
        id: IDS.link,
        applicationId: IDS.application,
        active: true,
        expiresAt: new Date('2099-09-13T10:00:00.000Z'),
        revokedAt: null,
      },
    ])
  })

  it('validates issuance input before creating a record', async () => {
    await expect(
      issueCandidateStatusLink(
        { workspaceId: IDS.workspace, memberId: IDS.member, memberName: MEMBER_NAME },
        {
          applicationId: IDS.application,
          operationId: 'not-a-uuid',
          expiresInDays: 91,
        },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS_LINK_INPUT' })
    expect(mocks.withTransaction).not.toHaveBeenCalled()
  })

  it('rejects a missing or oversized actor snapshot before opening a transaction', async () => {
    await expect(
      issueCandidateStatusLink(
        { workspaceId: IDS.workspace, memberId: IDS.member, memberName: '   ' },
        {
          applicationId: IDS.application,
          operationId: '11111111-1111-4111-8111-111111111111',
        },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ACTOR' })
    expect(mocks.withTransaction).not.toHaveBeenCalled()
  })

  it('keeps a public status link active after an expired unverified privacy request', async () => {
    mocks.linkFindOne.mockReturnValue({
      select: vi.fn().mockResolvedValue(link()),
    })
    mocks.privacyExists.mockImplementation((filter: Record<string, any>) => query(
      privacyRequestMatchesFilter(filter, {
        status: 'pending_verification',
        verificationExpiresAt: new Date('2026-08-14T00:00:00.000Z'),
      }) ? { _id: 'expired-verification' } : null,
    ))
    const result = await resolveCandidateStatusLink({
      linkId: IDS.link,
      capability: CAPABILITY,
    })
    expect(result).toEqual({
      phase: 'interviewing',
      progress: { current: 2, total: 3 },
    })
    expect(JSON.stringify(result)).not.toContain('must-not-leak')
    expect(JSON.stringify(result)).not.toContain('internal decision')
    expect(result).not.toHaveProperty('stage')
    expect(result).not.toHaveProperty('applicationId')
    expect(mocks.privacyExists).toHaveBeenCalledWith(expect.objectContaining({
      live: true,
      $or: [
        { status: 'processing' },
        {
          status: 'pending_verification',
          verificationExpiresAt: { $gt: expect.any(Date) },
        },
      ],
    }))
    expect(mocks.linkFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: IDS.link,
        workspaceId: IDS.workspace,
        applicationId: IDS.application,
        jobId: IDS.job,
        candidateId: IDS.candidate,
        secretHash: crypto.createHash('sha256').update(SECRET).digest('hex'),
      }),
      null,
      expect.anything(),
    )
    expect(mocks.claimCandidate).toHaveBeenCalledOnce()
  })

  it.each([
    [
      'malformed capability',
      () => resolveCandidateStatusLink({ linkId: IDS.link, capability: 'bad' }),
    ],
    [
      'route/link coordinate mismatch',
      () =>
        resolveCandidateStatusLink({
          linkId: IDS.application,
          capability: CAPABILITY,
        }),
    ],
    [
      'expired, revoked, or unknown row',
      () => {
        mocks.linkFindOne.mockReturnValue({
          select: vi.fn().mockResolvedValue(null),
        })
        return resolveCandidateStatusLink({
          linkId: IDS.link,
          capability: CAPABILITY,
        })
      },
    ],
    [
      'workspace authority race',
      () => {
        mocks.withTransaction.mockRejectedValueOnce(
          new AppError('gone', 410, 'WORKSPACE_DELETION_PENDING'),
        )
        return resolveCandidateStatusLink({
          linkId: IDS.link,
          capability: CAPABILITY,
        })
      },
    ],
    [
      'a mismatched persistent coordinate',
      () => {
        mocks.linkFindOne.mockReturnValue({
          select: vi.fn().mockResolvedValue(null),
        })
        return resolveCandidateStatusLink({
          linkId: IDS.link,
          capability: CAPABILITY.replace(IDS.candidate, '7'.repeat(24)),
        })
      },
    ],
  ])('returns the same inactive result for %s', async (_label, resolve) => {
    await expect(resolve()).resolves.toBeNull()
  })

  it('revocation clears the capability digest', async () => {
    mocks.linkFindOneAndUpdate.mockResolvedValue(
      link({
        active: false,
        status: 'revoked',
        revokedAt: new Date('2099-08-15T10:00:00.000Z'),
        secretHash: undefined,
      }),
    )
    await expect(
      revokeCandidateStatusLink({
        authority: {
          workspaceId: IDS.workspace,
          memberId: IDS.member,
          memberName: MEMBER_NAME,
        },
        linkId: IDS.link,
      }),
    ).resolves.toMatchObject({ active: false, revokedAt: expect.any(Date) })
    expect(mocks.linkFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ active: true, status: 'active' }),
      expect.objectContaining({
        $set: expect.objectContaining({
          revokedByMemberId: expect.anything(),
          revokedByName: MEMBER_NAME,
        }),
        $unset: { secretHash: 1 },
      }),
      expect.anything(),
    )
  })

  it('treats a privacy request as the same inactive public outcome', async () => {
    mocks.linkFindOne.mockReturnValue({
      select: vi.fn().mockResolvedValue(link()),
    })
    mocks.privacyExists.mockImplementation((filter: Record<string, any>) => query(
      privacyRequestMatchesFilter(filter, {
        status: 'processing',
        verificationExpiresAt: new Date('2026-08-16T00:00:00.000Z'),
      }) ? { _id: 'processing' } : null,
    ))
    await expect(
      resolveCandidateStatusLink({ linkId: IDS.link, capability: CAPABILITY }),
    ).resolves.toBeNull()
    expect(mocks.claimCandidate).not.toHaveBeenCalled()
  })

  it('exposes a transaction-only lifecycle revoke port that clears every matching hash', async () => {
    const { revokeCandidateStatusLinksForScope } =
      await import('../services/candidateStatusLinkService')
    await revokeCandidateStatusLinksForScope({
      workspaceId: { toString: () => IDS.workspace } as any,
      candidateId: { toString: () => IDS.candidate } as any,
      reason: 'Privacy deletion',
      at: new Date('2099-08-15T10:00:00.000Z'),
      session: {} as any,
    })
    expect(mocks.linkUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: expect.anything(),
        candidateId: expect.anything(),
        active: true,
      }),
      expect.objectContaining({ $unset: { secretHash: 1 } }),
      expect.anything(),
    )
  })

  it('rejects an accidental workspace-wide call through the narrow lifecycle port', async () => {
    const { revokeCandidateStatusLinksForScope } =
      await import('../services/candidateStatusLinkService')
    await expect(
      revokeCandidateStatusLinksForScope({
        workspaceId: { toString: () => IDS.workspace } as any,
        reason: 'Workspace deletion',
        at: new Date('2099-08-15T10:00:00.000Z'),
        session: {} as any,
      }),
    ).rejects.toThrow('requires a candidate or application scope')
    expect(mocks.linkUpdateMany).not.toHaveBeenCalled()
  })

  it('requires a separate explicit workspace-wide lifecycle call', async () => {
    const { revokeCandidateStatusLinksForWorkspace } =
      await import('../services/candidateStatusLinkService')
    await revokeCandidateStatusLinksForWorkspace({
      workspaceId: { toString: () => IDS.workspace } as any,
      reason: 'Workspace deletion',
      at: new Date('2099-08-15T10:00:00.000Z'),
      session: {} as any,
    })
    expect(mocks.linkUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: expect.anything(),
        active: true,
      }),
      expect.objectContaining({ $unset: { secretHash: 1 } }),
      expect.anything(),
    )
    const [filter] = mocks.linkUpdateMany.mock.calls[0]
    expect(filter).not.toHaveProperty('candidateId')
    expect(filter).not.toHaveProperty('applicationId')
  })

  it('maps terminal internal stages to one neutral phase', () => {
    expect(__candidateStatusLink.serializeCandidateStatus('hired')).toEqual({
      phase: 'concluded',
      progress: { current: 3, total: 3 },
    })
    expect(__candidateStatusLink.serializeCandidateStatus('rejected')).toEqual({
      phase: 'concluded',
      progress: { current: 3, total: 3 },
    })
  })
})
