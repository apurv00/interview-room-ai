import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const mockFindOne = vi.fn()
const mockFindOneAndUpdate = vi.fn()
const mockUpdateOne = vi.fn()

vi.mock('@shared/db/models/GeneratedLesson', () => ({
  GeneratedLesson: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdate(...args),
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
  },
}))

const mockCompletion = vi.fn()
vi.mock('@shared/services/modelRouter', () => ({
  completion: (...args: unknown[]) => mockCompletion(...args),
}))

vi.mock('@shared/services/promptSecurity', () => ({
  JSON_OUTPUT_RULE: 'Respond with ONLY valid JSON.',
}))

import {
  buildLessonCacheKey,
  getOrGenerateLesson,
  flagLesson,
} from '../services/lessonGenerator'

describe('lessonGenerator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('buildLessonCacheKey', () => {
    it('produces deterministic keys', () => {
      const k1 = buildLessonCacheKey('specificity', 'pm', 'behavioral')
      const k2 = buildLessonCacheKey('specificity', 'pm', 'behavioral')
      expect(k1).toBe(k2)
      expect(k1).toHaveLength(24)
    })

    it('is case-insensitive', () => {
      expect(buildLessonCacheKey('Specificity', 'PM', 'Behavioral')).toBe(
        buildLessonCacheKey('specificity', 'pm', 'behavioral'),
      )
    })

    it('produces different keys for different inputs', () => {
      expect(buildLessonCacheKey('specificity', 'pm', 'behavioral'))
        .not.toBe(buildLessonCacheKey('ownership', 'pm', 'behavioral'))
      expect(buildLessonCacheKey('specificity', 'pm', 'behavioral'))
        .not.toBe(buildLessonCacheKey('specificity', 'backend', 'behavioral'))
    })
  })

  describe('getOrGenerateLesson', () => {
    const validLessonJson = JSON.stringify({
      title: 'Being Specific in Answers',
      conceptSummary: 'Specificity means using concrete details.',
      conceptDeepDive: 'Include names, numbers, and timeframes.',
      example: {
        question: 'Tell me about a time you led a project.',
        goodAnswer: 'At Acme Corp in Q3 2024, I led a team of 5...',
        annotations: ['Uses specific company + timeframe', 'Names team size'],
      },
      keyTakeaways: ['Use numbers', 'Name specific tools', 'Give timeframes'],
    })

    it('returns cached lesson when found and not flagged', async () => {
      const cached = { cacheKey: 'abc', reviewStatus: 'approved', title: 'Cached' }
      mockFindOne.mockResolvedValue(cached)

      const result = await getOrGenerateLesson({
        competency: 'specificity', domain: 'pm', depth: 'behavioral',
      })

      expect(result).toBe(cached)
      expect(mockCompletion).not.toHaveBeenCalled()
    })

    it('generates fresh lesson when none cached', async () => {
      mockFindOne.mockResolvedValue(null)
      mockCompletion.mockResolvedValue({ text: validLessonJson, inputTokens: 50, outputTokens: 200 })
      mockFindOneAndUpdate.mockImplementation((_q, update) => update)

      const result = await getOrGenerateLesson({
        competency: 'specificity', domain: 'pm', depth: 'behavioral',
      })

      expect(mockCompletion).toHaveBeenCalledOnce()
      expect(mockFindOneAndUpdate).toHaveBeenCalledOnce()
      expect(result).toBeTruthy()
    })

    it('regenerates when cached lesson is flagged', async () => {
      mockFindOne.mockResolvedValue({ cacheKey: 'abc', reviewStatus: 'flagged' })
      mockCompletion.mockResolvedValue({ text: validLessonJson, inputTokens: 50, outputTokens: 200 })
      mockFindOneAndUpdate.mockImplementation((_q, update) => update)

      await getOrGenerateLesson({ competency: 'specificity', domain: 'pm', depth: 'behavioral' })

      expect(mockCompletion).toHaveBeenCalledOnce()
    })

    it('strips markdown fences from LLM response', async () => {
      mockFindOne.mockResolvedValue(null)
      mockCompletion.mockResolvedValue({
        text: '```json\n' + validLessonJson + '\n```',
        inputTokens: 50,
        outputTokens: 200,
      })
      mockFindOneAndUpdate.mockImplementation((_q, update) => update)

      const result = await getOrGenerateLesson({
        competency: 'specificity', domain: 'pm', depth: 'behavioral',
      })

      expect(result).toBeTruthy()
    })

    it('returns existing cached lesson on LLM failure', async () => {
      const cached = { cacheKey: 'abc', reviewStatus: 'flagged', title: 'Old' }
      mockFindOne.mockResolvedValue(cached)
      mockCompletion.mockRejectedValue(new Error('LLM down'))

      const result = await getOrGenerateLesson({
        competency: 'specificity', domain: 'pm', depth: 'behavioral',
      })

      expect(result).toBe(cached)
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled()
    })

    it('rejects malformed LLM output', async () => {
      mockFindOne.mockResolvedValue(null)
      mockCompletion.mockResolvedValue({
        text: JSON.stringify({ title: 'incomplete' }),
        inputTokens: 10, outputTokens: 10,
      })

      const result = await getOrGenerateLesson({
        competency: 'specificity', domain: 'pm', depth: 'behavioral',
      })

      expect(result).toBeNull()
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled()
    })

    it('rejects LLM output missing example', async () => {
      mockFindOne.mockResolvedValue(null)
      mockCompletion.mockResolvedValue({
        text: JSON.stringify({
          title: 'x', conceptSummary: 'y', conceptDeepDive: 'z',
          keyTakeaways: ['a'],
        }),
        inputTokens: 10, outputTokens: 10,
      })

      const result = await getOrGenerateLesson({
        competency: 'specificity', domain: 'pm', depth: 'behavioral',
      })

      expect(result).toBeNull()
    })

    it('deduplicates concurrent cache-miss requests for the same lesson', async () => {
      mockFindOne.mockResolvedValue(null)
      let resolveCompletion: (v: unknown) => void
      const completionPromise = new Promise((r) => { resolveCompletion = r })
      mockCompletion.mockReturnValue(completionPromise)
      const stored = { title: 'Deduped', cacheKey: 'x' }
      mockFindOneAndUpdate.mockResolvedValue(stored)

      const input = { competency: 'specificity', domain: 'pm', depth: 'behavioral' }
      const p1 = getOrGenerateLesson(input)
      const p2 = getOrGenerateLesson(input)

      resolveCompletion!({ text: validLessonJson, inputTokens: 50, outputTokens: 200 })

      const [r1, r2] = await Promise.all([p1, p2])

      expect(mockCompletion).toHaveBeenCalledOnce()
      expect(r1).toBe(r2)
    })

    it('caches repaired (truncated) lessons with reviewStatus="flagged" so they regenerate next access (Codex P2 PR #387)', async () => {
      // Codex P2 — when JSON.parse fails and repairTruncatedJson rescues
      // the output, the result may be missing trailing fields (e.g. 1 of
      // 4 keyTakeaways) but still pass isValidLesson. Caching as
      // 'pending' would serve that partial content forever; caching as
      // 'flagged' ensures getOrGenerateLesson's `reviewStatus !== 'flagged'`
      // check triggers a fresh LLM call on the next request.
      mockFindOne.mockResolvedValue(null)
      // Truncated mid-keyTakeaways. The repair will close `["a","b"`,
      // add `]`, then close the object. isValidLesson passes because
      // the schema only requires keyTakeaways.length > 0.
      const truncated = JSON.stringify({
        title: 'X',
        conceptSummary: 'short',
        conceptDeepDive: 'short',
        example: {
          question: 'Q',
          goodAnswer: 'A',
          annotations: ['x'],
        },
      }).slice(0, -1) + ',"keyTakeaways":["a","b"'
      mockCompletion.mockResolvedValue({
        text: truncated,
        inputTokens: 10,
        outputTokens: 100,
      })
      mockFindOneAndUpdate.mockImplementation((_q, update) => update)

      await getOrGenerateLesson({
        competency: 'specificity',
        domain: 'pm',
        depth: 'behavioral',
      })

      expect(mockFindOneAndUpdate).toHaveBeenCalledOnce()
      const upsertedDoc = mockFindOneAndUpdate.mock.calls[0][1]
      expect(upsertedDoc.reviewStatus).toBe('flagged')
    })

    it('caches clean (non-repaired) lessons with reviewStatus="pending"', async () => {
      mockFindOne.mockResolvedValue(null)
      mockCompletion.mockResolvedValue({
        text: validLessonJson,
        inputTokens: 50,
        outputTokens: 200,
      })
      mockFindOneAndUpdate.mockImplementation((_q, update) => update)

      await getOrGenerateLesson({
        competency: 'specificity',
        domain: 'pm',
        depth: 'behavioral',
      })

      const upsertedDoc = mockFindOneAndUpdate.mock.calls[0][1]
      expect(upsertedDoc.reviewStatus).toBe('pending')
    })

    it('returns null (not unhandled rejection) when shared in-flight promise rejects', async () => {
      mockFindOne.mockResolvedValue(null)
      mockCompletion.mockRejectedValue(new Error('LLM down'))

      const input = { competency: 'specificity', domain: 'pm', depth: 'behavioral' }
      const p1 = getOrGenerateLesson(input)
      const p2 = getOrGenerateLesson(input)

      const [r1, r2] = await Promise.all([p1, p2])

      expect(r1).toBeNull()
      expect(r2).toBeNull()
    })
  })

  describe('flagLesson', () => {
    it('returns true when a lesson was modified', async () => {
      mockUpdateOne.mockResolvedValue({ modifiedCount: 1 })
      expect(await flagLesson('abc')).toBe(true)
    })

    it('returns false when no lesson matched', async () => {
      mockUpdateOne.mockResolvedValue({ modifiedCount: 0 })
      expect(await flagLesson('missing')).toBe(false)
    })

    it('returns false on DB error', async () => {
      mockUpdateOne.mockRejectedValue(new Error('boom'))
      expect(await flagLesson('abc')).toBe(false)
    })
  })
})
