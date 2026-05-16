import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@shared/logger', () => ({
  aiLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

// Inngest client is instantiated at module-load. Stub it out.
vi.mock('@shared/services/inngest', () => ({
  inngest: {
    createFunction: (_config: unknown, handler: unknown) => ({
      id: 'pathway-regenerate',
      handler,
    }),
  },
}))

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

const mockFindByIdAndUpdate = vi.fn()
vi.mock('@shared/db/models', () => ({
  InterviewSession: {
    findByIdAndUpdate: (...args: unknown[]) => mockFindByIdAndUpdate(...args),
  },
}))

const mockEvaluateSession = vi.fn()
vi.mock('@interview', () => ({
  evaluateSession: (...args: unknown[]) => mockEvaluateSession(...args),
}))

const mockGeneratePathwayPlan = vi.fn()
vi.mock('@learn/services/pathwayPlanner', () => ({
  generatePathwayPlan: (...args: unknown[]) => mockGeneratePathwayPlan(...args),
}))

import { runPathwayJobHandler, PATHWAY_STATUS_FIELDS } from '@learn/jobs/pathwayJob'

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeEvent() {
  return {
    data: {
      sessionId: 'sess-1',
      userId: 'user-1',
      domain: 'pm',
      interviewType: 'behavioral',
      experience: '3-6',
      feedback: { overall_score: 70 } as never,
      typedEvaluations: [],
    },
  }
}

/** Step runner that just invokes the function and records the name. */
function makeStep() {
  const calls: string[] = []
  return {
    calls,
    run: async <T>(name: string, fn: () => Promise<T> | T) => {
      calls.push(name)
      return await fn()
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockEvaluateSession.mockResolvedValue({ overallScore: 70 })
  mockGeneratePathwayPlan.mockResolvedValue({ _id: 'plan-1' })
  mockFindByIdAndUpdate.mockResolvedValue({})
})

describe('runPathwayJobHandler', () => {
  it('runs the 4 steps in order: mark-running → evaluate-session → generate-plan → mark-completed', async () => {
    const step = makeStep()
    await runPathwayJobHandler(makeEvent(), step)
    expect(step.calls).toEqual([
      'mark-running',
      'evaluate-session',
      'generate-plan',
      'mark-completed',
    ])
  })

  it('marks the session running + increments attempt counter on entry', async () => {
    const step = makeStep()
    await runPathwayJobHandler(makeEvent(), step)
    expect(mockFindByIdAndUpdate.mock.calls[0]).toEqual([
      'sess-1',
      expect.objectContaining({
        $set: expect.objectContaining({
          pathwayGenerationStatus: 'running',
        }),
        $inc: { pathwayGenerationAttempts: 1 },
      }),
    ])
  })

  it('passes the event payload through to evaluateSession and generatePathwayPlan', async () => {
    const step = makeStep()
    await runPathwayJobHandler(makeEvent(), step)
    expect(mockEvaluateSession).toHaveBeenCalledWith({
      domain: 'pm',
      interviewType: 'behavioral',
      seniorityBand: '3-6',
      evaluations: [],
    })
    expect(mockGeneratePathwayPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        sessionId: 'sess-1',
        sessionEvaluation: { overallScore: 70 },
      }),
    )
  })

  it('returns status="completed" + the plan id when generation succeeds', async () => {
    const step = makeStep()
    const result = await runPathwayJobHandler(makeEvent(), step)
    expect(result).toEqual({
      sessionId: 'sess-1',
      status: 'completed',
      pathwayId: 'plan-1',
    })
  })

  it('marks the session status="succeeded" on success', async () => {
    const step = makeStep()
    await runPathwayJobHandler(makeEvent(), step)
    const finalUpdate = mockFindByIdAndUpdate.mock.calls[1]
    expect(finalUpdate[1].$set.pathwayGenerationStatus).toBe('succeeded')
  })

  it('marks status="skipped" when generatePathwayPlan returns null (flag off, silent skip)', async () => {
    mockGeneratePathwayPlan.mockResolvedValue(null)
    const step = makeStep()
    const result = await runPathwayJobHandler(makeEvent(), step)
    const finalUpdate = mockFindByIdAndUpdate.mock.calls[1]
    expect(finalUpdate[1].$set.pathwayGenerationStatus).toBe('skipped')
    expect(result.status).toBe('skipped')
    expect(result.pathwayId).toBeUndefined()
  })

  it('propagates errors from evaluateSession so Inngest can retry', async () => {
    mockEvaluateSession.mockRejectedValue(new Error('LLM timeout'))
    const step = makeStep()
    await expect(runPathwayJobHandler(makeEvent(), step)).rejects.toThrow('LLM timeout')
    // mark-running ran (step 1), evaluate-session threw (step 2),
    // generate-plan and mark-completed should NOT have been invoked.
    expect(step.calls).toEqual(['mark-running', 'evaluate-session'])
    expect(mockGeneratePathwayPlan).not.toHaveBeenCalled()
  })

  it('propagates errors from generatePathwayPlan so Inngest can retry', async () => {
    mockGeneratePathwayPlan.mockRejectedValue(new Error('Mongo connection lost'))
    const step = makeStep()
    await expect(runPathwayJobHandler(makeEvent(), step)).rejects.toThrow('Mongo connection lost')
    // mark-completed should NOT have run.
    expect(step.calls).toEqual(['mark-running', 'evaluate-session', 'generate-plan'])
  })
})

describe('PATHWAY_STATUS_FIELDS', () => {
  it('exposes the field names used by the job + reading layer', () => {
    expect(PATHWAY_STATUS_FIELDS.status).toBe('pathwayGenerationStatus')
    expect(PATHWAY_STATUS_FIELDS.error).toBe('pathwayGenerationError')
    expect(PATHWAY_STATUS_FIELDS.startedAt).toBe('pathwayGenerationStartedAt')
    expect(PATHWAY_STATUS_FIELDS.completedAt).toBe('pathwayGenerationCompletedAt')
    expect(PATHWAY_STATUS_FIELDS.attempts).toBe('pathwayGenerationAttempts')
  })
})
