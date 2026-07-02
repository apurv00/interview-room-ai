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
  getServedProblemSummaries: vi.fn(),
  countServedProblems: vi.fn(),
  recordServedProblem: vi.fn(),
  buildDesignSeedBlock: vi.fn(),
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
    getServedProblemSummaries: mocks.getServedProblemSummaries,
    countServedProblems: mocks.countServedProblems,
    recordServedProblem: mocks.recordServedProblem,
  }
})

vi.mock('@interview/services/core/problemSeeds', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../modules/interview/services/core/problemSeeds')>()
  return {
    ...actual,
    buildDesignSeedBlock: mocks.buildDesignSeedBlock,
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
  mocks.getServedProblemSummaries.mockResolvedValue([])
  mocks.countServedProblems.mockResolvedValue(0)
  mocks.recordServedProblem.mockResolvedValue(undefined)
  mocks.buildDesignSeedBlock.mockResolvedValue({ block: '\n<style_exemplars>SEED</style_exemplars>\n', exemplarTitles: [] })
  mocks.completion.mockResolvedValue({ text: JSON.stringify(GENERATED) })
})

const promptOfCall = (n: number): string =>
  mocks.completion.mock.calls[n][0].messages[0].content as string

describe('POST /api/design/generate-problem', () => {
  it('injects the titled ledger∪client avoid-list and the seed block into the prompt', async () => {
    mocks.getServedProblemSummaries.mockResolvedValue([
      { problemId: 'ledger-a', title: 'Ledger Alpha' },
      { problemId: 'shared-x' },
    ])
    await POST(makeReq({
      domain: 'ml-engineer',
      experience: '3-6',
      solvedProblemIds: ['client-b', 'shared-x'],
    }))
    expect(mocks.getServedProblemSummaries).toHaveBeenCalledWith(mocks.userId, 'system-design')
    const promptContent = promptOfCall(0)
    expect(promptContent).toContain('- Ledger Alpha (ledger-a)')
    expect(promptContent).toContain('- shared-x')
    expect(promptContent).toContain('- client-b')
    expect(promptContent).toContain('<style_exemplars>SEED</style_exemplars>')
    expect(mocks.buildDesignSeedBlock).toHaveBeenCalledWith('ml-engineer', 'medium')
  })

  it('honors the client difficulty override', async () => {
    await POST(makeReq({ domain: 'backend', experience: '0-2', difficulty: 'hard' }))
    expect(promptOfCall(0)).toContain('Generate a hard system-design problem')
  })

  it('adds the progression nudge from the 3rd problem in a domain', async () => {
    mocks.countServedProblems.mockResolvedValue(2)
    await POST(makeReq({ domain: 'backend', experience: '3-6' }))
    expect(promptOfCall(0)).toContain('problem #3')
    expect(promptOfCall(0)).toContain('UPPER END of medium')
  })

  it('retries once, naming the collision, when the result near-duplicates a served title', async () => {
    mocks.getServedProblemSummaries.mockResolvedValue([
      { problemId: 'url-shortener', title: 'Design a URL Shortener' },
    ])
    mocks.completion
      .mockResolvedValueOnce({ text: JSON.stringify({ ...GENERATED, id: 'dup', title: 'URL Shortener at Scale', tags: [] }) })
      .mockResolvedValueOnce({ text: JSON.stringify(GENERATED) })

    const res = await POST(makeReq({ domain: 'backend', experience: '3-6' }))
    const data = await res.json()
    expect(mocks.completion).toHaveBeenCalledTimes(2)
    expect(promptOfCall(1)).toContain('too similar to "Design a URL Shortener"')
    expect(data.problem.title).toBe('Design a Feature Store')
    // Only the final (non-colliding) problem is recorded.
    expect(mocks.recordServedProblem).toHaveBeenCalledTimes(1)
    expect(mocks.recordServedProblem).toHaveBeenCalledWith(
      expect.objectContaining({ problemId: 'ai-feature-store-design' })
    )
  })

  it('delivers the near-duplicate first candidate when the retry is unparseable (Codex P2 on #486)', async () => {
    mocks.getServedProblemSummaries.mockResolvedValue([
      { problemId: 'url-shortener', title: 'Design a URL Shortener' },
    ])
    mocks.completion
      .mockResolvedValueOnce({ text: JSON.stringify({ ...GENERATED, id: 'dup', title: 'URL Shortener at Scale', tags: [] }) })
      .mockResolvedValueOnce({ text: 'sorry, no json here' })

    const res = await POST(makeReq({ domain: 'backend', experience: '3-6' }))
    const data = await res.json()
    // A duplicate in hand beats no problem — the first candidate ships.
    expect(data.problem.title).toBe('URL Shortener at Scale')
    expect(mocks.recordServedProblem).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'URL Shortener at Scale' })
    )
  })

  it('delivers the first candidate when the retry call throws', async () => {
    mocks.getServedProblemSummaries.mockResolvedValue([
      { problemId: 'url-shortener', title: 'Design a URL Shortener' },
    ])
    mocks.completion
      .mockResolvedValueOnce({ text: JSON.stringify({ ...GENERATED, id: 'dup', title: 'URL Shortener at Scale', tags: [] }) })
      .mockRejectedValueOnce(new Error('LLM down'))

    const data = await (await POST(makeReq({ domain: 'backend', experience: '3-6' }))).json()
    expect(data.problem.title).toBe('URL Shortener at Scale')
  })

  it('still returns null when the FIRST attempt has no JSON (no candidate to fall back on)', async () => {
    mocks.completion.mockResolvedValue({ text: 'nope' })
    const data = await (await POST(makeReq({ domain: 'backend', experience: '3-6' }))).json()
    expect(data).toEqual({ problem: null })
    expect(mocks.recordServedProblem).not.toHaveBeenCalled()
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
