/**
 * Contract tests for GET /api/learn/drill/context/pathway.
 *
 * Pathway P2 Wave 5 (5A). Critical contract: 404 on stale taskId
 * is NOT an error state — it just means Inngest pathway regen has
 * replaced the practiceTasks[] since the URL was minted, and
 * PathwayEntryStrip is supposed to silently hide. The test locks
 * that the route returns 404 (not 500) in that case.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import mongoose from 'mongoose'

const { mockGetServerSession, mockFindOne } = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockFindOne: vi.fn(),
}))

vi.mock('next-auth', () => ({
  getServerSession: (...a: unknown[]) => mockGetServerSession(...a),
}))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@shared/db/models', () => ({
  PathwayPlan: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
  },
}))
vi.mock('@shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { GET } from '../route'

const USER_ID = new mongoose.Types.ObjectId().toString()

function chain(result: unknown) {
  return {
    sort: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(result),
  }
}

beforeEach(() => {
  mockGetServerSession.mockReset()
  mockFindOne.mockReset()
})

describe('GET /api/learn/drill/context/pathway', () => {
  it('401 when unauthenticated', async () => {
    mockGetServerSession.mockResolvedValue(null)
    const req = new NextRequest(
      'http://localhost/api/learn/drill/context/pathway?taskId=task-1',
    )
    const res = await GET(req)
    expect(res.status).toBe(401)
  })

  it('400 when taskId is missing', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    const req = new NextRequest(
      'http://localhost/api/learn/drill/context/pathway',
    )
    const res = await GET(req)
    expect(res.status).toBe(400)
  })

  it('404 when the user has no pathway plan at all', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    mockFindOne.mockReturnValue(chain(null))
    const req = new NextRequest(
      'http://localhost/api/learn/drill/context/pathway?taskId=task-1',
    )
    const res = await GET(req)
    expect(res.status).toBe(404)
  })

  it('404 (NOT 500) when the taskId is stale — most-likely scenario in production', async () => {
    // The user HAS a pathway plan but the requested task has been
    // replaced by Inngest regen. Strip is supposed to hide; 404 is
    // the contract that triggers that.
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    mockFindOne.mockReturnValue(
      chain({
        practiceTasks: [
          { taskId: 'fresh-task-1', description: 'A current task' },
          { taskId: 'fresh-task-2', description: 'Another current task' },
        ],
      }),
    )
    const req = new NextRequest(
      'http://localhost/api/learn/drill/context/pathway?taskId=stale-task-x',
    )
    const res = await GET(req)
    expect(res.status).toBe(404)
  })

  it('happy path: returns task description when taskId matches', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    mockFindOne.mockReturnValue(
      chain({
        practiceTasks: [
          {
            taskId: 'task-1',
            title: 'Practice specificity',
            description: 'Add metrics to your strongest behavioral story.',
          },
        ],
      }),
    )
    const req = new NextRequest(
      'http://localhost/api/learn/drill/context/pathway?taskId=task-1',
    )
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({
      taskId: 'task-1',
      title: 'Practice specificity',
      description: 'Add metrics to your strongest behavioral story.',
    })
  })
})
