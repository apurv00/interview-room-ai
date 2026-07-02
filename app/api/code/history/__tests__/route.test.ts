/**
 * PR "served-problem ledger" — GET /api/code/history union.
 *
 * The exclusion list is now the union of the server-authoritative ServedProblem
 * ledger and the legacy InterviewSession.codingProblemId record. Ledger ids
 * come FIRST (most-recent-first) so downstream prompt caps keep the freshest
 * exclusions; legacy ids append after, deduped. A ledger read failure inside
 * the service degrades to [] — the route must then still return legacy ids.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  userId: '69fb49747e70dc410e5a2f12',
  getServerSession: vi.fn(),
  connectDB: vi.fn(),
  sessionFind: vi.fn(),
  getServedProblemIds: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('@shared/db/models/InterviewSession', () => ({
  InterviewSession: { find: mocks.sessionFind },
}))
vi.mock('@interview/services/core/servedProblemLedger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../modules/interview/services/core/servedProblemLedger')>()
  return {
    ...actual,
    getServedProblemIds: mocks.getServedProblemIds,
  }
})

import { GET } from '../route'

const sessionChain = (rows: Array<Record<string, unknown>>) => ({
  select: vi.fn().mockReturnThis(),
  sort: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  lean: vi.fn().mockResolvedValue(rows),
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getServerSession.mockResolvedValue({ user: { id: mocks.userId } })
  mocks.connectDB.mockResolvedValue(undefined)
})

describe('GET /api/code/history', () => {
  it('returns ledger ids first, then legacy session ids, deduped', async () => {
    mocks.getServedProblemIds.mockResolvedValue(['ai-gen-2', 'two-sum'])
    mocks.sessionFind.mockReturnValue(sessionChain([
      { codingProblemId: 'two-sum' },
      { codingProblemId: 'valid-parentheses' },
    ]))

    const res = await GET(new NextRequest('http://localhost/api/code/history'))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.solvedProblemIds).toEqual(['ai-gen-2', 'two-sum', 'valid-parentheses'])
    expect(data.totalSolved).toBe(3)
    expect(mocks.getServedProblemIds).toHaveBeenCalledWith(mocks.userId, 'coding')
  })

  it('caps the union at 200 ids — the generate-problem Zod limit the client posts this back to', async () => {
    mocks.getServedProblemIds.mockResolvedValue(
      Array.from({ length: 250 }, (_, i) => `ledger-${i}`)
    )
    mocks.sessionFind.mockReturnValue(sessionChain(
      Array.from({ length: 50 }, (_, i) => ({ codingProblemId: `legacy-${i}` }))
    ))

    const res = await GET(new NextRequest('http://localhost/api/code/history'))
    const data = await res.json()
    expect(data.solvedProblemIds).toHaveLength(200)
    // Most-recent-first preserved — the cap sheds the stalest ids.
    expect(data.solvedProblemIds[0]).toBe('ledger-0')
  })

  it('still returns legacy ids when the ledger read degrades to []', async () => {
    mocks.getServedProblemIds.mockResolvedValue([])
    mocks.sessionFind.mockReturnValue(sessionChain([{ codingProblemId: 'two-sum' }]))

    const res = await GET(new NextRequest('http://localhost/api/code/history'))
    const data = await res.json()
    expect(data.solvedProblemIds).toEqual(['two-sum'])
  })

  it('401s when unauthenticated', async () => {
    mocks.getServerSession.mockResolvedValue(null)
    const res = await GET(new NextRequest('http://localhost/api/code/history'))
    expect(res.status).toBe(401)
    expect(mocks.getServedProblemIds).not.toHaveBeenCalled()
  })
})
