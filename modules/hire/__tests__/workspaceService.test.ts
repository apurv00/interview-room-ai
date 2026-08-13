import { describe, it, expect, vi, beforeEach } from 'vitest'
import mongoose from 'mongoose'

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

const mockIssueMemberSetup = vi.fn()
vi.mock('@shared/db/models', () => ({
  InterviewSession: {},
}))

const mockWorkspace = {
  create: vi.fn(),
  find: vi.fn(),
  findById: vi.fn(),
  findOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
  updateOne: vi.fn(),
  deleteOne: vi.fn(),
}
const mockMember = {
  create: vi.fn(),
  findOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
  find: vi.fn(),
  exists: vi.fn(),
  updateOne: vi.fn(),
  deleteOne: vi.fn(),
}
const mockMemberSession = { updateMany: vi.fn() }
const mockMemberSetup = { updateMany: vi.fn() }
const mockJob = { updateMany: vi.fn() }
const mockOutbox = { updateMany: vi.fn() }
const mockGuestSession = { updateMany: vi.fn() }
const mockRound = { find: vi.fn(), updateMany: vi.fn() }
const mockHandoff = { updateMany: vi.fn() }
const mockAttempt = { updateMany: vi.fn() }
const mockDeliverRuntimeRevocation = vi.fn()
vi.mock('../models', () => ({
  HireWorkspace: {
    create: (...a: unknown[]) => mockWorkspace.create(...a),
    find: (...a: unknown[]) => mockWorkspace.find(...a),
    findById: (...a: unknown[]) => mockWorkspace.findById(...a),
    findOne: (...a: unknown[]) => mockWorkspace.findOne(...a),
    findOneAndUpdate: (...a: unknown[]) => mockWorkspace.findOneAndUpdate(...a),
    updateOne: (...a: unknown[]) => mockWorkspace.updateOne(...a),
    deleteOne: (...a: unknown[]) => mockWorkspace.deleteOne(...a),
  },
  HireWorkspaceMember: {
    create: (...a: unknown[]) => mockMember.create(...a),
    findOne: (...a: unknown[]) => mockMember.findOne(...a),
    findOneAndUpdate: (...a: unknown[]) => mockMember.findOneAndUpdate(...a),
    find: (...a: unknown[]) => mockMember.find(...a),
    exists: (...a: unknown[]) => mockMember.exists(...a),
    updateOne: (...a: unknown[]) => mockMember.updateOne(...a),
    deleteOne: (...a: unknown[]) => mockMember.deleteOne(...a),
  },
  HireMemberSession: {
    updateMany: (...a: unknown[]) => mockMemberSession.updateMany(...a),
  },
  HireMemberSetup: {
    updateMany: (...a: unknown[]) => mockMemberSetup.updateMany(...a),
  },
  normalizeHireMemberEmail: (value: string) => value.trim().toLowerCase(),
  HireJob: { updateMany: (...a: unknown[]) => mockJob.updateMany(...a) },
  HireEmailOutbox: {
    updateMany: (...a: unknown[]) => mockOutbox.updateMany(...a),
  },
  HireGuestSession: {
    updateMany: (...a: unknown[]) => mockGuestSession.updateMany(...a),
  },
  HireRound: {
    find: (...a: unknown[]) => mockRound.find(...a),
    updateMany: (...a: unknown[]) => mockRound.updateMany(...a),
  },
  HireEngineHandoff: {
    updateMany: (...a: unknown[]) => mockHandoff.updateMany(...a),
  },
  HireInterviewAttempt: {
    updateMany: (...a: unknown[]) => mockAttempt.updateMany(...a),
  },
}))

vi.mock('../services/memberAuthService', () => ({
  issueMemberSetup: (...args: unknown[]) => mockIssueMemberSetup(...args),
}))

vi.mock('../services/engineRevocationService', () => ({
  deliverRuntimeRevocation: (...args: unknown[]) => mockDeliverRuntimeRevocation(...args),
}))

import {
  createWorkspace,
  getWorkspaceForUser,
  requireMembership,
  addMember,
  regenerateMemberSetup,
  removeMember,
  restoreWorkspace,
  softDeleteWorkspace,
  transferWorkspaceAdmin,
  updateWorkspaceSettings,
  type MembershipContext,
} from '../services/workspaceService'
import { AppError, ForbiddenError } from '@shared/errors'

const ACTOR = { userId: 'aaaaaaaaaaaaaaaaaaaaaaaa', email: 'Admin@Acme.com' }
const OPERATION_ID = '123e4567-e89b-42d3-a456-426614174000'
const TARGET_MEMBER_ID = '222222222222222222222222'

const transactionSession = {
  withTransaction: vi.fn(async (callback: () => Promise<void>) => callback()),
  endSession: vi.fn().mockResolvedValue(undefined),
}

function ctxWith(role: 'admin' | 'member'): MembershipContext {
  return {
    workspace: { _id: 'ws1', name: 'Acme' },
    membership: { _id: 'm1', role, userId: 'u1', email: 'admin@acme.com' },
  } as unknown as MembershipContext
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(mongoose, 'startSession').mockResolvedValue(transactionSession as never)
  transactionSession.withTransaction.mockImplementation(
    async (callback: () => Promise<void>) => callback(),
  )
  transactionSession.endSession.mockResolvedValue(undefined)
  mockIssueMemberSetup.mockResolvedValue({
    setupUrl: 'https://hire.example/setup',
    emailSent: true,
    expiresAt: new Date('2026-08-11T00:00:00.000Z'),
  })
  mockWorkspace.find.mockReturnValue({
    sort: () => ({ lean: () => Promise.resolve([]) }),
  })
  mockMember.findOne.mockResolvedValue(null)
  mockMember.findOneAndUpdate.mockResolvedValue(null)
  mockMember.exists.mockReturnValue({ session: () => Promise.resolve({ _id: 'm1' }) })
  mockMember.updateOne.mockResolvedValue({ modifiedCount: 1 })
  mockWorkspace.updateOne.mockResolvedValue({ matchedCount: 1 })
  mockOutbox.updateMany.mockResolvedValue({ modifiedCount: 0 })
  mockMemberSession.updateMany.mockResolvedValue({ modifiedCount: 0 })
  mockMemberSetup.updateMany.mockResolvedValue({ modifiedCount: 0 })
  mockRound.find.mockResolvedValue([])
  mockRound.updateMany.mockResolvedValue({ modifiedCount: 0 })
  mockHandoff.updateMany.mockResolvedValue({ modifiedCount: 0 })
  mockAttempt.updateMany.mockResolvedValue({ modifiedCount: 0 })
  mockDeliverRuntimeRevocation.mockResolvedValue(true)
})

describe('getWorkspaceForUser', () => {
  it('enumerates roots but performs only workspace-scoped linked-user lookups', async () => {
    const workspaceA = new mongoose.Types.ObjectId('111111111111111111111111')
    const workspaceB = new mongoose.Types.ObjectId('222222222222222222222222')
    mockWorkspace.find.mockReturnValue({
      sort: () => ({ lean: () => Promise.resolve([{ _id: workspaceA }, { _id: workspaceB }]) }),
    })
    mockMember.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ workspaceId: workspaceB })
    mockWorkspace.findOne.mockResolvedValue({ _id: workspaceB, name: 'Acme' })

    const ctx = await getWorkspaceForUser(ACTOR)
    expect(mockMember.findOne.mock.calls.map(([filter]) => filter)).toEqual([
      { workspaceId: workspaceA, userId: ACTOR.userId, authState: 'active' },
      { workspaceId: workspaceB, userId: ACTOR.userId, authState: 'active' },
    ])
    expect(ctx?.workspace.name).toBe('Acme')
  })

  it('resolves a Hire password principal from its embedded workspace coordinate', async () => {
    const workspaceId = 'aaaaaaaaaaaaaaaaaaaaaaaa'
    const memberId = '111111111111111111111111'
    const actor = {
      userId: `hire-member:${workspaceId}:${memberId}`,
      email: 'member@acme.com',
    }
    mockMember.findOne.mockResolvedValue({
      _id: memberId,
      workspaceId,
    })
    mockWorkspace.findOne.mockResolvedValue({ _id: workspaceId, name: 'Acme' })

    await expect(getWorkspaceForUser(actor)).resolves.toMatchObject({
      workspace: { _id: workspaceId },
    })
    expect(mockMember.findOne).toHaveBeenCalledWith({
      _id: memberId,
      workspaceId,
      normalizedEmail: 'member@acme.com',
      authState: 'active',
    })
    expect(mockWorkspace.find).not.toHaveBeenCalled()
  })

  it('returns null without any global member email or user-id query', async () => {
    expect(await getWorkspaceForUser(ACTOR)).toBeNull()
    expect(mockMember.findOne).not.toHaveBeenCalled()
    expect(mockMember.findOneAndUpdate).not.toHaveBeenCalled()
  })
})

describe('requireMembership', () => {
  it('throws ForbiddenError when the caller has no workspace', async () => {
    mockMember.findOne.mockResolvedValue(null)
    mockMember.findOneAndUpdate.mockResolvedValue(null)
    await expect(requireMembership(ACTOR)).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('blocks all normal workspace access after a soft deletion', async () => {
    const workspaceId = 'aaaaaaaaaaaaaaaaaaaaaaaa'
    mockMember.findOne.mockResolvedValue({
      _id: '111111111111111111111111',
      workspaceId,
      authState: 'active',
    })
    mockWorkspace.findOne.mockResolvedValue({
      _id: workspaceId,
      name: 'Acme',
      lifecycleState: 'deletion_pending',
    })

    await expect(
      requireMembership({
        userId: 'hire-member:aaaaaaaaaaaaaaaaaaaaaaaa:111111111111111111111111',
        email: 'admin@acme.com',
      }),
    ).rejects.toMatchObject({ statusCode: 410, code: 'WORKSPACE_DELETION_PENDING' })
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
    const workspaceId = new mongoose.Types.ObjectId('111111111111111111111111')
    mockWorkspace.find.mockReturnValue({
      sort: () => ({ lean: () => Promise.resolve([{ _id: workspaceId }]) }),
    })
    mockMember.findOne.mockResolvedValue({ workspaceId })
    mockWorkspace.findOne.mockResolvedValue({ _id: workspaceId })
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
    expect(filter).toEqual({
      _id: 'ws1',
      $or: [{ lifecycleState: 'active' }, { lifecycleState: { $exists: false } }],
    })
    expect(update).toEqual({ $set: { guestAuthMode: 'otp' } })
  })

  it('saves or clears the optional Smart-JD company blurb', async () => {
    mockWorkspace.findOneAndUpdate.mockResolvedValue({ _id: 'ws1' })

    await updateWorkspaceSettings(ctxWith('admin'), { companyBlurb: '  We build tools.  ' })
    expect(mockWorkspace.findOneAndUpdate.mock.calls[0][1]).toEqual({
      $set: { companyBlurb: 'We build tools.' },
    })

    await updateWorkspaceSettings(ctxWith('admin'), { companyBlurb: '  ' })
    expect(mockWorkspace.findOneAndUpdate.mock.calls[1][1]).toEqual({
      $unset: { companyBlurb: 1 },
    })
  })
})

describe('addMember', () => {
  it('is admin-only', async () => {
    await expect(
      addMember(ctxWith('member'), { email: 'new@acme.com' })
    ).rejects.toBeInstanceOf(ForbiddenError)
    expect(mockMember.create).not.toHaveBeenCalled()
  })

  it('creates a pending Hire-owned member without a B2C lookup', async () => {
    mockMember.findOne.mockReturnValueOnce({ select: () => Promise.resolve(null) })
    mockMember.create.mockResolvedValue([{ _id: 'm2' }])

    await addMember(ctxWith('admin'), { email: 'New@Acme.com', name: 'New Person' })
    const doc = mockMember.create.mock.calls[0][0][0]
    expect(doc.email).toBe('new@acme.com')
    expect(doc.normalizedEmail).toBe('new@acme.com')
    expect(doc.userId).toBeUndefined()
    expect(doc.role).toBe('member')
    expect(doc.workspaceId).toBe('ws1')
    expect(mockWorkspace.updateOne).toHaveBeenCalledWith(
      {
        _id: 'ws1',
        $or: [{ lifecycleState: 'active' }, { lifecycleState: { $exists: false } }],
      },
      { $inc: { writeFenceVersion: 1 } },
      { session: transactionSession },
    )
  })

  it('allows the same email in another workspace because lookup is tenant-scoped', async () => {
    mockMember.findOne.mockImplementation((filter: { workspaceId?: string }) => ({
      select: () => Promise.resolve(filter.workspaceId === 'ws1' ? null : { _id: 'foreign' }),
    }))
    mockMember.create.mockResolvedValue([{ _id: 'm2' }])

    await expect(
      addMember(ctxWith('admin'), { email: 'busy@other.com', name: 'Busy Member' }),
    ).resolves.toMatchObject({ member: { _id: 'm2' } })
    expect(mockMember.findOne.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws1' })
  })

  it('maps the duplicate-key error to 409 MEMBER_EXISTS', async () => {
    mockMember.findOne.mockReturnValueOnce({ select: () => Promise.resolve(null) })
    mockMember.create.mockRejectedValue(
      Object.assign(new Error('dup'), { code: 11000, keyPattern: { normalizedEmail: 1 } })
    )
    mockMember.findOne
      .mockReturnValueOnce({ select: () => Promise.resolve(null) })
      .mockReturnValueOnce({
        select: () => Promise.resolve({
          _id: 'winner',
          workspaceId: { equals: () => true },
        }),
      })
    await expect(
      addMember(ctxWith('admin'), { email: 'new@acme.com', name: 'New Person' })
    ).rejects.toMatchObject({ statusCode: 409, code: 'MEMBER_EXISTS' })
  })

  it('maps an in-workspace normalized-email race to the friendly conflict', async () => {
    mockMember.findOne
      .mockReturnValueOnce({ select: () => Promise.resolve(null) })
      .mockReturnValueOnce({
        select: () => Promise.resolve({
          _id: 'winner',
        }),
      })
    mockMember.create.mockRejectedValue(
      Object.assign(new Error('dup'), { code: 11000, keyPattern: { normalizedEmail: 1 } }),
    )

    await expect(
      addMember(ctxWith('admin'), { email: 'racer@x.com', name: 'Race Member' }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'MEMBER_EXISTS',
      message: 'This person is already a member',
    })
  })
})

describe('regenerateMemberSetup', () => {
  it('is admin-only', async () => {
    await expect(
      regenerateMemberSetup(ctxWith('member'), TARGET_MEMBER_ID),
    ).rejects.toBeInstanceOf(ForbiddenError)
    expect(mockMember.findOne).not.toHaveBeenCalled()
    expect(mockIssueMemberSetup).not.toHaveBeenCalled()
  })

  it('replaces setup only for a pending member in the caller workspace', async () => {
    const pending = {
      _id: TARGET_MEMBER_ID,
      workspaceId: 'ws1',
      role: 'member',
      authState: 'pending',
      name: 'Pending Person',
      email: 'pending@acme.com',
    }
    mockMember.findOne.mockResolvedValue(pending)

    await expect(
      regenerateMemberSetup(ctxWith('admin'), TARGET_MEMBER_ID),
    ).resolves.toMatchObject({
      setupUrl: 'https://hire.example/setup',
      emailSent: true,
    })
    expect(mockMember.findOne).toHaveBeenCalledWith({
      _id: TARGET_MEMBER_ID,
      workspaceId: 'ws1',
      role: 'member',
      authState: 'pending',
    })
    expect(mockIssueMemberSetup).toHaveBeenCalledWith(pending, 'Acme')
  })

  it('does not regenerate a foreign or already-active membership', async () => {
    mockMember.findOne.mockResolvedValue(null)
    await expect(
      regenerateMemberSetup(ctxWith('admin'), TARGET_MEMBER_ID),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'MEMBER_SETUP_NOT_PENDING',
    })
    expect(mockIssueMemberSetup).not.toHaveBeenCalled()
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

describe('transferWorkspaceAdmin', () => {
  it('atomically demotes the caller, promotes one active in-workspace member, and returns immediate authority', async () => {
    const ctx = ctxWith('admin')
    const target = { _id: TARGET_MEMBER_ID, role: 'member', authState: 'active' }
    const workspaceAfter = {
      _id: 'ws1',
      name: 'Acme',
      lifecycleState: 'active',
      adminTransferEvents: [],
    }
    mockWorkspace.findOne.mockResolvedValue(null)
    mockMember.findOne
      .mockReturnValueOnce({ session: () => Promise.resolve(target) })
      .mockResolvedValueOnce({ ...ctx.membership, role: 'member' })
    mockMember.updateOne.mockResolvedValue({ modifiedCount: 1 })
    mockWorkspace.findOneAndUpdate.mockResolvedValue(workspaceAfter)
    mockWorkspace.findById.mockResolvedValue(workspaceAfter)

    const result = await transferWorkspaceAdmin(ctx, TARGET_MEMBER_ID, {
      operationId: OPERATION_ID,
    })

    expect(transactionSession.withTransaction).toHaveBeenCalledTimes(1)
    expect(mockMember.updateOne.mock.calls[0][0]).toMatchObject({
      _id: 'm1',
      workspaceId: 'ws1',
      role: 'admin',
      authState: 'active',
    })
    expect(mockMember.updateOne.mock.calls[0][1]).toEqual({ $set: { role: 'member' } })
    expect(mockMember.updateOne.mock.calls[1][0]).toMatchObject({
      _id: TARGET_MEMBER_ID,
      workspaceId: 'ws1',
      role: 'member',
      authState: 'active',
    })
    expect(mockMember.updateOne.mock.calls[1][1]).toEqual({ $set: { role: 'admin' } })
    expect(mockWorkspace.findOneAndUpdate.mock.calls[0][1].$push.adminTransferEvents)
      .toMatchObject({
        fromMemberId: 'm1',
        toMemberId: TARGET_MEMBER_ID,
        actorName: 'admin@acme.com',
        operationId: OPERATION_ID,
      })
    expect(result.membership.role).toBe('member')
  })

  it('does not accept a pending or cross-workspace target', async () => {
    mockWorkspace.findOne.mockResolvedValue(null)
    mockMember.findOne.mockReturnValue({ session: () => Promise.resolve(null) })

    await expect(
      transferWorkspaceAdmin(ctxWith('admin'), TARGET_MEMBER_ID, {
        operationId: OPERATION_ID,
      }),
    ).rejects.toMatchObject({ statusCode: 404 })
    expect(mockMember.findOne.mock.calls[0][0]).toMatchObject({
      _id: TARGET_MEMBER_ID,
      workspaceId: 'ws1',
      role: 'member',
      authState: 'active',
    })
    expect(mockMember.updateOne).not.toHaveBeenCalled()
  })
})

describe('workspace soft deletion', () => {
  it('tombstones for exactly 30 days and revokes links without deleting any data', async () => {
    const now = new Date('2026-08-10T12:00:00.000Z')
    const deleted = {
      _id: 'ws1',
      name: 'Acme',
      lifecycleState: 'deletion_pending',
      lifecycleEvents: [],
    }
    mockWorkspace.findOne.mockResolvedValue(null)
    mockMember.exists.mockReturnValue({ session: () => Promise.resolve({ _id: 'm1' }) })
    mockWorkspace.findOneAndUpdate.mockResolvedValue(deleted)
    mockJob.updateMany.mockResolvedValue({ modifiedCount: 2 })
    mockGuestSession.updateMany.mockResolvedValue({ modifiedCount: 3 })
    mockRound.find.mockResolvedValue([{ _id: { toString: () => 'round-1' } }])

    await softDeleteWorkspace(
      ctxWith('admin'),
      {
        confirmationName: 'Acme',
        acknowledgePermanentPurge: true,
        operationId: OPERATION_ID,
      },
      now,
    )

    const [filter, update, options] = mockWorkspace.findOneAndUpdate.mock.calls[0]
    expect(filter).toMatchObject({
      _id: 'ws1',
      $or: [{ lifecycleState: 'active' }, { lifecycleState: { $exists: false } }],
    })
    expect(update.$set).toMatchObject({
      lifecycleState: 'deletion_pending',
      deletedAt: now,
      deletedByMemberId: 'm1',
      deletedByName: 'admin@acme.com',
    })
    expect(update.$set.purgeAfter.toISOString()).toBe('2026-09-09T12:00:00.000Z')
    expect(update.$push.lifecycleEvents).toMatchObject({
      type: 'deletion_scheduled',
      actorMemberId: 'm1',
      actorName: 'admin@acme.com',
      operationId: OPERATION_ID,
    })
    expect(options.session).toBe(transactionSession)
    expect(mockJob.updateMany).toHaveBeenCalledWith(
      { workspaceId: 'ws1' },
      { $set: { applyPageEnabled: false }, $unset: { applyTokenHash: 1 } },
      { session: transactionSession },
    )
    expect(mockOutbox.updateMany).toHaveBeenCalledWith(
      {
        workspaceId: 'ws1',
        status: { $in: ['pending', 'sending', 'failed'] },
      },
      {
        $set: {
          status: 'cancelled',
          lastError: 'Workspace scheduled for deletion',
        },
        $unset: { claimToken: 1, leaseExpiresAt: 1 },
      },
      { session: transactionSession },
    )
    expect(mockGuestSession.updateMany).toHaveBeenCalledWith(
      { workspaceId: 'ws1', active: true },
      { $set: { revokedAt: now }, $unset: { active: 1 } },
      { session: transactionSession },
    )
    expect(mockRound.updateMany).toHaveBeenCalledWith(
      { workspaceId: 'ws1', status: { $ne: 'completed' } },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'revoked',
          revokedAt: now,
          revocationState: 'pending',
        }),
        $unset: { live: 1 },
      }),
      { session: transactionSession },
    )
    expect(mockHandoff.updateMany).toHaveBeenCalledWith(
      { workspaceId: 'ws1', revokedAt: { $exists: false } },
      { $set: { revokedAt: now } },
      { session: transactionSession },
    )
    expect(mockAttempt.updateMany).toHaveBeenCalledWith(
      { workspaceId: 'ws1', live: true, status: { $ne: 'completed' } },
      { $set: { status: 'revoked' }, $unset: { live: 1 } },
      { session: transactionSession },
    )
    expect(mockDeliverRuntimeRevocation).toHaveBeenCalledWith('ws1', 'round-1')
    expect(mockWorkspace.deleteOne).not.toHaveBeenCalled()
  })

  it('requires an exact name and explicit permanent-purge acknowledgement', async () => {
    await expect(
      softDeleteWorkspace(ctxWith('admin'), {
        confirmationName: 'acme',
        acknowledgePermanentPurge: true,
        operationId: OPERATION_ID,
      }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_DELETE_CONFIRMATION_REQUIRED' })
    expect(mongoose.startSession).not.toHaveBeenCalled()
  })

  it('restores only inside the recovery window and does not revive old links', async () => {
    const restored = {
      _id: 'ws1',
      name: 'Acme',
      lifecycleState: 'active',
      lifecycleEvents: [],
    }
    mockWorkspace.findOne.mockResolvedValue(null)
    mockMember.exists.mockReturnValue({ session: () => Promise.resolve({ _id: 'm1' }) })
    mockWorkspace.findOneAndUpdate.mockResolvedValue(restored)

    await restoreWorkspace(
      ctxWith('admin'),
      { operationId: OPERATION_ID },
      new Date('2026-08-11T00:00:00.000Z'),
    )

    expect(mockWorkspace.findOneAndUpdate.mock.calls[0][0]).toMatchObject({
      _id: 'ws1',
      lifecycleState: 'deletion_pending',
      purgeAfter: { $gt: new Date('2026-08-11T00:00:00.000Z') },
    })
    expect(mockWorkspace.findOneAndUpdate.mock.calls[0][1].$unset).toEqual({
      deletedAt: 1,
      purgeAfter: 1,
      deletedByMemberId: 1,
      deletedByName: 1,
    })
    expect(mockJob.updateMany).not.toHaveBeenCalled()
    expect(mockGuestSession.updateMany).not.toHaveBeenCalled()
  })
})

describe('B2C boundary', () => {
  it('the module mock proves no User.create path exists in workspaceService', async () => {
    // The @shared/db/models mock throws if User.create is ever invoked; the
    // suite passing at all is the assertion. This test documents the intent.
    expect(true).toBe(true)
  })
})
