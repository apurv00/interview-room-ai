import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { mockCompletion, mockTrackUsage, mockGetJDContext, mockFindById } = vi.hoisted(() => ({
  mockCompletion: vi.fn(),
  mockTrackUsage: vi.fn(),
  mockGetJDContext: vi.fn(),
  mockFindById: vi.fn(),
}))

vi.mock('@shared/middleware/composeApiRoute', () => ({
  composeApiRoute: (opts: {
    schema?: { parse: (x: unknown) => unknown }
    handler: (
      req: NextRequest,
      ctx: { user: unknown; body: unknown; params: Record<string, string> },
    ) => Promise<Response>
  }) => {
    return async (req: NextRequest): Promise<Response> => {
      const raw = await req.json()
      const body = opts.schema ? opts.schema.parse(raw) : raw
      return opts.handler(req, {
        user: { id: 'test-user-1', role: 'candidate', plan: 'free', email: 't@example.com' },
        body,
        params: {},
      })
    }
  },
}))

vi.mock('@shared/services/modelRouter', () => ({
  completion: mockCompletion,
  parseClaudeJSON: (raw: string, schema: { parse: (x: unknown) => unknown }) => {
    const cleaned = raw.trim().replace(/^```json?\s*/i, '').replace(/\s*```$/, '')
    return schema.parse(JSON.parse(cleaned))
  },
}))

vi.mock('@shared/services/usageTracking', () => ({
  trackUsage: mockTrackUsage,
}))

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/db/models', () => ({
  InterviewSession: {
    findById: (...args: unknown[]) => mockFindById(...args),
  },
}))

vi.mock('@shared/logger', () => ({
  aiLogger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}))

vi.mock('@shared/services/promptSecurity', () => ({
  DATA_BOUNDARY_RULE: 'BOUNDARY_RULE',
  JSON_OUTPUT_RULE: 'JSON_OUTPUT_RULE',
}))

vi.mock('@interview/services/persona/documentContextCache', () => ({
  getOrLoadJDContext: mockGetJDContext,
}))

vi.mock('@interview/config/interviewConfig', () => ({
  getDomainLabel: (slug: string) => (slug === 'pm' ? 'Product Manager' : slug),
}))

import { POST } from '@/app/api/interview/clarify-case-context/route'

const baseConfig = {
  role: 'pm',
  interviewType: 'case-study',
  experience: '3-6',
  duration: 20,
  targetCompany: 'Nykaa',
  targetIndustry: 'marketplace',
}

function makeRequest(overrides: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost/api/interview/clarify-case-context', {
    method: 'POST',
    body: JSON.stringify({
      candidateQuestion: 'Can I assume this is a B2C mobile retention problem?',
      activeQuestion: 'Design a growth strategy for Nykaa Superstore.',
      config: baseConfig,
      sessionId: 'sess_123',
      questionIndex: 1,
      ...overrides,
    }),
  })
}

function mockSessionOwner(userId: string | null) {
  mockFindById.mockReturnValue({
    select: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(userId ? { userId: { toString: () => userId } } : null),
    }),
  })
}

beforeEach(() => {
  mockCompletion.mockReset()
  mockTrackUsage.mockReset()
  mockTrackUsage.mockResolvedValue(undefined)
  mockGetJDContext.mockReset()
  mockGetJDContext.mockResolvedValue(null)
  mockFindById.mockReset()
  mockSessionOwner('test-user-1')
})

describe('clarify-case-context route', () => {
  it('returns bounded assumptions without changing the answer shape', async () => {
    mockCompletion.mockResolvedValue({
      text: JSON.stringify({
        answer: 'For this mock case, assume B2C mobile shoppers, a 90-day retention goal, and a medium-scale marketplace with seller onboarding constraints. Take a moment to structure your approach, then walk me through it.',
      }),
      inputTokens: 20,
      outputTokens: 18,
      model: 'gpt-5.6-luna',
      provider: 'openai',
      usedFallback: false,
    })

    const res = await POST(makeRequest())
    const data = await res.json()

    expect(data.answer).toContain('For this mock case')
    expect(mockCompletion).toHaveBeenCalledWith(expect.objectContaining({
      taskSlot: 'interview.clarify-case-context',
    }))
    expect(mockTrackUsage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'api_call_question',
      sessionId: 'sess_123',
      success: true,
    }))
  })

  it('includes active question, candidate question, and JD context in data tags', async () => {
    mockGetJDContext.mockResolvedValue('Role context: marketplace growth, retention, experimentation.')
    mockCompletion.mockResolvedValue({
      text: JSON.stringify({
        answer: 'For this mock case, assume a retention-focused marketplace scenario. Take a moment to structure your approach, then walk me through it.',
      }),
      inputTokens: 20,
      outputTokens: 10,
      model: 'gpt-5.6-luna',
      provider: 'openai',
      usedFallback: false,
    })

    await POST(makeRequest({
      config: {
        ...baseConfig,
        jobDescription: 'Marketplace growth PM role.',
      },
    }))

    const call = mockCompletion.mock.calls[0][0]
    expect(call.system).toContain('BOUNDARY_RULE')
    expect(call.messages[0].content).toContain('<active_question>')
    expect(call.messages[0].content).toContain('Design a growth strategy')
    expect(call.messages[0].content).toContain('<candidate_question>')
    expect(call.messages[0].content).toContain('B2C mobile retention')
    expect(call.messages[0].content).toContain('marketplace growth')
    expect(mockGetJDContext).toHaveBeenCalledWith('sess_123', 'Marketplace growth PM role.')
  })

  it('falls back to provided JD text when sessionId is not owned by the caller', async () => {
    mockSessionOwner('different-user')
    mockGetJDContext.mockResolvedValue('Victim cached context: confidential requirements.')
    mockCompletion.mockResolvedValue({
      text: JSON.stringify({
        answer: 'For this mock case, assume a retention-focused marketplace scenario. Take a moment to structure your approach, then walk me through it.',
      }),
      inputTokens: 20,
      outputTokens: 10,
      model: 'gpt-5.6-luna',
      provider: 'openai',
      usedFallback: false,
    })

    await POST(makeRequest({
      config: {
        ...baseConfig,
        jobDescription: 'Caller supplied marketplace growth PM role.',
      },
    }))

    const call = mockCompletion.mock.calls[0][0]
    expect(mockGetJDContext).not.toHaveBeenCalled()
    expect(call.messages[0].content).toContain('Job description excerpt:')
    expect(call.messages[0].content).toContain('Caller supplied marketplace growth PM role.')
    expect(call.messages[0].content).not.toContain('Victim cached context')
    expect(mockTrackUsage.mock.calls[0][0].sessionId).toBeUndefined()
  })

  it('omits unowned sessionId from failed usage tracking', async () => {
    mockSessionOwner('different-user')
    mockCompletion.mockRejectedValue(new Error('model unavailable'))

    const res = await POST(makeRequest())
    const data = await res.json()

    expect(data.answer).toContain('Take a moment to structure your approach')
    expect(mockTrackUsage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'api_call_question',
      success: false,
    }))
    expect(mockTrackUsage.mock.calls[0][0].sessionId).toBeUndefined()
  })

  it('returns fallback when called outside case-study/system-design', async () => {
    const res = await POST(makeRequest({
      config: { ...baseConfig, interviewType: 'behavioral' },
    }))
    const data = await res.json()

    expect(res.status).toBe(400)
    expect(data.answer).toContain('For this mock case')
    expect(mockCompletion).not.toHaveBeenCalled()
  })

  it('returns fallback on parse failure', async () => {
    mockCompletion.mockResolvedValue({
      text: 'not json',
      inputTokens: 20,
      outputTokens: 10,
      model: 'gpt-5.6-luna',
      provider: 'openai',
      usedFallback: false,
    })

    const res = await POST(makeRequest())
    const data = await res.json()

    expect(data.answer).toContain('Take a moment to structure your approach')
  })
})
