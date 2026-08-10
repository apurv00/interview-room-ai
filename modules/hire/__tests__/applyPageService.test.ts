/**
 * Public apply link. Two properties carry the security of this surface:
 * the raw token is never stored (only its sha256), and EVERY resolution
 * failure looks identical, so the URL space cannot be probed for which
 * employers or jobs exist.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
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
    applyPageEnabled: false,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockJob.updateOne.mockResolvedValue({ matchedCount: 1 })
  mockWorkspace.findOne.mockReturnValue({
    select: () => Promise.resolve({ name: 'Acme' }),
  })
  mockWorkspace.exists.mockResolvedValue({ _id: '111111111111111111111111' })
})

describe('issueApplyLink', () => {
  it('returns a raw token but stores ONLY its hash', async () => {
    const job = jobDoc()
    mockJob.findOne.mockResolvedValue(job)

    const { capability, enabled } = await issueApplyLink(CTX, 'job-1')
    const token = capability.split('.')[1]

    expect(enabled).toBe(true)
    expect(token).toMatch(/^[a-f0-9]{64}$/)
    expect(mockJob.updateOne.mock.calls[0][1]).toEqual({
      $set: {
        applyTokenHash: sha256(token),
        applyPageEnabled: true,
      },
    })
    // The raw value must never be persisted anywhere on the document.
    expect(JSON.stringify(mockJob.updateOne.mock.calls[0])).not.toContain(token)
  })

  it('rotating issues a DIFFERENT token, which is what kills the old link', async () => {
    mockJob.findOne.mockResolvedValue(jobDoc())

    const first = await issueApplyLink(CTX, 'job-1')
    const second = await issueApplyLink(CTX, 'job-1')

    expect(second.capability).not.toBe(first.capability)
    expect(mockJob.updateOne.mock.calls[1][1].$set.applyTokenHash).not.toBe(
      mockJob.updateOne.mock.calls[0][1].$set.applyTokenHash,
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
    })
    expect(mockJob.updateOne).toHaveBeenCalledWith(
      {
        _id: 'job-1',
        workspaceId: '111111111111111111111111',
        status: { $ne: 'closed' },
      },
      expect.any(Object),
      { runValidators: true },
    )
  })

  it('refuses the token when the job closes between read and atomic update', async () => {
    mockJob.findOne.mockResolvedValue(jobDoc())
    mockJob.updateOne.mockResolvedValue({ matchedCount: 0 })

    await expect(issueApplyLink(CTX, 'job-1')).rejects.toMatchObject({
      code: 'JOB_CLOSED',
    })
  })
})

describe('disableApplyLink', () => {
  it('clears the hash so the shared URL cannot resume', async () => {
    const job = jobDoc({ applyTokenHash: 'deadbeef', applyPageEnabled: true })
    mockJob.findOne.mockResolvedValue(job)

    await disableApplyLink(CTX, 'job-1')

    expect(mockJob.updateOne).toHaveBeenCalledWith(
      {
        _id: 'job-1',
        workspaceId: '111111111111111111111111',
      },
      {
        $set: { applyPageEnabled: false },
        $unset: { applyTokenHash: 1 },
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

  it('resolves a live link to its job + employer name', async () => {
    mockJob.findOne.mockResolvedValue(jobDoc({ applyPageEnabled: true }))
    const view = await resolveApplyToken(CAPABILITY)
    expect(view?.job.title).toBe('Backend Engineer')
    expect(view?.workspaceName).toBe('Acme')
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
