/**
 * PR "grounded follow-ups" — /api/evaluate-code flag gating.
 *
 * Contract: with grounded_followups ON, the prompt requests grounded_follow_up
 * (calibrated by the flow templates' band guidance) and the field passes
 * through; with the flag OFF the prompt is unchanged and the field is STRIPPED
 * even if the model volunteers it — absence is the client's fallback signal,
 * so flag-off must be byte-identical to pre-flag behavior.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  userId: '69fb49747e70dc410e5a2f12',
  completion: vi.fn(),
  isFeatureEnabled: vi.fn(),
  trackUsage: vi.fn(),
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
vi.mock('@shared/featureFlags', () => ({ isFeatureEnabled: mocks.isFeatureEnabled }))
vi.mock('@shared/services/usageTracking', () => ({ trackUsage: mocks.trackUsage }))
vi.mock('@shared/services/promptSecurity', () => ({
  JSON_OUTPUT_RULE: 'JSON_OUTPUT_RULE',
  DATA_BOUNDARY_RULE: 'DATA_BOUNDARY_RULE',
}))
vi.mock('@shared/logger', () => ({
  aiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { POST } from '../route'

const EVAL = {
  correctness: 80,
  efficiency: 70,
  code_quality: 75,
  communication: 60,
  edge_cases: 65,
  feedback: 'Solid solution.',
  complexity: 'O(n) time, O(1) space',
  flags: [],
  grounded_follow_up: 'Your processOrders uses a nested loop — what is its complexity?',
}

const makeReq = (extra: Record<string, unknown> = {}) =>
  new NextRequest('http://localhost/api/evaluate-code', {
    method: 'POST',
    body: JSON.stringify({
      code: 'def solution():\n    pass',
      language: 'python',
      problemTitle: 'Two Sum',
      problemDescription: 'Find two numbers that add to target.',
      questionIndex: 1,
      domain: 'backend',
      experience: '3-6',
      ...extra,
    }),
  })

const systemOf = (n: number): string => mocks.completion.mock.calls[n][0].system as string
const promptOf = (n: number): string => mocks.completion.mock.calls[n][0].messages[0].content as string

beforeEach(() => {
  vi.clearAllMocks()
  mocks.trackUsage.mockResolvedValue(undefined)
  mocks.completion.mockResolvedValue({ text: JSON.stringify(EVAL) })
})

describe('POST /api/evaluate-code — grounded_followups ON', () => {
  beforeEach(() => mocks.isFeatureEnabled.mockReturnValue(true))

  it('requests grounded_follow_up with band calibration and passes it through', async () => {
    const res = await POST(makeReq())
    expect(systemOf(0)).toContain('"grounded_follow_up"')
    expect(systemOf(0)).toContain('FOLLOW-UP CALIBRATION')
    const data = await res.json()
    expect(data.grounded_follow_up).toBe(EVAL.grounded_follow_up)
  })

  it('strips a non-string/empty grounded_follow_up instead of leaking it', async () => {
    mocks.completion.mockResolvedValue({ text: JSON.stringify({ ...EVAL, grounded_follow_up: '   ' }) })
    const data = await (await POST(makeReq())).json()
    expect(data.grounded_follow_up).toBeUndefined()
  })

  it('omits calibration when domain/experience are absent but still requests the field', async () => {
    await POST(makeReq({ domain: undefined, experience: undefined }))
    expect(systemOf(0)).toContain('"grounded_follow_up"')
    expect(systemOf(0)).not.toContain('FOLLOW-UP CALIBRATION')
  })

  it('accepts a full-length (100-char) CMS domain slug — the optional field must never 400 the eval', async () => {
    const res = await POST(makeReq({ domain: 'x'.repeat(100) }))
    expect(res.status).toBe(200)
  })
})

describe('POST /api/evaluate-code — grounded_followups OFF', () => {
  beforeEach(() => mocks.isFeatureEnabled.mockReturnValue(false))

  it('keeps the prompt byte-identical to pre-flag behavior', async () => {
    await POST(makeReq())
    expect(systemOf(0)).not.toContain('grounded_follow_up')
    expect(systemOf(0)).not.toContain('FOLLOW-UP CALIBRATION')
  })

  it('strips the field even if the model volunteers it', async () => {
    const data = await (await POST(makeReq())).json()
    expect(data.grounded_follow_up).toBeUndefined()
    expect(data.feedback).toBe('Solid solution.')
  })
})
