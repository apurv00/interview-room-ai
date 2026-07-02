/**
 * PR "grounded follow-ups" — /api/evaluate-design flag gating.
 *
 * Mirror of the evaluate-code test plus the design-only pieces: a SECOND
 * grounded trade-off probe, and the previously-dead problem
 * expectedComponents feeding gap-targeted probing. The legacy
 * follow_up_question field must keep flowing regardless of the flag (the
 * flag-off client appends it to spoken feedback, as today).
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
  requirements_clarity: 70,
  architecture: 75,
  scalability: 65,
  tradeoffs: 60,
  communication: 70,
  feedback: 'Reasonable structure.',
  missing_components: ['cache'],
  follow_up_question: 'Why no cache between app server and database?',
  flags: [],
  grounded_follow_up: 'Your API Gateway connects straight to the Database — what happens under write bursts?',
  grounded_follow_up_2: 'You chose a single region — what does that trade away for your latency requirement?',
}

const makeReq = (extra: Record<string, unknown> = {}) =>
  new NextRequest('http://localhost/api/evaluate-design', {
    method: 'POST',
    body: JSON.stringify({
      components: [
        { id: 'c1', type: 'api_gateway', label: 'API Gateway', x: 0, y: 0 },
        { id: 'c2', type: 'database', label: 'Database', x: 1, y: 1 },
      ],
      connections: [{ id: 'k1', from: 'c1', to: 'c2' }],
      problemTitle: 'Design a URL Shortener',
      problemDescription: 'Shorten links at scale.',
      requirements: ['100M links'],
      questionIndex: 1,
      domain: 'backend',
      experience: '0-2',
      expectedComponents: ['load_balancer', 'cache'],
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

describe('POST /api/evaluate-design — grounded_followups ON', () => {
  beforeEach(() => mocks.isFeatureEnabled.mockReturnValue(true))

  it('requests both grounded fields, injects calibration + expectedComponents, and passes them through', async () => {
    const res = await POST(makeReq())
    expect(systemOf(0)).toContain('"grounded_follow_up"')
    expect(systemOf(0)).toContain('"grounded_follow_up_2"')
    expect(systemOf(0)).toContain('FOLLOW-UP CALIBRATION')
    // Client-supplied component list rides INSIDE a data-boundary tag so a
    // tampered body can't inject directives (Codex P2 on #487).
    expect(promptOf(0)).toContain('<expected_components>\nload_balancer, cache\n</expected_components>')
    const data = await res.json()
    expect(data.grounded_follow_up).toBe(EVAL.grounded_follow_up)
    expect(data.grounded_follow_up_2).toBe(EVAL.grounded_follow_up_2)
    // legacy field still present (client ignores it on the grounded path)
    expect(data.follow_up_question).toBe(EVAL.follow_up_question)
  })

  it('strips malformed grounded fields independently', async () => {
    mocks.completion.mockResolvedValue({
      text: JSON.stringify({ ...EVAL, grounded_follow_up: 42, grounded_follow_up_2: 'Still valid?' }),
    })
    const data = await (await POST(makeReq())).json()
    expect(data.grounded_follow_up).toBeUndefined()
    expect(data.grounded_follow_up_2).toBe('Still valid?')
  })

  it('accepts a full-length (100-char) CMS domain slug — the optional field must never 400 the eval', async () => {
    const res = await POST(makeReq({ domain: 'x'.repeat(100) }))
    expect(res.status).toBe(200)
  })

  it('clamps oversized/malformed expectedComponents instead of 400ing the eval (Codex P2 on #487)', async () => {
    // AI-generated problems copy this array through uncapped; the client
    // posts it unconditionally — 40 items, one over-long label, one non-string.
    const oversized = [
      ...Array.from({ length: 40 }, (_, i) => `component_${i}`),
      'y'.repeat(300),
      42 as unknown as string,
    ]
    const res = await POST(makeReq({ expectedComponents: oversized }))
    expect(res.status).toBe(200)
    // Clamped to 30 items — prompt renders its first 15 as usual.
    expect(promptOf(0)).toContain('component_0')
  })

  it('treats a non-array expectedComponents as absent', async () => {
    const res = await POST(makeReq({ expectedComponents: 'not-an-array' }))
    expect(res.status).toBe(200)
    expect(promptOf(0)).not.toContain('<expected_components>')
  })
})

describe('POST /api/evaluate-design — grounded_followups OFF', () => {
  beforeEach(() => mocks.isFeatureEnabled.mockReturnValue(false))

  it('keeps the prompt byte-identical to pre-flag behavior', async () => {
    await POST(makeReq())
    expect(systemOf(0)).not.toContain('grounded_follow_up')
    expect(systemOf(0)).not.toContain('FOLLOW-UP CALIBRATION')
    expect(promptOf(0)).not.toContain('load_balancer, cache')
  })

  it('strips grounded fields but keeps the legacy follow_up_question', async () => {
    const data = await (await POST(makeReq())).json()
    expect(data.grounded_follow_up).toBeUndefined()
    expect(data.grounded_follow_up_2).toBeUndefined()
    expect(data.follow_up_question).toBe(EVAL.follow_up_question)
  })
})
