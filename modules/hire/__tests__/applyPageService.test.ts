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

const mockJob = { findOne: vi.fn() }
const mockWorkspace = { findById: vi.fn() }
const mockMember = { find: vi.fn() }
const accountActiveMock = vi.fn()

vi.mock('@shared/services/jobsAccountFence', () => ({
  isJobsAccountActive: (...a: unknown[]) => accountActiveMock(...a),
}))

vi.mock('../models', async () => {
  const actual = await vi.importActual<typeof import('../models')>('../models')
  return {
    ...actual,
    HireJob: { findOne: (...a: unknown[]) => mockJob.findOne(...a) },
    HireWorkspace: { findById: (...a: unknown[]) => mockWorkspace.findById(...a) },
    HireWorkspaceMember: { find: (...a: unknown[]) => mockMember.find(...a) },
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
  workspace: { _id: 'ws-A', name: 'Acme' },
  membership: { _id: 'm1', userId: 'u1', email: 'hr@acme.com', name: 'HR', role: 'admin' },
} as unknown as MembershipContext

function jobDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'job-1',
    workspaceId: 'ws-A',
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
  mockWorkspace.findById.mockReturnValue({ select: () => Promise.resolve({ name: 'Acme' }) })
})

describe('issueApplyLink', () => {
  it('returns a raw token but stores ONLY its hash', async () => {
    const job = jobDoc()
    mockJob.findOne.mockResolvedValue(job)

    const { token, enabled } = await issueApplyLink(CTX, 'job-1')

    expect(enabled).toBe(true)
    expect(token).toMatch(/^[a-f0-9]{64}$/)
    expect(job.applyTokenHash).toBe(sha256(token))
    // The raw value must never be persisted anywhere on the document.
    expect(JSON.stringify(job)).not.toContain(token)
    expect(job.applyPageEnabled).toBe(true)
  })

  it('rotating issues a DIFFERENT token, which is what kills the old link', async () => {
    const job = jobDoc()
    mockJob.findOne.mockResolvedValue(job)

    const first = await issueApplyLink(CTX, 'job-1')
    const firstHash = job.applyTokenHash
    const second = await issueApplyLink(CTX, 'job-1')

    expect(second.token).not.toBe(first.token)
    expect(job.applyTokenHash).not.toBe(firstHash)
  })

  it('refuses a closed job', async () => {
    mockJob.findOne.mockResolvedValue(jobDoc({ status: 'closed' }))
    await expect(issueApplyLink(CTX, 'job-1')).rejects.toMatchObject({ code: 'JOB_CLOSED' })
  })

  it('is workspace-scoped — the query carries the tenancy id', async () => {
    mockJob.findOne.mockResolvedValue(jobDoc())
    await issueApplyLink(CTX, 'job-1')
    expect(mockJob.findOne).toHaveBeenCalledWith({ _id: 'job-1', workspaceId: 'ws-A' })
  })
})

describe('disableApplyLink', () => {
  it('clears the hash so the shared URL cannot resume', async () => {
    const job = jobDoc({ applyTokenHash: 'deadbeef', applyPageEnabled: true })
    mockJob.findOne.mockResolvedValue(job)

    await disableApplyLink(CTX, 'job-1')

    expect(job.applyPageEnabled).toBe(false)
    expect(job.applyTokenHash).toBeUndefined()
    expect(job.save).toHaveBeenCalled()
  })
})

describe('resolveApplyToken — uniform failure (no enumeration)', () => {
  const RAW = 'a'.repeat(64)

  it('looks the job up by HASH, never by the raw token', async () => {
    mockJob.findOne.mockResolvedValue(jobDoc({ applyPageEnabled: true }))
    await resolveApplyToken(RAW)
    const query = mockJob.findOne.mock.calls[0][0]
    expect(query.applyTokenHash).toBe(sha256(RAW))
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
    expect(await resolveApplyToken(RAW)).toBe(null)
  })

  it('returns null when the owning workspace is gone', async () => {
    mockJob.findOne.mockResolvedValue(jobDoc({ applyPageEnabled: true }))
    mockWorkspace.findById.mockReturnValue({ select: () => Promise.resolve(null) })
    expect(await resolveApplyToken(RAW)).toBe(null)
  })

  it('resolves a live link to its job + employer name', async () => {
    mockJob.findOne.mockResolvedValue(jobDoc({ applyPageEnabled: true }))
    const view = await resolveApplyToken(RAW)
    expect(view?.job.title).toBe('Backend Engineer')
    expect(view?.workspaceName).toBe('Acme')
  })
})


describe('resolveWorkspaceWriteAuthority — survives the creator deleting their account', () => {
  function members(list: Array<{ userId: string; role: string }>) {
    return { sort: () => Promise.resolve(list) }
  }

  it('returns the first member whose account is still active', async () => {
    mockMember.find.mockReturnValue(
      members([
        { userId: 'admin-gone', role: 'admin' },
        { userId: 'member-live', role: 'member' },
      ]),
    )
    accountActiveMock.mockImplementation(async (id: string) => id === 'member-live')

    // The job's original creator may be long deleted: the authority is
    // whoever still exists, so the apply link keeps working (Codex P1 #615).
    await expect(resolveWorkspaceWriteAuthority('ws-A' as never)).resolves.toBe('member-live')
  })

  it('returns null when NO member account survives — caller must stop accepting', async () => {
    mockMember.find.mockReturnValue(members([{ userId: 'gone', role: 'admin' }]))
    accountActiveMock.mockResolvedValue(false)
    await expect(resolveWorkspaceWriteAuthority('ws-A' as never)).resolves.toBe(null)
  })

  it('only considers members already linked to a user id', async () => {
    mockMember.find.mockReturnValue(members([]))
    accountActiveMock.mockResolvedValue(true)
    await resolveWorkspaceWriteAuthority('ws-A' as never)
    expect(mockMember.find.mock.calls[0][0]).toMatchObject({ userId: { $exists: true } })
  })
})
