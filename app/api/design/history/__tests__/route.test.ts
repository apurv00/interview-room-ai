/**
 * PR "served-problem ledger" — GET /api/design/history union.
 * Mirror of the /api/code/history test: ledger ids (kind 'system-design')
 * first, legacy InterviewSession.designProblemId ids after, deduped.
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

describe('GET /api/design/history', () => {
  it('returns ledger ids first, then legacy session ids, deduped', async () => {
    mocks.getServedProblemIds.mockResolvedValue(['ai-design-backend-1', 'url-shortener'])
    mocks.sessionFind.mockReturnValue(sessionChain([
      { designProblemId: 'url-shortener' },
      { designProblemId: 'rate-limiter' },
    ]))

    const res = await GET(new NextRequest('http://localhost/api/design/history'))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.solvedProblemIds).toEqual(['ai-design-backend-1', 'url-shortener', 'rate-limiter'])
    expect(data.totalSolved).toBe(3)
    expect(mocks.getServedProblemIds).toHaveBeenCalledWith(mocks.userId, 'system-design')
  })

  it('401s when unauthenticated', async () => {
    mocks.getServerSession.mockResolvedValue(null)
    const res = await GET(new NextRequest('http://localhost/api/design/history'))
    expect(res.status).toBe(401)
    expect(mocks.getServedProblemIds).not.toHaveBeenCalled()
  })
})
