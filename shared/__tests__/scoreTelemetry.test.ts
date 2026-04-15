import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mocks ───────────────────────────────────────────────────────────

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/featureFlags', () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(true),
}))

vi.mock('@shared/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
  aiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const mockCreate = vi.fn()
vi.mock('@shared/db/models', () => ({
  ScoreTelemetry: {
    create: (...args: unknown[]) => mockCreate(...args),
  },
}))

import { recordScoreDelta } from '@shared/services/scoreTelemetry'
import { isFeatureEnabled } from '@shared/featureFlags'
import { logger } from '@shared/logger'

const VALID_SESSION_ID = '507f1f77bcf86cd799439011'
const VALID_USER_ID = '507f1f77bcf86cd799439012'

const baseInput = {
  sessionId: VALID_SESSION_ID,
  userId: VALID_USER_ID,
  source: 'generate-feedback' as const,
  taskSlot: 'interview.generate-feedback',
  modelUsed: 'claude-opus-4-6',
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('scoreTelemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(isFeatureEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true)
    mockCreate.mockResolvedValue({ _id: 'mock-id' })
  })

  describe('recordScoreDelta', () => {
    it('returns null and skips DB when flag is disabled', async () => {
      ;(isFeatureEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false)

      const result = await recordScoreDelta({
        ...baseInput,
        claudeOverallScore: 80,
        deterministicOverallScore: 65,
      })

      expect(result).toBeNull()
      expect(mockCreate).not.toHaveBeenCalled()
    })

    it('persists a row with correctly computed deltaOverall', async () => {
      await recordScoreDelta({
        ...baseInput,
        claudeOverallScore: 80,
        deterministicOverallScore: 65,
        evaluationCount: 10,
      })

      expect(mockCreate).toHaveBeenCalledTimes(1)
      const arg = mockCreate.mock.calls[0][0] as Record<string, unknown>
      expect(arg.claudeOverallScore).toBe(80)
      expect(arg.deterministicOverallScore).toBe(65)
      expect(arg.deltaOverall).toBe(15) // 80 - 65
      expect(arg.source).toBe('generate-feedback')
      expect(arg.recordReason).toBe('ok')
      expect(arg.evaluationCount).toBe(10)
      expect(arg.expiresAt).toBeInstanceOf(Date)
    })

    it('computes negative delta correctly when formula is higher', async () => {
      await recordScoreDelta({
        ...baseInput,
        claudeOverallScore: 50,
        deterministicOverallScore: 72,
      })

      const arg = mockCreate.mock.calls[0][0] as Record<string, unknown>
      expect(arg.deltaOverall).toBe(-22)
    })

    it('omits deltaOverall when Claude value is missing', async () => {
      await recordScoreDelta({
        ...baseInput,
        claudeOverallScore: undefined,
        deterministicOverallScore: 60,
        recordReason: 'claude-missing-overall',
      })

      const arg = mockCreate.mock.calls[0][0] as Record<string, unknown>
      expect(arg.deltaOverall).toBeUndefined()
      expect(arg.claudeOverallScore).toBeUndefined()
      expect(arg.deterministicOverallScore).toBe(60)
      expect(arg.recordReason).toBe('claude-missing-overall')
    })

    it('defaults recordReason to "ok" when not supplied', async () => {
      await recordScoreDelta({
        ...baseInput,
        claudeOverallScore: 70,
        deterministicOverallScore: 70,
      })

      const arg = mockCreate.mock.calls[0][0] as Record<string, unknown>
      expect(arg.recordReason).toBe('ok')
      expect(arg.deltaOverall).toBe(0)
    })

    it('accepts "parse-failed" reason with no scores', async () => {
      await recordScoreDelta({
        ...baseInput,
        recordReason: 'parse-failed',
      })

      const arg = mockCreate.mock.calls[0][0] as Record<string, unknown>
      expect(arg.recordReason).toBe('parse-failed')
      expect(arg.claudeOverallScore).toBeUndefined()
      expect(arg.deterministicOverallScore).toBeUndefined()
      expect(arg.deltaOverall).toBeUndefined()
    })

    it('accepts "outer-catch" reason', async () => {
      await recordScoreDelta({
        ...baseInput,
        deterministicOverallScore: 45,
        recordReason: 'outer-catch',
      })

      const arg = mockCreate.mock.calls[0][0] as Record<string, unknown>
      expect(arg.recordReason).toBe('outer-catch')
    })

    it('stores per-dimension snapshots when provided', async () => {
      await recordScoreDelta({
        ...baseInput,
        claudeOverallScore: 80,
        deterministicOverallScore: 65,
        claudeDimensions: { answer_quality: 82, communication: 75, engagement_signals: 83 },
        deterministicDimensions: { answer_quality: 62, communication: 70, engagement_signals: 65 },
      })

      const arg = mockCreate.mock.calls[0][0] as Record<string, unknown>
      expect(arg.claudeDimensions).toEqual({ answer_quality: 82, communication: 75, engagement_signals: 83 })
      expect(arg.deterministicDimensions).toEqual({ answer_quality: 62, communication: 70, engagement_signals: 65 })
    })

    it('records truncated flag and token counts', async () => {
      await recordScoreDelta({
        ...baseInput,
        claudeOverallScore: 72,
        deterministicOverallScore: 68,
        truncated: true,
        inputTokens: 3200,
        outputTokens: 6000,
        promptLength: 12500,
      })

      const arg = mockCreate.mock.calls[0][0] as Record<string, unknown>
      expect(arg.truncated).toBe(true)
      expect(arg.inputTokens).toBe(3200)
      expect(arg.outputTokens).toBe(6000)
      expect(arg.promptLength).toBe(12500)
    })

    it('coerces non-finite numbers to undefined', async () => {
      await recordScoreDelta({
        ...baseInput,
        claudeOverallScore: Number.NaN,
        deterministicOverallScore: Number.POSITIVE_INFINITY,
      })

      const arg = mockCreate.mock.calls[0][0] as Record<string, unknown>
      expect(arg.claudeOverallScore).toBeUndefined()
      expect(arg.deterministicOverallScore).toBeUndefined()
      expect(arg.deltaOverall).toBeUndefined()
    })

    it('swallows DB errors without throwing', async () => {
      mockCreate.mockRejectedValueOnce(new Error('mongo down'))

      const result = await recordScoreDelta({
        ...baseInput,
        claudeOverallScore: 75,
        deterministicOverallScore: 70,
      })

      expect(result).toBeNull()
      expect(logger.warn).toHaveBeenCalled()
    })

    it('emits a structured info log containing the delta', async () => {
      await recordScoreDelta({
        ...baseInput,
        claudeOverallScore: 78,
        deterministicOverallScore: 64,
        evaluationCount: 8,
      })

      expect(logger.info).toHaveBeenCalled()
      const logArgs = (logger.info as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(logArgs.scoreTelemetry.deltaOverall).toBe(14)
      expect(logArgs.scoreTelemetry.source).toBe('generate-feedback')
      expect(logArgs.scoreTelemetry.evaluationCount).toBe(8)
    })

    it('sets expiresAt ~30 days out', async () => {
      const before = Date.now()
      await recordScoreDelta({
        ...baseInput,
        claudeOverallScore: 80,
        deterministicOverallScore: 65,
      })
      const after = Date.now()

      const arg = mockCreate.mock.calls[0][0] as Record<string, unknown>
      const expiresAt = (arg.expiresAt as Date).getTime()
      const thirtyDays = 30 * 24 * 60 * 60 * 1000
      expect(expiresAt).toBeGreaterThanOrEqual(before + thirtyDays - 100)
      expect(expiresAt).toBeLessThanOrEqual(after + thirtyDays + 100)
    })
  })
})
