import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ─── Mocks ──────────────────────────────────────────────────────────────────

const { mockFindOne, mockFindOneAndUpdate, mockInngestSend } = vi.hoisted(() => ({
  mockFindOne: vi.fn(),
  mockFindOneAndUpdate: vi.fn(),
  mockInngestSend: vi.fn(),
}))

vi.mock('@shared/middleware/composeApiRoute', () => ({
  composeApiRoute: (opts: {
    schema?: { parse: (x: unknown) => unknown }
    handler: (
      req: NextRequest,
      ctx: { user: unknown; body: unknown; params: Record<string, string> },
    ) => Promise<Response>
  }) => async (req: NextRequest) => {
    const raw = await req.json()
    const body = opts.schema ? opts.schema.parse(raw) : raw
    return opts.handler(req, {
      user: { id: '507f1f77bcf86cd799439099', role: 'candidate', plan: 'free', email: 't@example.com' },
      body,
      params: {},
    })
  },
}))

vi.mock('@shared/logger', () => ({
  aiLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/db/models', () => ({
  InterviewSession: {
    findOne: (...args: unknown[]) => ({
      select: () => ({
        lean: () => mockFindOne(...args),
      }),
    }),
    findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdate(...args),
    findByIdAndUpdate: vi.fn().mockResolvedValue({}),
  },
}))

vi.mock('@shared/services/inngest', () => ({
  inngest: {
    send: (...args: unknown[]) => mockInngestSend(...args),
  },
}))

import { POST } from '@/app/api/learn/pathway/retry/route'

// ─── Helpers ────────────────────────────────────────────────────────────────

const SESSION_ID = '507f1f77bcf86cd799439011'

function makeReq(sessionId: string = SESSION_ID) {
  return new NextRequest('http://localhost:3000/api/learn/pathway/retry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  })
}

/** Minimum session payload that passes the validation reads. */
function fullSession(overrides: Record<string, unknown> = {}) {
  return {
    config: { role: 'pm', experience: '3-6' /* no interviewType — exercises the default */ },
    feedback: { overall_score: 70 },
    evaluations: [{ questionIndex: 0 }],
    pathwayGenerationStatus: 'failed',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockInngestSend.mockResolvedValue({ ids: ['evt-1'] })
})

// ─── Codex P2 #8 — interviewType default must match the primary flow ──────

describe('POST /api/learn/pathway/retry — interviewType default (Codex P2 #8)', () => {
  it("defaults to 'screening' when session.config.interviewType is undefined (matches generate-feedback:243)", async () => {
    mockFindOne.mockResolvedValue(fullSession())
    mockFindOneAndUpdate.mockResolvedValue(fullSession())
    await POST(makeReq())
    expect(mockInngestSend).toHaveBeenCalledTimes(1)
    const eventArg = mockInngestSend.mock.calls[0][0] as { data: { interviewType: string } }
    expect(eventArg.data.interviewType).toBe('screening')
  })

  it('passes through an explicit interviewType from the session config', async () => {
    mockFindOne.mockResolvedValue(fullSession({
      config: { role: 'pm', experience: '3-6', interviewType: 'behavioral' },
    }))
    mockFindOneAndUpdate.mockResolvedValue(fullSession())
    await POST(makeReq())
    const eventArg = mockInngestSend.mock.calls[0][0] as { data: { interviewType: string } }
    expect(eventArg.data.interviewType).toBe('behavioral')
  })

  it("treats empty-string interviewType as missing and falls back to 'screening'", async () => {
    // Matches generate-feedback's `||` semantics: `'' || 'screening'` → 'screening'.
    mockFindOne.mockResolvedValue(fullSession({
      config: { role: 'pm', experience: '3-6', interviewType: '' },
    }))
    mockFindOneAndUpdate.mockResolvedValue(fullSession())
    await POST(makeReq())
    const eventArg = mockInngestSend.mock.calls[0][0] as { data: { interviewType: string } }
    expect(eventArg.data.interviewType).toBe('screening')
  })
})

// ─── Codex P2 #9 — atomic CAS prevents duplicate concurrent retries ───────

describe('POST /api/learn/pathway/retry — atomic claim (Codex P2 #9)', () => {
  it('uses findOneAndUpdate filtered on retryable statuses to claim the session', async () => {
    mockFindOne.mockResolvedValue(fullSession())
    mockFindOneAndUpdate.mockResolvedValue(fullSession())

    await POST(makeReq())

    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1)
    const [filter, update] = mockFindOneAndUpdate.mock.calls[0]
    expect(filter).toEqual(
      expect.objectContaining({
        $or: [
          { pathwayGenerationStatus: 'failed' },
          { pathwayGenerationStatus: { $exists: false } },
          { pathwayGenerationStatus: null },
        ],
      }),
    )
    expect(update.$set).toEqual({ pathwayGenerationStatus: 'pending' })
    expect(update.$unset).toEqual({ pathwayGenerationError: 1 })
  })

  it("returns 409 + 'already in flight' when CAS returns null and read showed pending/running", async () => {
    mockFindOne.mockResolvedValue(fullSession({ pathwayGenerationStatus: 'pending' }))
    mockFindOneAndUpdate.mockResolvedValue(null) // race lost
    const res = await POST(makeReq())
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/already in flight/i)
    expect(mockInngestSend).not.toHaveBeenCalled()
  })

  it('returns 409 + "another retry just claimed" when CAS lost the race (read still showed retryable)', async () => {
    mockFindOne.mockResolvedValue(fullSession({ pathwayGenerationStatus: 'failed' }))
    mockFindOneAndUpdate.mockResolvedValue(null) // claimed by concurrent caller between read and CAS
    const res = await POST(makeReq())
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/another retry just claimed/i)
    expect(mockInngestSend).not.toHaveBeenCalled()
  })

  it('returns 409 with non-retryable wording for succeeded/skipped', async () => {
    mockFindOne.mockResolvedValue(fullSession({ pathwayGenerationStatus: 'succeeded' }))
    mockFindOneAndUpdate.mockResolvedValue(null)
    const res = await POST(makeReq())
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/not retryable from status 'succeeded'/i)
    expect(body.error).toMatch(/failed or never-attempted/i)
    expect(mockInngestSend).not.toHaveBeenCalled()
  })

  it('does NOT call inngest.send when CAS fails to claim', async () => {
    mockFindOne.mockResolvedValue(fullSession())
    mockFindOneAndUpdate.mockResolvedValue(null)
    await POST(makeReq())
    expect(mockInngestSend).not.toHaveBeenCalled()
  })

  it('enqueues exactly one event when CAS succeeds', async () => {
    mockFindOne.mockResolvedValue(fullSession())
    mockFindOneAndUpdate.mockResolvedValue(fullSession())
    await POST(makeReq())
    expect(mockInngestSend).toHaveBeenCalledTimes(1)
    expect(mockInngestSend.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        name: 'pathway/regenerate',
        data: expect.objectContaining({ sessionId: SESSION_ID }),
      }),
    )
  })
})

// ─── Validation-path regressions ─────────────────────────────────────────────

describe('POST /api/learn/pathway/retry — validation', () => {
  it('400 on invalid sessionId', async () => {
    const res = await POST(makeReq('not-a-real-id'))
    expect(res.status).toBe(400)
  })

  it('404 when session not found', async () => {
    mockFindOne.mockResolvedValue(null)
    const res = await POST(makeReq())
    expect(res.status).toBe(404)
  })

  it('409 when session.config is missing entirely', async () => {
    mockFindOne.mockResolvedValue({ feedback: { x: 1 }, evaluations: [{}] })
    const res = await POST(makeReq())
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/config is missing/i)
  })

  it('409 when feedback is missing', async () => {
    mockFindOne.mockResolvedValue(fullSession({ feedback: undefined }))
    const res = await POST(makeReq())
    expect(res.status).toBe(409)
    expect((await res.json() as { error: string }).error).toMatch(/no feedback yet/i)
  })

  it('409 when evaluations are missing or empty', async () => {
    mockFindOne.mockResolvedValue(fullSession({ evaluations: [] }))
    const res = await POST(makeReq())
    expect(res.status).toBe(409)
    expect((await res.json() as { error: string }).error).toMatch(/no evaluations/i)
  })
})

// ─── Codex P1 #1 — enqueue-failure rollback ────────────────────────────────

describe('POST /api/learn/pathway/retry — enqueue failure rollback (Codex P1 #1)', () => {
  it('rolls status back to "failed" with the enqueue error when inngest.send rejects', async () => {
    mockFindOne.mockResolvedValue(fullSession())
    mockFindOneAndUpdate.mockResolvedValue(fullSession())
    mockInngestSend.mockRejectedValue(new Error('INNGEST_EVENT_KEY not set'))

    // Capture the rollback write.
    const findByIdAndUpdate = (await import('@shared/db/models')).InterviewSession.findByIdAndUpdate as ReturnType<typeof vi.fn>
    findByIdAndUpdate.mockResolvedValue({})

    const res = await POST(makeReq())
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/INNGEST_EVENT_KEY/i)

    // Rollback write must set status='failed' + capture the error message.
    const rollbackCall = findByIdAndUpdate.mock.calls.find(
      ([, update]: [unknown, { $set?: { pathwayGenerationStatus?: string } }]) =>
        update?.$set?.pathwayGenerationStatus === 'failed',
    )
    expect(rollbackCall).toBeDefined()
    expect(rollbackCall![1].$set.pathwayGenerationError).toMatch(/INNGEST_EVENT_KEY/i)
  })
})
