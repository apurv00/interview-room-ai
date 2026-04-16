import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@shared/logger', () => ({
  aiLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

// The Inngest client is instantiated at module-load time when analysisJob.ts
// is imported. Stub it out so the test doesn't need real event keys.
vi.mock('@shared/services/inngest', () => ({
  inngest: {
    createFunction: (_config: unknown, handler: unknown) => ({
      id: 'multimodal-analysis',
      handler,
    }),
  },
}))

// Mock all 5 pipeline steps + shouldRunDualPipeline + enforceAnalysisCap.
// The handler's only job is orchestration — we verify the order, arguments,
// and dual-pipeline branching.
const mockFetchSession = vi.fn()
const mockTranscribe = vi.fn()
const mockProcessSignals = vi.fn()
const mockRunFusion = vi.fn()
const mockPersistResults = vi.fn()
const mockMarkFailed = vi.fn()
const mockShouldRunDual = vi.fn()
const mockEnforceAnalysisCap = vi.fn()

vi.mock('../services/analysis/multimodalPipeline', () => ({
  stepFetchSession: (...args: unknown[]) => mockFetchSession(...args),
  stepTranscribeAndDownload: (...args: unknown[]) => mockTranscribe(...args),
  stepProcessSignals: (...args: unknown[]) => mockProcessSignals(...args),
  stepRunFusion: (...args: unknown[]) => mockRunFusion(...args),
  stepPersistResults: (...args: unknown[]) => mockPersistResults(...args),
  stepMarkFailed: (...args: unknown[]) => mockMarkFailed(...args),
  shouldRunDualPipeline: (...args: unknown[]) => mockShouldRunDual(...args),
}))

vi.mock('@shared/services/analysisCleanup', () => ({
  enforceAnalysisCap: (...args: unknown[]) => mockEnforceAnalysisCap(...args),
}))

import { runAnalysisJobHandler, analysisJob } from '@interview/jobs/analysisJob'

// ─── Test fixtures ──────────────────────────────────────────────────────────

const fakeSession = {
  sessionId: 'sess-1',
  recordingR2Key: 'rec.webm',
  audioRecordingR2Key: 'audio.webm',
  facialLandmarksR2Key: 'facial.json',
  liveTranscriptWords: undefined,
  transcript: [{ speaker: 'candidate', text: 'hello', timestamp: 0 }],
  evaluations: [],
  config: { role: 'swe' },
  questionBoundaries: [0, 30, 60],
}

const fakeWhisper = {
  whisper: {
    segments: [{ id: 0, start: 0, end: 5, text: 'hello', words: [] }],
    durationSeconds: 120,
    costUsd: 0.003,
  },
  facialFrames: [],
}

const fakeSignals = {
  prosodySegments: [{ label: 'p1' }],
  facialSegments: [{ label: 'f1' }],
  facialTimeseries: [{ label: 'ft1' }],
}

const fakeFusion = (suffix: string) => ({
  timeline: [{ event: `timeline-${suffix}` }],
  fusionSummary: {
    summary: `summary-${suffix}`,
    overallBodyLanguageScore: 80,
    eyeContactScore: 75,
  },
  inputTokens: 1000,
  outputTokens: 500,
  promptLength: 3000,
})

// Build a mock `step` object that just executes the function directly and
// records the call order.
function buildMockStep() {
  const calls: Array<{ name: string }> = []
  const step = {
    run: async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
      calls.push({ name })
      return await fn()
    },
  }
  return { step, calls }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('analysisJob', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchSession.mockResolvedValue(fakeSession)
    mockTranscribe.mockResolvedValue(fakeWhisper)
    mockProcessSignals.mockReturnValue(fakeSignals)
    mockRunFusion.mockImplementation((_prosody, _facial, _evals, _transcript, _config, opts) =>
      Promise.resolve(fakeFusion(opts?.includeBlendshapes ? 'enhanced' : 'baseline'))
    )
    mockPersistResults.mockResolvedValue(undefined)
    mockEnforceAnalysisCap.mockResolvedValue({ deleted: 0 })
    mockShouldRunDual.mockResolvedValue(false)
  })

  describe('runAnalysisJobHandler', () => {
    it('runs all pipeline steps in order (no dual-pipeline)', async () => {
      const { step, calls } = buildMockStep()
      const result = await runAnalysisJobHandler(
        { data: { sessionId: 'sess-1', userId: 'user-1', startTime: 1_000 } },
        step
      )

      expect(result).toEqual({ sessionId: 'sess-1', status: 'completed' })
      expect(calls.map((c) => c.name)).toEqual([
        'fetch-session',
        'transcribe-and-download',
        'process-signals',
        'run-fusion-enhanced',
        'should-run-dual',
        'persist-results',
        'enforce-analysis-cap',
      ])
    })

    it('forwards sessionId to fetch-session', async () => {
      const { step } = buildMockStep()
      await runAnalysisJobHandler(
        { data: { sessionId: 'sess-xyz', userId: 'user-1', startTime: 1_000 } },
        step
      )
      expect(mockFetchSession).toHaveBeenCalledWith('sess-xyz')
    })

    it('forwards all r2 keys and live transcript to transcribe step', async () => {
      const { step } = buildMockStep()
      await runAnalysisJobHandler(
        { data: { sessionId: 'sess-1', userId: 'user-1', startTime: 1_000 } },
        step
      )
      expect(mockTranscribe).toHaveBeenCalledWith(
        'rec.webm',
        'facial.json',
        'audio.webm',
        undefined,
        [{ speaker: 'candidate', text: 'hello', timestamp: 0 }]
      )
    })

    it('runs enhanced fusion with includeBlendshapes: true', async () => {
      const { step } = buildMockStep()
      await runAnalysisJobHandler(
        { data: { sessionId: 'sess-1', userId: 'user-1', startTime: 1_000 } },
        step
      )
      const enhancedCall = mockRunFusion.mock.calls.find((c) => c[5]?.includeBlendshapes === true)
      expect(enhancedCall).toBeDefined()
    })

    it('skips baseline fusion when shouldRunDualPipeline returns false', async () => {
      mockShouldRunDual.mockResolvedValue(false)
      const { step, calls } = buildMockStep()
      await runAnalysisJobHandler(
        { data: { sessionId: 'sess-1', userId: 'user-1', startTime: 1_000 } },
        step
      )
      expect(calls.find((c) => c.name === 'run-fusion-baseline')).toBeUndefined()
      // Fusion called exactly once (enhanced only)
      expect(mockRunFusion).toHaveBeenCalledTimes(1)
    })

    it('runs baseline fusion when shouldRunDualPipeline returns true', async () => {
      mockShouldRunDual.mockResolvedValue(true)
      const { step, calls } = buildMockStep()
      await runAnalysisJobHandler(
        { data: { sessionId: 'sess-1', userId: 'user-1', startTime: 1_000 } },
        step
      )
      expect(calls.find((c) => c.name === 'run-fusion-baseline')).toBeDefined()
      // Fusion called twice: enhanced + baseline
      expect(mockRunFusion).toHaveBeenCalledTimes(2)
      const baselineCall = mockRunFusion.mock.calls.find((c) => c[5]?.includeBlendshapes === false)
      expect(baselineCall).toBeDefined()
    })

    it('persists results with summed token counts when dual-pipeline runs', async () => {
      mockShouldRunDual.mockResolvedValue(true)
      const { step } = buildMockStep()
      await runAnalysisJobHandler(
        { data: { sessionId: 'sess-1', userId: 'user-1', startTime: 1_000 } },
        step
      )
      const persistArgs = mockPersistResults.mock.calls[0][2]
      // Enhanced (1000) + baseline (1000) = 2000 input tokens
      expect(persistArgs.fusionInputTokens).toBe(2000)
      expect(persistArgs.fusionOutputTokens).toBe(1000)
      expect(persistArgs.baselineTimeline).toBeDefined()
      expect(persistArgs.baselineFusionSummary).toBeDefined()
    })

    it('persists results without baseline fields when dual-pipeline does not run', async () => {
      mockShouldRunDual.mockResolvedValue(false)
      const { step } = buildMockStep()
      await runAnalysisJobHandler(
        { data: { sessionId: 'sess-1', userId: 'user-1', startTime: 1_000 } },
        step
      )
      const persistArgs = mockPersistResults.mock.calls[0][2]
      expect(persistArgs.fusionInputTokens).toBe(1000)
      expect(persistArgs.baselineTimeline).toBeUndefined()
      expect(persistArgs.baselineFusionSummary).toBeUndefined()
    })

    it('propagates the startTime from the event to stepPersistResults', async () => {
      const { step } = buildMockStep()
      await runAnalysisJobHandler(
        { data: { sessionId: 'sess-1', userId: 'user-1', startTime: 999_888 } },
        step
      )
      const persistArgs = mockPersistResults.mock.calls[0][2]
      expect(persistArgs.startTime).toBe(999_888)
    })

    it('calls enforceAnalysisCap with the userId after persist-results', async () => {
      const { step } = buildMockStep()
      await runAnalysisJobHandler(
        { data: { sessionId: 'sess-1', userId: 'user-42', startTime: 1_000 } },
        step
      )
      expect(mockEnforceAnalysisCap).toHaveBeenCalledTimes(1)
      expect(mockEnforceAnalysisCap).toHaveBeenCalledWith('user-42')
    })

    it('propagates errors from any step to the caller (so Inngest retries)', async () => {
      mockRunFusion.mockRejectedValueOnce(new Error('Claude timed out'))
      const { step } = buildMockStep()
      await expect(
        runAnalysisJobHandler(
          { data: { sessionId: 'sess-1', userId: 'user-1', startTime: 1_000 } },
          step
        )
      ).rejects.toThrow('Claude timed out')
      // stepMarkFailed is NOT called from the handler — that's onFailure's job
      expect(mockMarkFailed).not.toHaveBeenCalled()
    })
  })

  describe('analysisJob wrapper (Inngest registration)', () => {
    it('is exported with the expected id', () => {
      expect(analysisJob).toBeDefined()
      expect((analysisJob as unknown as { id: string }).id).toBe('multimodal-analysis')
    })
  })
})
