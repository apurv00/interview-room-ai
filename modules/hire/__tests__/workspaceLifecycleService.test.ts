/**
 * Orphaned-workspace cascade (founder ruling 2026-08-09). The two things
 * that must never be wrong: a workspace with surviving members is NEVER
 * touched when one member leaves, and an orphaned one takes its
 * candidates' data with it — including the synthetic guest users whose
 * interview sessions hold transcripts and recording keys.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }))

const mockSession = { deleteMany: vi.fn(), find: vi.fn() }
const mockUser = { deleteMany: vi.fn(), countDocuments: vi.fn(), updateMany: vi.fn() }
const mockAnalysis = { deleteMany: vi.fn() }
vi.mock('@shared/db/models', () => ({
  InterviewSession: {
    deleteMany: (...a: unknown[]) => mockSession.deleteMany(...a),
    find: (...a: unknown[]) => mockSession.find(...a),
  },
  User: {
    deleteMany: (...a: unknown[]) => mockUser.deleteMany(...a),
    countDocuments: (...a: unknown[]) => mockUser.countDocuments(...a),
    updateMany: (...a: unknown[]) => mockUser.updateMany(...a),
  },
  MultimodalAnalysis: { deleteMany: (...a: unknown[]) => mockAnalysis.deleteMany(...a) },
}))

const r2DeleteMock = vi.fn()
vi.mock('@shared/storage/r2', () => ({
  deleteFromR2: (...a: unknown[]) => r2DeleteMock(...a),
}))

const m = {
  member: { find: vi.fn(), countDocuments: vi.fn(), deleteMany: vi.fn() },
  round: { find: vi.fn(), deleteMany: vi.fn() },
  application: { deleteMany: vi.fn() },
  candidate: { deleteMany: vi.fn() },
  job: { deleteMany: vi.fn() },
  workspace: { deleteMany: vi.fn() },
}
vi.mock('../models', () => ({
  HireWorkspaceMember: {
    find: (...a: unknown[]) => m.member.find(...a),
    countDocuments: (...a: unknown[]) => m.member.countDocuments(...a),
    deleteMany: (...a: unknown[]) => m.member.deleteMany(...a),
  },
  HireRound: {
    find: (...a: unknown[]) => m.round.find(...a),
    deleteMany: (...a: unknown[]) => m.round.deleteMany(...a),
  },
  HireApplication: { deleteMany: (...a: unknown[]) => m.application.deleteMany(...a) },
  HireCandidate: { deleteMany: (...a: unknown[]) => m.candidate.deleteMany(...a) },
  HireJob: { deleteMany: (...a: unknown[]) => m.job.deleteMany(...a) },
  HireWorkspace: { deleteMany: (...a: unknown[]) => m.workspace.deleteMany(...a) },
}))

import mongoose from 'mongoose'
import { deleteOrphanedWorkspacesForUser } from '../services/workspaceLifecycleService'

const USER = new mongoose.Types.ObjectId()
const WS = new mongoose.Types.ObjectId()
const GUEST = new mongoose.Types.ObjectId()

beforeEach(() => {
  vi.clearAllMocks()
  m.member.find.mockReturnValue({ select: () => Promise.resolve([{ workspaceId: WS }]) })
  mockSession.find.mockReturnValue({ select: () => Promise.resolve([]) })
  mockUser.updateMany.mockResolvedValue({ modifiedCount: 1 })
  mockAnalysis.deleteMany.mockResolvedValue({ deletedCount: 1 })
  r2DeleteMock.mockResolvedValue(undefined)
  m.round.find.mockReturnValue({ select: () => Promise.resolve([{ guestUserId: GUEST }]) })
  for (const op of [
    m.member.deleteMany, m.round.deleteMany, m.application.deleteMany,
    m.candidate.deleteMany, m.job.deleteMany, m.workspace.deleteMany,
    mockSession.deleteMany, mockUser.deleteMany,
  ]) op.mockResolvedValue({ deletedCount: 1 })
})

describe('a workspace with surviving members is untouched', () => {
  it('deletes nothing when another member still holds an account', async () => {
    m.member.find.mockReturnValueOnce({ select: () => Promise.resolve([{ workspaceId: WS }]) })
      .mockReturnValueOnce({ select: () => Promise.resolve([{ userId: new mongoose.Types.ObjectId() }]) })
    mockUser.countDocuments.mockResolvedValue(1) // that member's account is live

    const cleared = await deleteOrphanedWorkspacesForUser(USER)

    expect(cleared).toEqual({})
    // One recruiter leaving must never delete their team's pipeline.
    for (const op of [m.workspace.deleteMany, m.candidate.deleteMany, m.job.deleteMany]) {
      expect(op).not.toHaveBeenCalled()
    }
  })

  it('does NOT count a membership whose User is already deleted', async () => {
    const ghost = new mongoose.Types.ObjectId()
    m.member.find
      .mockReturnValueOnce({ select: () => Promise.resolve([{ workspaceId: WS }]) })
      .mockReturnValueOnce({ select: () => Promise.resolve([{ userId: ghost }]) })
    // The row survives, the account does not — the previous version counted
    // this as a survivor and orphaned the workspace forever.
    mockUser.countDocuments.mockResolvedValue(0)

    await deleteOrphanedWorkspacesForUser(USER)

    expect(m.workspace.deleteMany).toHaveBeenCalled()
    expect(mockUser.countDocuments.mock.calls[0][0]).toMatchObject({
      accountState: { $ne: 'deleting' },
    })
  })
})

describe('an orphaned workspace takes its candidates’ data with it', () => {
  beforeEach(() => {
    m.member.find
      .mockReturnValueOnce({ select: () => Promise.resolve([{ workspaceId: WS }]) })
      .mockReturnValueOnce({ select: () => Promise.resolve([]) })
    mockUser.countDocuments.mockResolvedValue(0)
  })

  it('sweeps every hire collection for that workspace', async () => {
    const cleared = await deleteOrphanedWorkspacesForUser(USER)

    for (const op of [
      m.round.deleteMany, m.application.deleteMany, m.candidate.deleteMany,
      m.job.deleteMany, m.member.deleteMany, m.workspace.deleteMany,
    ]) {
      expect(op).toHaveBeenCalled()
    }
    expect(cleared['HireCandidate']).toBe(1)
    expect(cleared['HireWorkspace']).toBe(1)
  })

  it('deletes the synthetic guests and their interview sessions', async () => {
    // These hold transcripts and recording keys and are keyed by the
    // per-round synthetic id, so a userId-keyed pass never reaches them.
    await deleteOrphanedWorkspacesForUser(USER)

    expect(mockSession.deleteMany).toHaveBeenCalledWith({ userId: { $in: [GUEST] } })
    expect(mockUser.deleteMany).toHaveBeenCalledWith({ _id: { $in: [GUEST] } })
  })

  it('deletes guest R2 objects BEFORE the session rows that inventory them', async () => {
    const order: string[] = []
    mockSession.find.mockReturnValue({
      select: () => Promise.resolve([{ _id: 's1', recordingR2Key: 'rec/1', audioRecordingR2Key: 'aud/1' }]),
    })
    r2DeleteMock.mockImplementation((key: string) => {
      order.push(`r2:${key}`)
      return Promise.resolve()
    })
    mockSession.deleteMany.mockImplementation(() => {
      order.push('sessions-deleted')
      return Promise.resolve({ deletedCount: 1 })
    })

    await deleteOrphanedWorkspacesForUser(USER)

    // A row deleted first would strand the recording in R2, undiscoverable.
    expect(order).toEqual(['r2:rec/1', 'r2:aud/1', 'sessions-deleted'])
  })

  it('deletes the membership ANCHOR last so a failed sweep stays retryable', async () => {
    const order: string[] = []
    m.candidate.deleteMany.mockImplementation(() => {
      order.push('content')
      return Promise.resolve({ deletedCount: 1 })
    })
    m.member.deleteMany.mockImplementation(() => {
      order.push('anchor')
      return Promise.resolve({ deletedCount: 1 })
    })

    await deleteOrphanedWorkspacesForUser(USER)
    expect(order).toEqual(['content', 'anchor'])
  })

  it('collects guest ids BEFORE deleting the rounds that carry them', async () => {
    const order: string[] = []
    m.round.find.mockReturnValue({
      select: () => {
        order.push('read-rounds')
        return Promise.resolve([{ guestUserId: GUEST }])
      },
    })
    m.round.deleteMany.mockImplementation(() => {
      order.push('delete-rounds')
      return Promise.resolve({ deletedCount: 1 })
    })

    await deleteOrphanedWorkspacesForUser(USER)
    expect(order).toEqual(['read-rounds', 'delete-rounds'])
  })

  it('skips the guest sweep entirely when no round ever minted one', async () => {
    m.round.find.mockReturnValue({ select: () => Promise.resolve([{ guestUserId: undefined }]) })
    await deleteOrphanedWorkspacesForUser(USER)
    expect(mockUser.deleteMany).not.toHaveBeenCalled()
  })
})


describe('guest artifact erasure is complete and race-fenced (Codex P1x3 on #619)', () => {
  beforeEach(() => {
    m.member.find
      .mockReturnValueOnce({ select: () => Promise.resolve([{ workspaceId: WS }]) })
      .mockReturnValueOnce({ select: () => Promise.resolve([]) })
    mockUser.countDocuments.mockResolvedValue(0)
    mockSession.find.mockReturnValue({
      select: () => Promise.resolve([{ _id: 's1', userId: GUEST, recordingR2Key: `recordings/${GUEST}/a.webm` }]),
    })
  })

  it('authorizes R2 deletion with the GUEST who owns the key namespace', async () => {
    await deleteOrphanedWorkspacesForUser(USER)
    // Passing the recruiter's id made deleteFromR2 reject every guest
    // artifact and fail the whole deletion.
    expect(r2DeleteMock).toHaveBeenCalledWith(
      `recordings/${GUEST}/a.webm`,
      expect.objectContaining({ ownerUserId: String(GUEST) }),
    )
  })

  it('sweeps guest MultimodalAnalysis, which holds transcripts and facial segments', async () => {
    await deleteOrphanedWorkspacesForUser(USER)
    expect(mockAnalysis.deleteMany).toHaveBeenCalledWith({ userId: { $in: [GUEST] } })
  })

  it('fences guest writes BEFORE inventorying artifacts', async () => {
    const order: string[] = []
    mockUser.updateMany.mockImplementation(() => {
      order.push('fence')
      return Promise.resolve({ modifiedCount: 1 })
    })
    mockSession.find.mockImplementation(() => {
      order.push('inventory')
      return { select: () => Promise.resolve([]) }
    })

    await deleteOrphanedWorkspacesForUser(USER)

    // Inventory first would let a mid-interview recording attach a key
    // after the read and orphan the object permanently.
    expect(order).toEqual(['fence', 'inventory'])
    expect(mockUser.updateMany.mock.calls[0][1]).toMatchObject({
      $set: expect.objectContaining({ accountState: 'deleting' }),
    })
  })
})
