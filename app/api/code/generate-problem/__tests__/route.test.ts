/**
 * PR "served-problem ledger" — /api/code/generate-problem ledger integration.
 *
 * Two new server-side behaviors: (1) exclusion is server-authoritative — the
 * route unions its own ServedProblem ledger read with the client-sent
 * solvedProblemIds (ledger first) before calling the generator, so a client
 * whose history fetch failed (sent []) still generates with full exclusions;
 * (2) a successfully generated problem is recorded in the ledger BEFORE the
 * response returns, with its full body, so a served AI problem can never go
 * unrecorded by client failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  userId: '69fb49747e70dc410e5a2f12',
  generateCodingProblem: vi.fn(),
  getServedProblemIds: vi.fn(),
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

vi.mock('@interview/services/core/codingProblemGenerator', () => ({
  generateCodingProblem: mocks.generateCodingProblem,
}))

vi.mock('@interview/services/core/servedProblemLedger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../modules/interview/services/core/servedProblemLedger')>()
  return {
    ...actual,
    getServedProblemIds: mocks.getServedProblemIds,
    recordServedProblem: mocks.recordServedProblem,
  }
})

vi.mock('@shared/logger', () => ({
  aiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { POST } from '../route'

const makeReq = (body: unknown) =>
  new NextRequest('http://localhost/api/code/generate-problem', {
    method: 'POST',
    body: JSON.stringify(body),
  })

const AI_PROBLEM = {
  id: 'ai-gen-42',
  title: 'Stream Deduplicator',
  difficulty: 'medium',
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getServedProblemIds.mockResolvedValue([])
  mocks.recordServedProblem.mockResolvedValue(undefined)
  mocks.generateCodingProblem.mockResolvedValue(AI_PROBLEM)
})

describe('POST /api/code/generate-problem', () => {
  it('unions ledger ids (first) with client ids before generating', async () => {
    mocks.getServedProblemIds.mockResolvedValue(['ledger-1', 'shared-id'])
    await POST(makeReq({
      domain: 'backend',
      experience: '3-6',
      solvedProblemIds: ['client-1', 'shared-id'],
    }))
    expect(mocks.getServedProblemIds).toHaveBeenCalledWith(mocks.userId, 'coding')
    expect(mocks.generateCodingProblem).toHaveBeenCalledWith(
      'backend',
      '3-6',
      ['ledger-1', 'shared-id', 'client-1'],
      undefined,
      undefined,
      undefined,
    )
  })

  it('records the generated problem in the ledger before responding', async () => {
    const res = await POST(makeReq({ domain: 'backend', experience: '3-6' }))
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ problem: AI_PROBLEM })
    expect(mocks.recordServedProblem).toHaveBeenCalledWith({
      userId: mocks.userId,
      kind: 'coding',
      problemId: 'ai-gen-42',
      title: 'Stream Deduplicator',
      domain: 'backend',
      difficulty: 'medium',
      source: 'ai',
      problemBody: AI_PROBLEM,
    })
  })

  it('returns { problem: null } and records nothing when generation fails', async () => {
    mocks.generateCodingProblem.mockRejectedValue(new Error('LLM down'))
    const res = await POST(makeReq({ domain: 'backend', experience: '3-6' }))
    await expect(res.json()).resolves.toEqual({ problem: null })
    expect(mocks.recordServedProblem).not.toHaveBeenCalled()
  })
})
