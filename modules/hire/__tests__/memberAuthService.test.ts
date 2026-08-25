import { beforeEach, describe, expect, it, vi } from 'vitest'
import mongoose from 'mongoose'

const mocks = vi.hoisted(() => ({
  connectHireControlDB: vi.fn(),
  compare: vi.fn(),
  hash: vi.fn(),
  findMember: vi.fn(),
  findMemberAndUpdate: vi.fn(),
  findWorkspace: vi.fn(),
  findSession: vi.fn(),
  findSetup: vi.fn(),
  updateSetup: vi.fn(),
  createSession: vi.fn(),
  updateSession: vi.fn(),
}))

vi.mock('bcryptjs', () => ({
  default: {
    compare: (...args: unknown[]) => mocks.compare(...args),
    hash: (...args: unknown[]) => mocks.hash(...args),
  },
}))

vi.mock('../services/hireControlBoundary', () => ({
  connectHireControlDB: (...args: unknown[]) => mocks.connectHireControlDB(...args),
}))

vi.mock('@shared/services/emailService', () => ({ sendEmail: vi.fn() }))
vi.mock('@shared/logger', () => ({ logger: { warn: vi.fn() } }))

vi.mock('../models', () => ({
  normalizeHireMemberEmail: (value: string) => value.trim().toLowerCase(),
  parseHireWorkspaceSignInSlug: (value: string) =>
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) ? value : null,
  HireWorkspaceMember: {
    findOne: (...args: unknown[]) => mocks.findMember(...args),
    findOneAndUpdate: (...args: unknown[]) => mocks.findMemberAndUpdate(...args),
  },
  HireWorkspace: {
    findOne: (...args: unknown[]) => mocks.findWorkspace(...args),
  },
  HireMemberSession: {
    findOne: (...args: unknown[]) => mocks.findSession(...args),
    create: (...args: unknown[]) => mocks.createSession(...args),
    updateOne: (...args: unknown[]) => mocks.updateSession(...args),
  },
  HireMemberSetup: {
    findOne: (...args: unknown[]) => mocks.findSetup(...args),
    updateOne: (...args: unknown[]) => mocks.updateSetup(...args),
  },
}))

import {
  authenticateHireMember,
  completeMemberSetup,
  encodeHireMemberCredential,
  parseHireMemberCredential,
  resolveHireMemberSession,
  revokeHireMemberSession,
} from '../services/memberAuthService'

const WORKSPACE_A = '111111111111111111111111'
const WORKSPACE_B = '222222222222222222222222'
const MEMBER_A = '333333333333333333333333'
const SECRET = 'a'.repeat(64)

describe('workspace-scoped Hire member authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.connectHireControlDB.mockResolvedValue(undefined)
    mocks.compare.mockResolvedValue(true)
    mocks.hash.mockResolvedValue('bcrypt-hash')
    mocks.createSession.mockResolvedValue([])
    mocks.updateSession.mockResolvedValue({ modifiedCount: 1 })
    mocks.updateSetup.mockResolvedValue({ modifiedCount: 1 })
  })

  it('selects the requested workspace when the same email exists in another tenant', async () => {
    const member = {
      _id: MEMBER_A,
      workspaceId: WORKSPACE_A,
      passwordHash: 'bcrypt-hash-a',
      sessionVersion: 4,
    }
    const select = vi.fn().mockResolvedValue(member)
    mocks.findMember.mockImplementation((filter: { workspaceId?: string }) => {
      expect(filter.workspaceId).toBe(WORKSPACE_A)
      return { select }
    })
    mocks.findWorkspace.mockResolvedValue({ _id: WORKSPACE_A, name: 'Acme Hiring' })

    const auth = await authenticateHireMember(
      WORKSPACE_A,
      '  Person@Example.COM ',
      'correct horse',
    )

    expect(mocks.findMember).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_A,
      normalizedEmail: 'person@example.com',
      authState: 'active',
    })
    expect(mocks.findWorkspace).toHaveBeenCalledWith({ _id: WORKSPACE_A })
    expect(mocks.createSession).toHaveBeenCalledWith([
      expect.objectContaining({
        workspaceId: WORKSPACE_A,
        memberId: MEMBER_A,
        sessionVersion: 4,
      }),
    ], undefined)
    expect(parseHireMemberCredential(auth.sessionCredential)?.workspaceId).toBe(WORKSPACE_A)
  })

  it('resolves a readable slug before applying the same workspace-scoped member fence', async () => {
    const workspace = {
      _id: WORKSPACE_A,
      name: 'Acme Hiring',
      signInSlug: 'acme-hiring',
    }
    mocks.findWorkspace.mockResolvedValue(workspace)
    const select = vi.fn().mockResolvedValue({
      _id: MEMBER_A,
      workspaceId: WORKSPACE_A,
      passwordHash: 'bcrypt-hash-a',
      sessionVersion: 4,
    })
    mocks.findMember.mockReturnValue({ select })

    await expect(
      authenticateHireMember('Acme-Hiring', 'person@example.com', 'correct horse'),
    ).resolves.toMatchObject({ workspace })

    expect(mocks.findWorkspace).toHaveBeenCalledWith({ signInSlug: 'acme-hiring' })
    expect(mocks.findMember).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_A,
      normalizedEmail: 'person@example.com',
      authState: 'active',
    })
  })

  it('does not reveal whether workspace, email, or password was wrong', async () => {
    const select = vi.fn().mockResolvedValue(null)
    mocks.findMember.mockReturnValue({ select })
    mocks.findWorkspace.mockResolvedValue(null)

    await expect(
      authenticateHireMember(WORKSPACE_B, 'missing@example.com', 'wrong'),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', statusCode: 401 })
    expect(mocks.findWorkspace).toHaveBeenCalledWith({ _id: WORKSPACE_B })
    expect(mocks.findMember).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: new mongoose.Types.ObjectId('000000000000000000000000'),
    }))
    expect(mocks.compare).toHaveBeenCalledOnce()
    expect(mocks.compare.mock.calls[0][1]).toMatch(/^\$2b\$12\$/)
  })

  it('routes identical session secrets by the credential workspace for reads and lastSeen writes', async () => {
    const credential = encodeHireMemberCredential(WORKSPACE_A, SECRET)
    const session = {
      _id: '444444444444444444444444',
      workspaceId: WORKSPACE_A,
      memberId: MEMBER_A,
      sessionVersion: 7,
      lastSeenAt: new Date('2020-01-01T00:00:00.000Z'),
    }
    mocks.findSession.mockResolvedValue(session)
    mocks.findMember.mockResolvedValue({ _id: MEMBER_A, workspaceId: WORKSPACE_A })
    mocks.findWorkspace.mockResolvedValue({ _id: WORKSPACE_A })

    await expect(resolveHireMemberSession(credential)).resolves.toMatchObject({
      workspace: { _id: WORKSPACE_A },
    })

    expect(mocks.findSession).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WORKSPACE_A,
    }))
    expect(mocks.updateSession).toHaveBeenCalledWith(
      expect.objectContaining({ _id: session._id, workspaceId: WORKSPACE_A }),
      expect.objectContaining({ $set: { lastSeenAt: expect.any(Date) } }),
    )
  })

  it('revokes only the workspace encoded into a colliding-token credential', async () => {
    await revokeHireMemberSession(encodeHireMemberCredential(WORKSPACE_B, SECRET))

    expect(mocks.updateSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE_B, revokedAt: { $exists: false } }),
      { $set: { revokedAt: expect.any(Date) } },
    )
  })

  it('completes a colliding setup token only inside its credential workspace', async () => {
    const credential = encodeHireMemberCredential(WORKSPACE_B, SECRET)
    const mongoSession = {
      withTransaction: vi.fn(async (work: () => Promise<void>) => work()),
      endSession: vi.fn(),
    }
    vi.spyOn(mongoose, 'startSession').mockResolvedValue(mongoSession as never)
    const setup = { _id: '555555555555555555555555', memberId: MEMBER_A }
    const currentMember = {
      _id: MEMBER_A,
      workspaceId: WORKSPACE_B,
      sessionVersion: 2,
    }
    const updatedMember = { ...currentMember, sessionVersion: 3 }
    mocks.findSetup.mockImplementation((filter) => ({
      session: () => Promise.resolve(filter.workspaceId === WORKSPACE_B ? setup : null),
    }))
    mocks.findWorkspace.mockImplementation((filter) => ({
      session: () => Promise.resolve(filter._id === WORKSPACE_B ? { _id: WORKSPACE_B } : null),
    }))
    mocks.findMember.mockImplementation((filter) => ({
      session: () => Promise.resolve(filter.workspaceId === WORKSPACE_B ? currentMember : null),
    }))
    mocks.findMemberAndUpdate.mockResolvedValue(updatedMember)

    await expect(completeMemberSetup(credential, 'StrongPassword1')).resolves.toMatchObject({
      workspace: { _id: WORKSPACE_B },
      membership: { workspaceId: WORKSPACE_B },
    })

    expect(mocks.findSetup.mock.calls[0][0]).toMatchObject({ workspaceId: WORKSPACE_B })
    expect(mocks.findMemberAndUpdate.mock.calls[0][0]).toMatchObject({
      _id: MEMBER_A,
      workspaceId: WORKSPACE_B,
    })
    expect(mocks.updateSetup.mock.calls[0][0]).toMatchObject({
      _id: setup._id,
      workspaceId: WORKSPACE_B,
    })
    expect(mocks.createSession.mock.calls[0][0][0]).toMatchObject({ workspaceId: WORKSPACE_B })
  })
})
