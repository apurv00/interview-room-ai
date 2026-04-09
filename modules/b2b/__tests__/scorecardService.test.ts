import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const mockSessionFindOne = vi.fn()
const mockCompetencyFind = vi.fn()

vi.mock('@shared/db/models', () => ({
  InterviewSession: {
    findOne: (...args: unknown[]) => ({ lean: () => mockSessionFindOne(...args) }),
  },
  User: {},
}))

vi.mock('@shared/db/models/UserCompetencyState', () => ({
  UserCompetencyState: {
    find: (...args: unknown[]) => ({
      select: () => ({ lean: () => mockCompetencyFind(...args) }),
    }),
  },
}))

const mockClaudeCreate = vi.fn()
vi.mock('@shared/services/llmClient', () => ({
  getAnthropicClient: () => ({
    messages: { create: mockClaudeCreate },
  }),
}))

// ObjectId constructor — just pass through
vi.mock('mongoose', () => ({
  default: {
    Types: {
      ObjectId: class {
        value: string
        constructor(value: string) { this.value = value }
        toString() { return this.value }
      },
    },
  },
}))

import { getRecruiterScorecard } from '@b2b/services/scorecardService'

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('scorecardService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClaudeCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Solid candidate overall.' }],
      usage: { input_tokens: 50, output_tokens: 20 },
    })
  })

  describe('getRecruiterScorecard', () => {
    it('returns null when session not found', async () => {
      mockSessionFindOne.mockResolvedValue(null)
      const result = await getRecruiterScorecard('sess1', 'org1')
      expect(result).toBeNull()
    })

    it('returns null when session has no feedback', async () => {
      mockSessionFindOne.mockResolvedValue({
        _id: 'sess1',
        status: 'completed',
        feedback: null,
      })
      const result = await getRecruiterScorecard('sess1', 'org1')
      expect(result).toBeNull()
    })

    it('builds a full scorecard with per-question summaries and competency data', async () => {
      mockSessionFindOne.mockResolvedValue({
        _id: 'sess1',
        userId: 'user1',
        status: 'completed',
        config: { role: 'SWE', interviewType: 'screening', experience: '3-6' },
        createdAt: new Date('2026-01-01'),
        durationActualSeconds: 900,
        feedback: {
          overall_score: 82,
          pass_probability: 'High',
          dimensions: {
            answer_quality: {
              score: 85,
              strengths: ['clear', 'structured', 'specific'],
              weaknesses: ['brief'],
            },
            communication: { score: 80 },
            engagement_signals: { score: 78 },
          },
          top_3_improvements: ['more metrics', 'deeper examples', 'body language'],
          red_flags: [],
        },
        evaluations: [
          {
            question: 'Tell me about a hard bug.',
            relevance: 90,
            structure: 85,
            specificity: 80,
            ownership: 75,
            flags: [],
          },
          {
            question: 'How do you handle conflict?',
            relevance: 60,
            structure: 50,
            specificity: 55,
            ownership: 60,
            flags: ['vague'],
          },
        ],
        transcript: [
          { speaker: 'interviewer', text: 'Tell me about a hard bug.', questionIndex: 0 },
          { speaker: 'candidate', text: 'I debugged a complex race condition in prod...', questionIndex: 0 },
          { speaker: 'interviewer', text: 'How do you handle conflict?', questionIndex: 1 },
          { speaker: 'candidate', text: 'Um, I dunno, I usually just...', questionIndex: 1 },
        ],
      })
      mockCompetencyFind.mockResolvedValue([
        { competencyName: 'Technical Depth', currentScore: 82.4, trend: 'up' },
        { competencyName: 'Communication', currentScore: 74.1, trend: 'flat' },
      ])

      const result = await getRecruiterScorecard('sess1', 'org1')
      expect(result).not.toBeNull()
      expect(result!.domain).toBe('SWE')
      expect(result!.overallScore).toBe(82)
      expect(result!.passProb).toBe('High')
      expect(result!.durationSeconds).toBe(900)
      expect(result!.dimensions).toEqual({
        answerQuality: 85,
        communication: 80,
        engagement: 78,
      })

      // Per-question summaries
      expect(result!.questionSummaries).toHaveLength(2)
      expect(result!.questionSummaries[0].score).toBe(Math.round((90 + 85 + 80 + 75) / 4))
      expect(result!.questionSummaries[1].weaknesses).toEqual(['vague'])

      // Competency mapping
      expect(result!.competencyScores).toEqual([
        { name: 'Technical Depth', score: 82, trend: 'up' },
        { name: 'Communication', score: 74, trend: 'flat' },
      ])

      // Strong + weak quotes extracted
      expect(result!.keyQuotes.length).toBeGreaterThanOrEqual(1)
      expect(result!.keyQuotes[0].sentiment).toBe('positive')
      expect(result!.keyQuotes[0].text).toContain('race condition')

      // Recruiter summary came from Claude
      expect(result!.recruiterSummary).toBe('Solid candidate overall.')
      expect(mockClaudeCreate).toHaveBeenCalledTimes(1)
    })

    it('gracefully handles missing competency data', async () => {
      mockSessionFindOne.mockResolvedValue({
        _id: 'sess1',
        userId: null,
        status: 'completed',
        config: { role: 'PM' },
        createdAt: new Date(),
        feedback: {
          overall_score: 70,
          dimensions: { answer_quality: { score: 70 } },
        },
        evaluations: [],
        transcript: [],
      })
      const result = await getRecruiterScorecard('sess1', 'org1')
      expect(result).not.toBeNull()
      expect(result!.competencyScores).toEqual([])
      expect(result!.questionSummaries).toEqual([])
      expect(mockCompetencyFind).not.toHaveBeenCalled()
    })

    it('falls back to stub summary when Claude call throws', async () => {
      mockSessionFindOne.mockResolvedValue({
        _id: 'sess1',
        userId: null,
        status: 'completed',
        config: { role: 'Design' },
        createdAt: new Date(),
        feedback: {
          overall_score: 55,
          dimensions: { answer_quality: { score: 55 } },
        },
        evaluations: [],
        transcript: [],
      })
      mockClaudeCreate.mockRejectedValueOnce(new Error('LLM down'))
      const result = await getRecruiterScorecard('sess1', 'org1')
      expect(result).not.toBeNull()
      expect(result!.recruiterSummary).toBe('Candidate scored 55/100 in Design interview.')
    })

    it('returns null and logs on unexpected DB error', async () => {
      mockSessionFindOne.mockRejectedValue(new Error('db exploded'))
      const result = await getRecruiterScorecard('sess1', 'org1')
      expect(result).toBeNull()
    })
  })
})
