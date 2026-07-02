/**
 * PR "served-problem ledger" — POST /api/problems/served.
 *
 * The interview page fires this at problem-selection time for static picks.
 * Contract: records under the AUTHENTICATED user (never a client-sent id),
 * validates kind/source enums and length caps, and always returns ok for a
 * valid body (the ledger service swallows DB errors by design).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  userId: '69fb49747e70dc410e5a2f12',
  recordServedProblem: vi.fn(),
}))

vi.mock('@shared/middleware/composeApiRoute', () => ({
  composeApiRoute: (opts: {
    schema?: { parse: (value: unknown) => unknown }
    handler: (
      req: NextRequest,
      ctx: { user: { id: string }; body: unknown; params: Record<string, string> }
    ) => Promise<Response>
  }) => async (req: NextRequest) => {
    const raw = await req.json()
    const body = opts.schema ? opts.schema.parse(raw) : raw
    return opts.handler(req, { user: { id: mocks.userId }, body, params: {} })
  },
}))

vi.mock('@interview/services/core/servedProblemLedger', () => ({
  recordServedProblem: mocks.recordServedProblem,
}))

import { POST } from '../route'

const makeReq = (body: unknown) =>
  new NextRequest('http://localhost/api/problems/served', {
    method: 'POST',
    body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.recordServedProblem.mockResolvedValue(undefined)
})

describe('POST /api/problems/served', () => {
  it('records the problem under the authenticated user and returns ok', async () => {
    const res = await POST(makeReq({
      kind: 'coding',
      problemId: 'two-sum',
      title: 'Two Sum',
      domain: 'backend',
      difficulty: 'easy',
      source: 'static',
    }))
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
    expect(mocks.recordServedProblem).toHaveBeenCalledWith({
      userId: mocks.userId,
      kind: 'coding',
      problemId: 'two-sum',
      title: 'Two Sum',
      domain: 'backend',
      difficulty: 'easy',
      source: 'static',
    })
  })

  it('accepts the minimal body (no title/domain/difficulty)', async () => {
    const res = await POST(makeReq({
      kind: 'system-design',
      problemId: 'ai-design-backend-1719900000000',
      source: 'ai',
    }))
    expect(res.status).toBe(200)
    expect(mocks.recordServedProblem).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'system-design', source: 'ai' })
    )
  })

  it('rejects an invalid kind', async () => {
    await expect(POST(makeReq({
      kind: 'behavioral',
      problemId: 'p',
      source: 'static',
    }))).rejects.toThrow()
    expect(mocks.recordServedProblem).not.toHaveBeenCalled()
  })

  it('rejects an empty problemId', async () => {
    await expect(POST(makeReq({
      kind: 'coding',
      problemId: '',
      source: 'static',
    }))).rejects.toThrow()
  })

  it('rejects an invalid source', async () => {
    await expect(POST(makeReq({
      kind: 'coding',
      problemId: 'p',
      source: 'manual',
    }))).rejects.toThrow()
  })
})
