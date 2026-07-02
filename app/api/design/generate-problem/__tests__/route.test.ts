/**
 * PR "served-problem ledger" — /api/design/generate-problem ledger integration.
 *
 * Mirrors the code-generation test: the avoid-list injected into the LLM
 * prompt must be the ledger∪client union (ledger first — proves a client that
 * sent [] still generates with server-side exclusions), and the generated
 * problem must be recorded in the ledger before the response returns.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  userId: '69fb49747e70dc410e5a2f12',
  completion: vi.fn(),
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

vi.mock('@shared/services/modelRouter', () => ({ completion: mocks.completion }))
vi.mock('@shared/services/promptSecurity', () => ({
  JSON_OUTPUT_RULE: 'JSON_OUTPUT_RULE',
  DATA_BOUNDARY_RULE: 'DATA_BOUNDARY_RULE',
}))
vi.mock('@shared/services/sanitizeGeneratedText', () => ({
  sanitizeGeneratedText: (s: unknown) => s,
}))
vi.mock('@shared/logger', () => ({
  aiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@interview/services/core/servedProblemLedger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../modules/interview/services/core/servedProblemLedger')>()
  return {
    ...actual,
    getServedProblemIds: mocks.getServedProblemIds,
    recordServedProblem: mocks.recordServedProblem,
  }
})

import { POST } from '../route'

const makeReq = (body: unknown) =>
  new NextRequest('http://localhost/api/design/generate-problem', {
    method: 'POST',
    body: JSON.stringify(body),
  })

const GENERATED = {
  id: 'feature-store-design',
  title: 'Design a Feature Store',
  description: 'Design an online/offline feature store.',
  requirements: ['low-latency reads'],
  expectedComponents: ['feature_registry'],
  hints: ['start with the read path'],
  tags: ['ml'],
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getServedProblemIds.mockResolvedValue([])
  mocks.recordServedProblem.mockResolvedValue(undefined)
  mocks.completion.mockResolvedValue({ text: JSON.stringify(GENERATED) })
})

describe('POST /api/design/generate-problem', () => {
  it('injects the ledger∪client avoid-list into the prompt, ledger first', async () => {
    mocks.getServedProblemIds.mockResolvedValue(['ledger-a', 'shared-x'])
    await POST(makeReq({
      domain: 'ml-engineer',
      experience: '3-6',
      solvedProblemIds: ['client-b', 'shared-x'],
    }))
    expect(mocks.getServedProblemIds).toHaveBeenCalledWith(mocks.userId, 'system-design')
    const promptContent = mocks.completion.mock.calls[0][0].messages[0].content as string
    expect(promptContent).toContain('ledger-a, shared-x, client-b')
  })

  it('records the generated problem in the ledger before responding', async () => {
    const res = await POST(makeReq({ domain: 'ml-engineer', experience: '3-6' }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.problem.id).toBe('ai-feature-store-design')
    expect(mocks.recordServedProblem).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: mocks.userId,
        kind: 'system-design',
        problemId: 'ai-feature-store-design',
        title: 'Design a Feature Store',
        domain: 'ml-engineer',
        source: 'ai',
      })
    )
  })

  it('returns { problem: null } and records nothing when the LLM output has no JSON', async () => {
    mocks.completion.mockResolvedValue({ text: 'sorry, no' })
    const res = await POST(makeReq({ domain: 'backend', experience: '3-6' }))
    await expect(res.json()).resolves.toEqual({ problem: null })
    expect(mocks.recordServedProblem).not.toHaveBeenCalled()
  })

  it('returns { problem: null } when completion throws', async () => {
    mocks.completion.mockRejectedValue(new Error('LLM down'))
    const res = await POST(makeReq({ domain: 'backend', experience: '3-6' }))
    await expect(res.json()).resolves.toEqual({ problem: null })
    expect(mocks.recordServedProblem).not.toHaveBeenCalled()
  })
})
