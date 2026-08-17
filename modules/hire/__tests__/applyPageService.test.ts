/**
 * Public apply links keep a hidden raw secret so authorized workspace members
 * can retrieve the same URL, while public resolution continues to use only
 * the hash and remains non-enumerable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '@shared/errors'

const onboarding = vi.hoisted(() => ({
  writeIsolation: vi.fn(),
  isTestDriveCoordinate: vi.fn(),
}))
vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../services/hireWorkspaceWriteFence', () => ({
  withActiveHireWorkspaceWriteTransaction: async (
    _workspaceId: unknown,
    _memberId: unknown,
    work: (session: unknown) => Promise<unknown>,
  ) => work({ id: 'apply-link-session' }),
}))

vi.mock('@hire-onboarding-boundary', () => ({
  assertHireOnboardingTestDriveWriteIsolation: (...args: unknown[]) =>
    onboarding.writeIsolation(...args),
  isHireOnboardingTestDriveCoordinate: (...args: unknown[]) =>
    onboarding.isTestDriveCoordinate(...args),
}))

const mockJob = { findOne: vi.fn(), updateOne: vi.fn() }
const mockWorkspace = { findOne: vi.fn(), exists: vi.fn() }
const mockMember = { findOne: vi.fn() }

vi.mock('../models', async () => {
  const actual = await vi.importActual<typeof import('../models')>('../models')
  return {
    ...actual,
    HireJob: {
      findOne: (...a: unknown[]) => mockJob.findOne(...a),
      updateOne: (...a: unknown[]) => mockJob.updateOne(...a),
    },
    HireWorkspace: {
      findOne: (...a: unknown[]) => mockWorkspace.findOne(...a),
      exists: (...a: unknown[]) => mockWorkspace.exists(...a),
    },
    HireWorkspaceMember: {
      findOne: (...a: unknown[]) => mockMember.findOne(...a),
    },
  }
})

import {
  issueApplyLink,
  disableApplyLink,
  recoverApplyLink,
  resolveApplyToken,
  resolveWorkspaceWriteAuthority,
  sha256,
} from '../services/applyPageService'
import type { MembershipContext } from '../services/workspaceService'

const CTX = {
  workspace: { _id: '111111111111111111111111', name: 'Acme' },
  membership: {
    _id: 'm1',
    userId: 'u1',
    email: 'hr@acme.com',
    name: 'HR',
    role: 'admin',
  },
} as unknown as MembershipContext

function jobDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'job-1',
    workspaceId: '111111111111111111111111',
    title: 'Backend Engineer',
    status: 'open',
    applyTokenHash: undefined as string | undefined,
    applyTokenSecret: undefined as string | undefined,
    applyPageEnabled: false,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  onboarding.writeIsolation.mockResolvedValue(undefined)
  onboarding.isTestDriveCoordinate.mockResolvedValue(false)
  mockJob.updateOne.mockResolvedValue({ matchedCount: 1 })
  mockWorkspace.findOne.mockReturnValue({
    select: () => Promise.resolve({
      name: 'Acme',
      companyDescription: 'Acme builds reliable workflow software for operations teams.',
    }),
  })
  mockWorkspace.exists.mockResolvedValue({ _id: '111111111111111111111111' })
})

describe('issueApplyLink', () => {
  it('returns a raw token and stores it in the hidden recovery field with its hash', async () => {
    const job = jobDoc()
    mockJob.findOne.mockResolvedValue(job)

    const { capability, enabled } = await issueApplyLink(CTX, 'job-1')
    const token = capability.split('.')[1]

    expect(enabled).toBe(true)
    expect(token).toMatch(/^[a-f0-9]{64}$/)
    expect(mockJob.updateOne.mock.calls[0][1]).toMatchObject({
      $set: {
        applyTokenHash: sha256(token),
        applyTokenSecret: token,
        applyPageEnabled: true,
      },
    })
    expect(onboarding.writeIsolation).toHaveBeenCalledWith({
      workspaceId: '111111111111111111111111',
      jobId: 'job-1',
      session: { id: 'apply-link-session' },
    })
  })

  it('rotating issues a DIFFERENT token, which is what kills the old link', async () => {
    mockJob.findOne.mockResolvedValue(jobDoc())

    const first = await issueApplyLink(CTX, 'job-1')
    const second = await issueApplyLink(CTX, 'job-1')

    expect(second.capability).not.toBe(first.capability)
    expect(mockJob.updateOne.mock.calls[1][1].$set.applyTokenHash).not.toBe(
      mockJob.updateOne.mock.calls[0][1].$set.applyTokenHash,
    )
    expect(mockJob.updateOne.mock.calls[1][1].$set.applyTokenSecret).not.toBe(
      mockJob.updateOne.mock.calls[0][1].$set.applyTokenSecret,
    )
  })

  it('refuses a closed job', async () => {
    mockJob.findOne.mockResolvedValue(jobDoc({ status: 'closed' }))
    await expect(issueApplyLink(CTX, 'job-1')).rejects.toMatchObject({
      code: 'JOB_CLOSED',
    })
  })

  it('is workspace-scoped — the query carries the tenancy id', async () => {
    mockJob.findOne.mockResolvedValue(jobDoc())
    await issueApplyLink(CTX, 'job-1')
    expect(mockJob.findOne).toHaveBeenCalledWith({
        _id: 'job-1',
        workspaceId: '111111111111111111111111',
      },
      null,
      { session: { id: 'apply-link-session' } },
    )
    expect(mockJob.updateOne).toHaveBeenCalledWith(
      {
        _id: 'job-1',
        workspaceId: '111111111111111111111111',
        status: { $ne: 'closed' },
      },
      expect.any(Object),
      { runValidators: true, session: { id: 'apply-link-session' } },
    )
  })

  it('refuses the token when the job closes between read and atomic update', async () => {
    mockJob.findOne.mockResolvedValue(jobDoc())
    mockJob.updateOne.mockResolvedValue({ matchedCount: 0 })

    await expect(issueApplyLink(CTX, 'job-1')).rejects.toMatchObject({
      code: 'JOB_CLOSED',
    })
  })

  it('rejects a synthetic practice job before persisting an apply capability', async () => {
    onboarding.writeIsolation.mockRejectedValue(
      new AppError('Practice interviews are isolated', 409, 'ONBOARDING_TEST_DRIVE_ISOLATED'),
    )

    await expect(issueApplyLink(CTX, 'job-1')).rejects.toMatchObject({
      code: 'ONBOARDING_TEST_DRIVE_ISOLATED',
    })
    expect(mockJob.findOne).not.toHaveBeenCalled()
    expect(mockJob.updateOne).not.toHaveBeenCalled()
  })
})

describe('recoverApplyLink', () => {
  it('returns the same active capability from the hidden stored secret', async () => {
    mockJob.findOne.mockResolvedValueOnce(jobDoc())
    const issued = await issueApplyLink(CTX, 'job-1')
    const stored = mockJob.updateOne.mock.calls[0][1].$set
    const selected = vi.fn().mockResolvedValue(jobDoc({
      applyPageEnabled: true,
      applyTokenHash: stored.applyTokenHash,
      applyTokenSecret: stored.applyTokenSecret,
    }))
    mockJob.findOne.mockReturnValueOnce({ select: selected })

    await expect(recoverApplyLink(CTX, 'job-1')).resolves.toBe(issued.capability)
    expect(mockJob.findOne).toHaveBeenLastCalledWith(
      {
        _id: 'job-1',
        workspaceId: '111111111111111111111111',
      },
    )
    expect(selected).toHaveBeenCalledWith('+applyTokenSecret')
  })

  it('treats active legacy hash-only links as not recoverable', async () => {
    mockJob.findOne.mockReturnValueOnce({
      select: vi.fn().mockResolvedValue(jobDoc({
        applyPageEnabled: true,
        applyTokenHash: 'a'.repeat(64),
      })),
    })

    await expect(recoverApplyLink(CTX, 'job-1')).resolves.toBeNull()
  })

  it('does not recover a disabled or closed public link', async () => {
    mockJob.findOne.mockReturnValueOnce({
      select: vi.fn().mockResolvedValue(jobDoc({
        status: 'closed',
        applyPageEnabled: true,
        applyTokenHash: 'a'.repeat(64),
      })),
    })

    await expect(recoverApplyLink(CTX, 'job-1')).resolves.toBeNull()
  })
})

describe('disableApplyLink', () => {
  it('clears both the hash and hidden raw secret so the shared URL cannot resume', async () => {
    await disableApplyLink(CTX, 'job-1')

    expect(mockJob.updateOne).toHaveBeenCalledWith(
      {
        _id: 'job-1',
        workspaceId: '111111111111111111111111',
      },
      {
        $set: { applyPageEnabled: false },
        $unset: { applyTokenHash: 1, applyTokenSecret: 1 },
      },
      { runValidators: true },
    )
  })
})

describe('resolveApplyToken — uniform failure (no enumeration)', () => {
  const RAW = 'a'.repeat(64)
  const CAPABILITY = `111111111111111111111111.${RAW}`

  it('looks the job up by HASH, never by the raw token', async () => {
    mockJob.findOne.mockResolvedValue(jobDoc({ applyPageEnabled: true }))
    await resolveApplyToken(CAPABILITY)
    const query = mockJob.findOne.mock.calls[0][0]
    expect(query.applyTokenHash).toBe(sha256(RAW))
    expect(query.workspaceId).toBe('111111111111111111111111')
    // Disabled pages and closed jobs are excluded in the query itself.
    expect(query.applyPageEnabled).toBe(true)
    expect(query.status).toEqual({ $ne: 'closed' })
  })

  it('returns null for a malformed token without touching the database', async () => {
    expect(await resolveApplyToken('short')).toBe(null)
    expect(await resolveApplyToken('../../etc/passwd')).toBe(null)
    expect(mockJob.findOne).not.toHaveBeenCalled()
  })

  it('returns null — indistinguishably — when no job matches', async () => {
    mockJob.findOne.mockResolvedValue(null)
    expect(await resolveApplyToken(CAPABILITY)).toBe(null)
  })

  it('returns null when the owning workspace is gone', async () => {
    mockJob.findOne.mockResolvedValue(jobDoc({ applyPageEnabled: true }))
    mockWorkspace.findOne.mockReturnValue({
      select: () => Promise.resolve(null),
    })
    expect(await resolveApplyToken(CAPABILITY)).toBe(null)
  })

  it('returns null for a retained synthetic practice marker without probing the workspace', async () => {
    mockJob.findOne.mockResolvedValue(jobDoc({ applyPageEnabled: true }))
    onboarding.isTestDriveCoordinate.mockResolvedValue(true)

    await expect(resolveApplyToken(CAPABILITY)).resolves.toBeNull()
    expect(onboarding.isTestDriveCoordinate).toHaveBeenCalledWith({
      workspaceId: '111111111111111111111111',
      jobId: 'job-1',
    })
    expect(mockWorkspace.findOne).not.toHaveBeenCalled()
  })

  it('requires an active workspace, including compatibility for legacy rows', async () => {
    mockJob.findOne.mockResolvedValue(jobDoc({ applyPageEnabled: true }))
    await resolveApplyToken(CAPABILITY)
    expect(mockWorkspace.findOne).toHaveBeenCalledWith({
      _id: '111111111111111111111111',
      $or: [
        { lifecycleState: 'active' },
        { lifecycleState: { $exists: false } },
      ],
    })
  })

  it('resolves a live link to its job + canonical company identity context', async () => {
    mockJob.findOne.mockResolvedValue(jobDoc({ applyPageEnabled: true }))
    const view = await resolveApplyToken(CAPABILITY)
    expect(view?.job.title).toBe('Backend Engineer')
    expect(view?.workspaceName).toBe('Acme')
    expect(view?.companyDescription).toBe(
      'Acme builds reliable workflow software for operations teams.',
    )
  })
})

describe('resolveWorkspaceWriteAuthority — Hire-owned member authority', () => {
  function member(value: { _id: string; role: string } | null) {
    return { sort: () => Promise.resolve(value) }
  }

  it('returns an active Hire member without resolving a B2C User', async () => {
    mockMember.findOne.mockReturnValue(
      member({ _id: 'member-live', role: 'member' }),
    )

    await expect(resolveWorkspaceWriteAuthority('ws-A' as never)).resolves.toBe(
      'member-live',
    )
    expect(mockMember.findOne.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws-A',
      authState: 'active',
    })
  })

  it('returns null when no active Hire member survives', async () => {
    mockMember.findOne.mockReturnValue(member(null))
    await expect(resolveWorkspaceWriteAuthority('ws-A' as never)).resolves.toBe(
      null,
    )
  })

  it('returns null before member lookup when the workspace is tombstoned', async () => {
    mockWorkspace.exists.mockResolvedValue(null)

    await expect(resolveWorkspaceWriteAuthority('ws-A' as never)).resolves.toBe(
      null,
    )
    expect(mockMember.findOne).not.toHaveBeenCalled()
  })
})
