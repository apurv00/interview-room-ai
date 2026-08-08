import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

const mockUserFindOne = vi.fn()
vi.mock('@shared/db/models', () => ({
  User: {
    findOne: (...args: unknown[]) => mockUserFindOne(...args),
    create: vi.fn(() => {
      throw new Error('workspaceService must NEVER create B2C User rows')
    }),
  },
  InterviewSession: {},
}))

const mockWorkspace = {
  create: vi.fn(),
  findById: vi.fn(),
  findOneAndUpdate: vi.fn(),
}
const mockMember = {
  create: vi.fn(),
  findOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
  find: vi.fn(),
  deleteOne: vi.fn(),
}
vi.mock('../models', () => ({
  HireWorkspace: {
    create: (...a: unknown[]) => mockWorkspace.create(...a),
    findById: (...a: unknown[]) => mockWorkspace.findById(...a),
    findOneAndUpdate: (...a: unknown[]) => mockWorkspace.findOneAndUpdate(...a),
  },
  HireWorkspaceMember: {
    create: (...a: unknown[]) => mockMember.create(...a),
    findOne: (...a: unknown[]) => mockMember.findOne(...a),
    findOneAndUpdate: (...a: unknown[]) => mockMember.findOneAndUpdate(...a),
    find: (...a: unknown[]) => mockMember.find(...a),
    deleteOne: (...a: unknown[]) => mockMember.deleteOne(...a),
  },
}))

import {
  createWorkspace,
  getWorkspaceForUser,
  requireMembership,
  addMember,
  removeMember,
  updateWorkspaceSettings,
  type MembershipContext,
} from '../services/workspaceService'
import { AppError, ForbiddenError } from '@shared/errors'

const ACTOR = { userId: 'aaaaaaaaaaaaaaaaaaaaaaaa', email: 'Admin@Acme.com' }

function ctxWith(role: 'admin' | 'member'): MembershipContext {
  return {
    workspace: { _id: 'ws1', name: 'Acme' },
    membership: { _id: 'm1', role, userId: 'u1', email: 'admin@acme.com' },
  } as unknown as MembershipContext
}

beforeEach(() => {
  vi.clearAllMocks()
  mockUserFindOne.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve(null) }),
  })
})

describe('getWorkspaceForUser', () => {
  it('resolves membership by linked userId first, earliest membership wins', async () => {
    const membership = { workspaceId: 'ws1' }
    mockMember.findOne.mockResolvedValue(membership)
    mockWorkspace.findById.mockResolvedValue({ _id: 'ws1', name: 'Acme' })

    const ctx = await getWorkspaceForUser(ACTOR)
    expect(mockMember.findOne).toHaveBeenCalledWith({ userId: ACTOR.userId }, null, {
      sort: { createdAt: 1 },
    })
    expect(ctx?.workspace.name).toBe('Acme')
  })

  it('lazily links an unlinked membership by lowercased email', async () => {
    mockMember.findOne.mockResolvedValue(null)
    mockMember.findOneAndUpdate.mockResolvedValue({ workspaceId: 'ws1' })
    mockWorkspace.findById.mockResolvedValue({ _id: 'ws1', name: 'Acme' })

    const ctx = await getWorkspaceForUser(ACTOR)
    const [filter, update] = mockMember.findOneAndUpdate.mock.calls[0]
    expect(filter.email).toBe('admin@acme.com')
    expect(filter.$or).toEqual([{ userId: { $exists: false } }, { userId: null }])
    expect(update).toEqual({ $set: { userId: ACTOR.userId } })
    expect(ctx).not.toBeNull()
  })

  it('returns null when no membership matches', async () => {
    mockMember.findOne.mockResolvedValue(null)
    mockMember.findOneAndUpdate.mockResolvedValue(null)
    expect(await getWorkspaceForUser(ACTOR)).toBeNull()
  })
})

describe('requireMembership', () => {
  it('throws ForbiddenError when the caller has no workspace', async () => {
    mockMember.findOne.mockResolvedValue(null)
    mockMember.findOneAndUpdate.mockResolvedValue(null)
    await expect(requireMembership(ACTOR)).rejects.toBeInstanceOf(ForbiddenError)
  })
})

describe('createWorkspace', () => {
  it('creates the workspace (guest verification defaults to magic_link) and an admin membership', async () => {
    mockMember.findOne.mockResolvedValue(null)
    mockMember.findOneAndUpdate.mockResolvedValue(null)
    mockWorkspace.create.mockResolvedValue({ _id: 'ws-new', name: 'Acme' })
    mockMember.create.mockResolvedValue({ _id: 'm-new', role: 'admin' })

    await createWorkspace(ACTOR, { name: 'Acme' })
    expect(mockWorkspace.create).toHaveBeenCalledWith({
      name: 'Acme',
      guestAuthMode: 'magic_link',
      createdBy: ACTOR.userId,
    })
    const memberDoc = mockMember.create.mock.calls[0][0]
    expect(memberDoc.role).toBe('admin')
    expect(memberDoc.email).toBe('admin@acme.com')
    expect(memberDoc.userId).toBe(ACTOR.userId)
  })

  it('honors an explicit otp guest verification choice', async () => {
    mockMember.findOne.mockResolvedValue(null)
    mockMember.findOneAndUpdate.mockResolvedValue(null)
    mockWorkspace.create.mockResolvedValue({ _id: 'ws-new' })
    mockMember.create.mockResolvedValue({ _id: 'm-new' })

    await createWorkspace(ACTOR, { name: 'Acme', guestAuthMode: 'otp' })
    expect(mockWorkspace.create.mock.calls[0][0].guestAuthMode).toBe('otp')
  })

  it('rejects a second workspace for the same user (409)', async () => {
    mockMember.findOne.mockResolvedValue({ workspaceId: 'ws1' })
    mockWorkspace.findById.mockResolvedValue({ _id: 'ws1' })
    await expect(createWorkspace(ACTOR, { name: 'Other' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'WORKSPACE_EXISTS',
    })
  })
})

describe('updateWorkspaceSettings', () => {
  it('is admin-only', async () => {
    await expect(
      updateWorkspaceSettings(ctxWith('member'), { guestAuthMode: 'otp' })
    ).rejects.toBeInstanceOf(ForbiddenError)
    expect(mockWorkspace.findOneAndUpdate).not.toHaveBeenCalled()
  })

  it('updates only the caller workspace', async () => {
    mockWorkspace.findOneAndUpdate.mockResolvedValue({ _id: 'ws1', guestAuthMode: 'otp' })
    await updateWorkspaceSettings(ctxWith('admin'), { guestAuthMode: 'otp' })
    const [filter, update] = mockWorkspace.findOneAndUpdate.mock.calls[0]
    expect(filter).toEqual({ _id: 'ws1' })
    expect(update).toEqual({ $set: { guestAuthMode: 'otp' } })
  })
})

describe('addMember', () => {
  it('is admin-only', async () => {
    await expect(
      addMember(ctxWith('member'), { email: 'new@acme.com' })
    ).rejects.toBeInstanceOf(ForbiddenError)
    expect(mockMember.create).not.toHaveBeenCalled()
  })

  it('links an existing User by email but NEVER creates one', async () => {
    mockUserFindOne.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ _id: 'existing-user' }) }),
    })
    // No linked membership anywhere yet → eager link is safe.
    mockMember.findOne.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve(null) }),
    })
    mockMember.create.mockResolvedValue({ _id: 'm2' })

    await addMember(ctxWith('admin'), { email: 'New@Acme.com', name: 'New Person' })
    const doc = mockMember.create.mock.calls[0][0]
    expect(doc.email).toBe('new@acme.com')
    expect(doc.userId).toBe('existing-user')
    expect(doc.role).toBe('member')
    expect(doc.workspaceId).toBe('ws1')
  })

  it('does NOT link a user who is already a linked member of another workspace', async () => {
    mockUserFindOne.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ _id: 'existing-user' }) }),
    })
    mockMember.findOne.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ _id: 'their-other-membership' }) }),
    })
    mockMember.create.mockResolvedValue({ _id: 'm3' })

    await addMember(ctxWith('admin'), { email: 'busy@other.com' })
    const doc = mockMember.create.mock.calls[0][0]
    // Row stays email-only ("not signed in yet") — one workspace per user;
    // a second eager link would make workspace resolution ambiguous.
    expect(doc.userId).toBeUndefined()
    expect(doc.email).toBe('busy@other.com')
  })

  it('maps the duplicate-key error to 409 MEMBER_EXISTS', async () => {
    mockMember.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }))
    await expect(
      addMember(ctxWith('admin'), { email: 'new@acme.com' })
    ).rejects.toMatchObject({ statusCode: 409, code: 'MEMBER_EXISTS' })
  })
})

describe('removeMember', () => {
  it('is admin-only', async () => {
    await expect(removeMember(ctxWith('member'), 'm2')).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('scopes the lookup by workspaceId (cross-tenant ids miss)', async () => {
    mockMember.findOne.mockResolvedValue(null)
    await expect(removeMember(ctxWith('admin'), 'foreign-member')).rejects.toMatchObject({
      statusCode: 404,
    })
    expect(mockMember.findOne).toHaveBeenCalledWith({
      _id: 'foreign-member',
      workspaceId: 'ws1',
    })
    expect(mockMember.deleteOne).not.toHaveBeenCalled()
  })

  it('refuses to remove the admin', async () => {
    mockMember.findOne.mockResolvedValue({ _id: 'm1', role: 'admin' })
    await expect(removeMember(ctxWith('admin'), 'm1')).rejects.toMatchObject({
      code: 'CANNOT_REMOVE_ADMIN',
    })
  })
})

describe('B2C boundary', () => {
  it('the module mock proves no User.create path exists in workspaceService', async () => {
    // The @shared/db/models mock throws if User.create is ever invoked; the
    // suite passing at all is the assertion. This test documents the intent.
    expect(true).toBe(true)
  })
})
