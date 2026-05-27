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

const THREE_EVALS = [
  { questionIndex: 0 },
  { questionIndex: 1 },
  { questionIndex: 2 },
]

/** Minimum session payload that passes the validation reads. */
function fullSession(overrides: Record<string, unknown> = {}) {
  return {
    config: { role: 'pm', experience: '3-6' /* no interviewType — exercises the default */ },
    feedback: { overall_score: 70 },
    evaluations: THREE_EVALS,
    answeredCount: 3,
    pathwayGenerationStatus: 'failed',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockInngestSend.mockResolvedValue({ ids: ['evt-1'] })
})

// ─── Codex P2 (effectively P0) — event payload slim-down ───────────────────
// Previous version of these tests asserted that the retry route SENT
// interviewType in the event payload. The payload slim-down (Codex P2
// #10 on PR #379) moved that concern to the Inngest job — the job
// reads config from Mongo and applies the 'screening' default there.
// See pathwayJob.test.ts for the interviewType-default coverage.
//
// The retry route now sends ONLY identifiers; this block pins that
// contract so a future regression can't sneak heavy data back into
// the event.

describe('POST /api/learn/pathway/retry — slim event payload (Codex P2 #10)', () => {
  it('emits only {sessionId, userId} (no inline feedback / evaluations / config)', async () => {
    mockFindOne.mockResolvedValue(fullSession())
    mockFindOneAndUpdate.mockResolvedValue(fullSession())
    await POST(makeReq())
    expect(mockInngestSend).toHaveBeenCalledTimes(1)
    const event = mockInngestSend.mock.calls[0][0] as { name: string; data: Record<string, unknown> }
    expect(event.name).toBe('pathway/regenerate')
    // Identifiers only — must be present.
    expect(event.data.sessionId).toBe(SESSION_ID)
    expect(event.data.userId).toBeTypeOf('string')
    // Heavy data must NOT be in the payload — the job re-fetches it from Mongo.
    expect(event.data).not.toHaveProperty('feedback')
    expect(event.data).not.toHaveProperty('typedEvaluations')
    expect(event.data).not.toHaveProperty('evaluations')
    expect(event.data).not.toHaveProperty('config')
    expect(event.data).not.toHaveProperty('domain')
    expect(event.data).not.toHaveProperty('interviewType')
    expect(event.data).not.toHaveProperty('experience')
  })

  it('keeps event size bounded regardless of session size (no large nested objects)', async () => {
    // Stuff the session with a long fake feedback + evaluations to confirm
    // none of it ends up serialized into the event. Pre-fix this would
    // have produced a 100k+ byte event that could exceed Inngest's 512KB
    // limit on the largest interviews.
    const bigFeedback: Record<string, string> = {}
    for (let i = 0; i < 500; i++) bigFeedback[`k${i}`] = 'x'.repeat(200)
    const bigEvaluations = Array.from({ length: 100 }, (_, i) => ({
      questionIndex: i,
      question: 'q'.repeat(2000),
      answer: 'a'.repeat(5000),
    }))
    mockFindOne.mockResolvedValue(fullSession({
      feedback: { ...bigFeedback, overall_score: 70 },
      evaluations: bigEvaluations,
      answeredCount: 100,
    }))
    mockFindOneAndUpdate.mockResolvedValue(fullSession())
    await POST(makeReq())
    const event = mockInngestSend.mock.calls[0][0]
    const serialized = JSON.stringify(event)
    // ~200 bytes is comfortable for {name, data:{sessionId, userId}}.
    expect(serialized.length).toBeLessThan(500)
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
        $or: expect.arrayContaining([
          { pathwayGenerationStatus: 'failed' },
          { pathwayGenerationStatus: { $exists: false } },
          { pathwayGenerationStatus: null },
          expect.objectContaining({ pathwayGenerationStatus: 'pending' }),
          expect.objectContaining({ pathwayGenerationStatus: 'running' }),
        ]),
      }),
    )
    expect(update.$set).toMatchObject({
      pathwayGenerationStatus: 'pending',
      pathwayGenerationUseSynthesizedFeedback: false,
    })
    expect(update.$set.pathwayGenerationStartedAt).toBeInstanceOf(Date)
    expect(update.$inc).toEqual({ pathwayGenerationAttempts: 1 })
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

  it('allows retry for stale pending sessions that were never picked up', async () => {
    mockFindOne.mockResolvedValue(fullSession({
      pathwayGenerationStatus: 'pending',
      completedAt: new Date(Date.now() - 20 * 60 * 1000),
    }))
    mockFindOneAndUpdate.mockResolvedValue(fullSession())

    const res = await POST(makeReq())

    expect(res.status).toBe(200)
    expect(mockInngestSend).toHaveBeenCalledTimes(1)
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
    expect(body.error).toMatch(/failed, stale in-flight, or never-attempted/i)
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
    mockFindOne.mockResolvedValue({
      feedback: { overall_score: 70 },
      evaluations: THREE_EVALS,
      answeredCount: 3,
    })
    const res = await POST(makeReq())
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/config is missing/i)
  })

  it('allows retry when feedback is missing but evaluations exist (outer-catch path)', async () => {
    mockFindOne.mockResolvedValue(fullSession({ feedback: undefined }))
    mockFindOneAndUpdate.mockResolvedValue(fullSession({ feedback: undefined }))
    const res = await POST(makeReq())
    expect(res.status).toBe(200)
    expect(mockInngestSend).toHaveBeenCalledTimes(1)
    const [, update] = mockFindOneAndUpdate.mock.calls[0]
    expect(update.$set).toMatchObject({
      pathwayGenerationStatus: 'pending',
      pathwayGenerationUseSynthesizedFeedback: true,
    })
    expect(update.$inc).toEqual({ pathwayGenerationAttempts: 1 })
  })

  it('409 when evaluations are missing or empty (even if feedback exists)', async () => {
    mockFindOne.mockResolvedValue(fullSession({ evaluations: [] }))
    const res = await POST(makeReq())
    expect(res.status).toBe(409)
    expect((await res.json() as { error: string }).error).toMatch(/no evaluations/i)
  })

  it('409 when fewer than three answers were recorded', async () => {
    mockFindOne.mockResolvedValue(
      fullSession({
        answeredCount: 2,
        evaluations: [{ questionIndex: 0 }, { questionIndex: 1 }],
      }),
    )
    const res = await POST(makeReq())
    expect(res.status).toBe(409)
    expect((await res.json() as { error: string }).error).toMatch(/at least 3 answered/i)
    expect(mockInngestSend).not.toHaveBeenCalled()
  })

  it('409 when scored feedback is missing (no degraded synthesis path without evals)', async () => {
    mockFindOne.mockResolvedValue(
      fullSession({
        feedback: null,
        evaluations: [],
        answeredCount: 0,
      }),
    )
    const res = await POST(makeReq())
    expect(res.status).toBe(409)
    expect(mockInngestSend).not.toHaveBeenCalled()
  })

  it('allows retry for client-stuck pending (≥2 min, zero attempts)', async () => {
    mockFindOne.mockResolvedValue(
      fullSession({
        pathwayGenerationStatus: 'pending',
        completedAt: new Date(Date.now() - 3 * 60 * 1000),
        pathwayGenerationAttempts: 0,
      }),
    )
    mockFindOneAndUpdate.mockResolvedValue(fullSession())
    const res = await POST(makeReq())
    expect(res.status).toBe(200)
    expect(mockInngestSend).toHaveBeenCalledTimes(1)
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
