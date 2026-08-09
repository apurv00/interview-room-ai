/**
 * Orphaned-workspace cascade (founder ruling 2026-08-09). The two things
 * that must never be wrong: a workspace with surviving members is NEVER
 * touched when one member leaves, and an orphaned one takes its
 * candidates' data with it — including the synthetic guest users whose
 * interview sessions hold transcripts and recording keys.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }))

const mockSession = { deleteMany: vi.fn() }
const mockUser = { deleteMany: vi.fn() }
vi.mock('@shared/db/models', () => ({
  InterviewSession: { deleteMany: (...a: unknown[]) => mockSession.deleteMany(...a) },
  User: { deleteMany: (...a: unknown[]) => mockUser.deleteMany(...a) },
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
  m.round.find.mockReturnValue({ select: () => Promise.resolve([{ guestUserId: GUEST }]) })
  for (const op of [
    m.member.deleteMany, m.round.deleteMany, m.application.deleteMany,
    m.candidate.deleteMany, m.job.deleteMany, m.workspace.deleteMany,
    mockSession.deleteMany, mockUser.deleteMany,
  ]) op.mockResolvedValue({ deletedCount: 1 })
})

describe('a workspace with surviving members is untouched', () => {
  it('deletes nothing when another member still holds an account', async () => {
    m.member.countDocuments.mockResolvedValue(1)

    const cleared = await deleteOrphanedWorkspacesForUser(USER)

    expect(cleared).toEqual({})
    // One recruiter leaving must never delete their team's pipeline.
    for (const op of [m.workspace.deleteMany, m.candidate.deleteMany, m.job.deleteMany]) {
      expect(op).not.toHaveBeenCalled()
    }
  })

  it('excludes the departing member from the survivor count', async () => {
    m.member.countDocuments.mockResolvedValue(0)
    await deleteOrphanedWorkspacesForUser(USER)
    expect(m.member.countDocuments.mock.calls[0][0]).toMatchObject({
      workspaceId: WS,
      userId: { $exists: true, $ne: USER },
    })
  })
})

describe('an orphaned workspace takes its candidates’ data with it', () => {
  beforeEach(() => m.member.countDocuments.mockResolvedValue(0))

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
