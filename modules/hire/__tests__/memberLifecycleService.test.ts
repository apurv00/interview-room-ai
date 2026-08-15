import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connectHireControlDB: vi.fn(),
  memberFindOne: vi.fn(),
  memberExists: vi.fn(),
  memberUpdateOne: vi.fn(),
  workspaceFindById: vi.fn(),
  workspaceUpdateOne: vi.fn(),
  sessionUpdateMany: vi.fn(),
  setupUpdateMany: vi.fn(),
  disableDigestDelivery: vi.fn(),
  cancelTestDrivesForMember: vi.fn(),
  deliverTestDriveRuntimeRevocations: vi.fn(),
  kickDueTestDriveCleanups: vi.fn(),
  softDeleteWorkspace: vi.fn(),
  getWorkspaceForUser: vi.fn(),
}))

vi.mock('../services/hireControlBoundary', () => ({
  connectHireControlDB: (...args: unknown[]) => mocks.connectHireControlDB(...args),
}))

vi.mock('../services/workspaceService', () => ({
  softDeleteWorkspace: (...args: unknown[]) => mocks.softDeleteWorkspace(...args),
  getWorkspaceForUser: (...args: unknown[]) => mocks.getWorkspaceForUser(...args),
}))

vi.mock('../models', () => ({
  HireWorkspaceMember: {
    findOne: (...args: unknown[]) => mocks.memberFindOne(...args),
    exists: (...args: unknown[]) => mocks.memberExists(...args),
    updateOne: (...args: unknown[]) => mocks.memberUpdateOne(...args),
  },
  HireWorkspace: {
    findById: (...args: unknown[]) => mocks.workspaceFindById(...args),
    updateOne: (...args: unknown[]) => mocks.workspaceUpdateOne(...args),
  },
  HireMemberSession: {
    updateMany: (...args: unknown[]) => mocks.sessionUpdateMany(...args),
  },
  HireMemberSetup: {
    updateMany: (...args: unknown[]) => mocks.setupUpdateMany(...args),
  },
}))

vi.mock('../../hire-digest/services/hireDigestService', () => ({
  disableHireDigestDeliveryForScope: (...args: unknown[]) => mocks.disableDigestDelivery(...args),
}))

vi.mock('../../hire-onboarding/services/testDriveLifecycleService', () => ({
  cancelHireOnboardingTestDrivesForMember: (...args: unknown[]) =>
    mocks.cancelTestDrivesForMember(...args),
  deliverHireOnboardingTestDriveRuntimeRevocations: (...args: unknown[]) =>
    mocks.deliverTestDriveRuntimeRevocations(...args),
  kickDueHireOnboardingTestDriveCleanups: (...args: unknown[]) =>
    mocks.kickDueTestDriveCleanups(...args),
}))

import {
  HireWorkspaceDeletionConfirmationError,
  commitLinkedB2CAccountDeletion,
  preflightLinkedB2CAccountDeletion,
  selfDeleteHireMember,
} from '../services/memberLifecycleService'

const WORKSPACE_ID = new mongoose.Types.ObjectId('111111111111111111111111')
const MEMBER_ID = new mongoose.Types.ObjectId('222222222222222222222222')
const B2C_USER_ID = '333333333333333333333333'
const OPERATION_ID = '123e4567-e89b-42d3-a456-426614174000'
const NOW = new Date('2026-08-10T00:00:00.000Z')

const transactionSession = {
  withTransaction: vi.fn(async (callback: () => Promise<void>) => callback()),
  endSession: vi.fn(),
}

function context(role: 'admin' | 'member') {
  return {
    workspace: { _id: WORKSPACE_ID, name: 'Acme Hiring' },
    membership: {
      _id: MEMBER_ID,
      workspaceId: WORKSPACE_ID,
      role,
      authState: 'active',
      name: 'Alex',
      email: 'alex@example.com',
    },
  } as never
}

function currentMember(role: 'admin' | 'member') {
  return {
    _id: MEMBER_ID,
    workspaceId: WORKSPACE_ID,
    role,
    authState: 'active',
    name: 'Alex',
    email: 'alex@example.com',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(mongoose, 'startSession').mockResolvedValue(transactionSession as never)
  transactionSession.withTransaction.mockImplementation(
    async (callback: () => Promise<void>) => callback(),
  )
  transactionSession.endSession.mockResolvedValue(undefined)
  mocks.connectHireControlDB.mockResolvedValue(undefined)
  mocks.workspaceFindById.mockResolvedValue({ _id: WORKSPACE_ID, name: 'Acme Hiring' })
  mocks.workspaceUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.memberUpdateOne.mockResolvedValue({ modifiedCount: 1 })
  mocks.sessionUpdateMany.mockResolvedValue({ modifiedCount: 2 })
  mocks.setupUpdateMany.mockResolvedValue({ modifiedCount: 1 })
  mocks.disableDigestDelivery.mockResolvedValue(undefined)
  mocks.cancelTestDrivesForMember.mockResolvedValue({ marked: 0, runtimeRoundIds: [] })
  mocks.deliverTestDriveRuntimeRevocations.mockResolvedValue({ requested: 0, confirmed: 0 })
  mocks.kickDueTestDriveCleanups.mockResolvedValue({ discovered: 0, dispatched: 0 })
  mocks.memberExists.mockResolvedValue(null)
  mocks.getWorkspaceForUser.mockResolvedValue(null)
})

describe('selfDeleteHireMember', () => {
  it('removes a direct member, revokes sessions/setup links, and preserves the actor row', async () => {
    mocks.memberFindOne.mockResolvedValue(currentMember('member'))

    const result = await selfDeleteHireMember(
      context('member'),
      { operationId: OPERATION_ID },
      NOW,
    )

    expect(result).toEqual({ workspaceDeletionScheduled: false })
    expect(mocks.softDeleteWorkspace).not.toHaveBeenCalled()
    expect(mocks.memberUpdateOne).toHaveBeenCalledWith(
      {
        _id: MEMBER_ID,
        workspaceId: WORKSPACE_ID,
        role: 'member',
        authState: 'active',
      },
      {
        $set: { authState: 'removed', removedAt: NOW },
        $inc: { sessionVersion: 1, digestEgressFenceVersion: 1 },
        $unset: { passwordHash: 1, passwordSetAt: 1, userId: 1 },
      },
      { session: transactionSession },
    )
    expect(mocks.disableDigestDelivery).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      memberId: MEMBER_ID,
      now: NOW,
      session: transactionSession,
    })
    expect(mocks.cancelTestDrivesForMember).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      memberId: MEMBER_ID,
      at: NOW,
      cleanupAfter: NOW,
      reason: 'Workspace member removed',
      actor: { memberId: MEMBER_ID, name: 'Alex' },
      session: transactionSession,
    })
    expect(mocks.deliverTestDriveRuntimeRevocations).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID.toString(),
      roundIds: [],
    })
    expect(mocks.kickDueTestDriveCleanups).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID.toString(),
      now: NOW,
    })
    expect(mocks.cancelTestDrivesForMember.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.kickDueTestDriveCleanups.mock.invocationCallOrder[0],
    )
    expect(mocks.sessionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: MEMBER_ID, revokedAt: { $exists: false } }),
      { $set: { revokedAt: NOW } },
      { session: transactionSession },
    )
    expect(mocks.setupUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: MEMBER_ID, consumedAt: { $exists: false } }),
      { $set: { consumedAt: NOW } },
      { session: transactionSession },
    )
    expect(mocks.memberUpdateOne.mock.calls[0][1]).not.toHaveProperty('$unset.name')
    expect(mocks.memberUpdateOne.mock.calls[0][1]).not.toHaveProperty('$unset.email')
  })

  it('requires an admin with another pending/active member to transfer first', async () => {
    mocks.memberFindOne.mockResolvedValue(currentMember('admin'))
    mocks.memberExists.mockResolvedValue({ _id: new mongoose.Types.ObjectId() })

    await expect(
      selfDeleteHireMember(context('admin'), { operationId: OPERATION_ID }, NOW),
    ).rejects.toMatchObject({ code: 'HIRE_ADMIN_TRANSFER_REQUIRED', statusCode: 409 })
    expect(mocks.softDeleteWorkspace).not.toHaveBeenCalled()
    expect(mocks.memberUpdateOne).not.toHaveBeenCalled()
  })

  it('requires exact-name and explicit 30-day deletion confirmation from a sole admin', async () => {
    mocks.memberFindOne.mockResolvedValue(currentMember('admin'))

    await expect(
      selfDeleteHireMember(context('admin'), { operationId: OPERATION_ID }, NOW),
    ).rejects.toBeInstanceOf(HireWorkspaceDeletionConfirmationError)
    await expect(
      selfDeleteHireMember(context('admin'), { operationId: OPERATION_ID }, NOW),
    ).rejects.toMatchObject({
      code: 'HIRE_WORKSPACE_DELETE_CONFIRMATION_REQUIRED',
      workspaceName: 'Acme Hiring',
    })
    expect(mocks.softDeleteWorkspace).not.toHaveBeenCalled()
  })

  it('schedules the ordinary 30-day workspace deletion before removing a sole admin', async () => {
    const purgeAfter = new Date('2026-09-09T00:00:00.000Z')
    mocks.memberFindOne.mockResolvedValue(currentMember('admin'))
    mocks.softDeleteWorkspace.mockResolvedValue({ purgeAfter })

    const result = await selfDeleteHireMember(
      context('admin'),
      {
        operationId: OPERATION_ID,
        workspaceConfirmationName: 'Acme Hiring',
        acknowledgeWorkspaceDeletion: true,
      },
      NOW,
    )

    expect(mocks.softDeleteWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: expect.objectContaining({ name: 'Acme Hiring' }),
        membership: expect.objectContaining({ role: 'admin' }),
      }),
      {
        confirmationName: 'Acme Hiring',
        acknowledgePermanentPurge: true,
        operationId: OPERATION_ID,
        requireSoleAdmin: true,
      },
      NOW,
    )
    expect(mocks.memberUpdateOne).toHaveBeenCalled()
    expect(result).toEqual({ workspaceDeletionScheduled: true, purgeAfter })
  })
})

describe('linked B2C deletion gate', () => {
  it('looks up the opaque B2C id only and never accepts an email identity', async () => {
    await expect(
      preflightLinkedB2CAccountDeletion({
        b2cUserId: B2C_USER_ID,
        operationId: OPERATION_ID,
      }),
    ).resolves.toEqual({ action: 'not_linked' })
    expect(mocks.getWorkspaceForUser).toHaveBeenCalledWith({
      userId: B2C_USER_ID,
      email: '',
    })
    expect(mocks.workspaceFindById).not.toHaveBeenCalled()
  })

  it('preflights a linked member without mutating Hire state', async () => {
    mocks.getWorkspaceForUser.mockResolvedValue({
      membership: currentMember('member'),
      workspace: { _id: WORKSPACE_ID, name: 'Acme Hiring' },
    })

    await expect(
      preflightLinkedB2CAccountDeletion({
        b2cUserId: B2C_USER_ID,
        operationId: OPERATION_ID,
      }),
    ).resolves.toEqual({ action: 'member_removal_required' })
    expect(mocks.memberUpdateOne).not.toHaveBeenCalled()
    expect(mocks.softDeleteWorkspace).not.toHaveBeenCalled()
  })

  it('commits linked member removal through the same session-revoking lifecycle', async () => {
    mocks.memberFindOne.mockResolvedValue(currentMember('member'))
    mocks.getWorkspaceForUser.mockResolvedValue({
      membership: currentMember('member'),
      workspace: { _id: WORKSPACE_ID, name: 'Acme Hiring' },
    })

    await expect(
      commitLinkedB2CAccountDeletion(
        { b2cUserId: B2C_USER_ID, operationId: OPERATION_ID },
        NOW,
      ),
    ).resolves.toEqual({ action: 'member_removed' })
    expect(mocks.memberUpdateOne).toHaveBeenCalled()
    expect(mocks.sessionUpdateMany).toHaveBeenCalled()
  })
})
