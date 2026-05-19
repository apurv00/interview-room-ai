/**
 * Tests for drillService — Wave 5 additions:
 *   - `getDrillHistory` now accepts optional competency filter and
 *     applies it at the DB layer (so `limit` applies to the
 *     post-filter count, not pre-filter)
 *   - `saveDrillAttempt` now persists the per-dimension `breakdown`
 *     field (5D); backwards-compat: callers may omit it
 *
 * Existing behaviour (delta computation, ObjectId conversion) also
 * locked here so it can't drift silently.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@shared/logger', () => ({
  aiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const {
  mockCreate, mockFind, mockSessionFind,
  mockGenerateEmbedding, mockRedisMget, mockRedisSetex,
} = vi.hoisted(() => ({
  mockCreate: vi.fn().mockResolvedValue({ _id: 'drill-id' }),
  mockFind: vi.fn(),
  mockSessionFind: vi.fn(),
  mockGenerateEmbedding: vi.fn(),
  mockRedisMget: vi.fn(),
  mockRedisSetex: vi.fn(),
}))
vi.mock('@shared/db/models/DrillAttempt', () => ({
  DrillAttempt: {
    create: (...args: unknown[]) => mockCreate(...args),
    find: (...args: unknown[]) => mockFind(...args),
  },
}))
vi.mock('@shared/db/models/InterviewSession', () => ({
  InterviewSession: { find: (...args: unknown[]) => mockSessionFind(...args) },
}))
vi.mock('@interview/services/core/embeddingService', () => ({
  generateEmbedding: (...args: unknown[]) => mockGenerateEmbedding(...args),
}))
vi.mock('@shared/redis', () => ({
  redis: {
    mget: (...keys: string[]) => mockRedisMget(...keys),
    setex: (...args: unknown[]) => mockRedisSetex(...args),
  },
}))

import { saveDrillAttempt, getDrillHistory, getWeakQuestions } from '../services/drillService'

const USER_ID = '507f1f77bcf86cd799439099'
const SESSION_ID = '507f1f77bcf86cd799439077'

beforeEach(() => {
  mockCreate.mockClear()
  mockFind.mockReset()
  mockSessionFind.mockReset()
  // Default: embedding API down + Redis empty → drillService takes
  // the text-cluster fallback path. Existing tests that lock the
  // text-normalizer behaviour rely on this. Tests for the embedding
  // path override these in-test.
  mockGenerateEmbedding.mockReset()
  mockGenerateEmbedding.mockRejectedValue(new Error('embeddings not configured in test'))
  mockRedisMget.mockReset()
  mockRedisMget.mockImplementation((...keys: string[]) =>
    Promise.resolve(keys.map(() => null)),
  )
  mockRedisSetex.mockReset()
  mockRedisSetex.mockResolvedValue('OK')
})

/** Build the chain that `InterviewSession.find(...).sort(...).limit(...).select(...).lean()` returns. */
function mockSessionsReturning(sessions: unknown[]) {
  mockSessionFind.mockReturnValue({
    sort: () => ({
      limit: () => ({
        select: () => ({
          lean: async () => sessions,
        }),
      }),
    }),
  })
}

function mkEval(qIdx: number, question: string, scores: { r: number; s: number; sp: number; o: number }) {
  return {
    questionIndex: qIdx,
    question,
    answer: 'a',
    relevance: scores.r,
    structure: scores.s,
    specificity: scores.sp,
    ownership: scores.o,
  }
}

describe('saveDrillAttempt (Wave 5 breakdown)', () => {
  it('persists breakdown when caller provides it', async () => {
    await saveDrillAttempt(USER_ID, {
      sessionId: SESSION_ID,
      questionIndex: 0,
      question: 'Tell me about a leadership moment.',
      originalAnswer: 'old',
      originalScore: 40,
      newAnswer: 'new',
      newScore: 70,
      competency: 'specificity',
      breakdown: { relevance: 80, structure: 65, specificity: 65, ownership: 70 },
    })
    expect(mockCreate).toHaveBeenCalledTimes(1)
    const persisted = mockCreate.mock.calls[0][0]
    expect(persisted.breakdown).toEqual({
      relevance: 80,
      structure: 65,
      specificity: 65,
      ownership: 70,
    })
    expect(persisted.delta).toBe(30)
    expect(persisted.competency).toBe('specificity')
  })

  it('omits breakdown when caller does not provide it (backwards-compat)', async () => {
    await saveDrillAttempt(USER_ID, {
      sessionId: SESSION_ID,
      questionIndex: 0,
      question: 'Q',
      originalAnswer: 'old',
      originalScore: 50,
      newAnswer: 'new',
      newScore: 60,
      competency: 'relevance',
    })
    expect(mockCreate).toHaveBeenCalledTimes(1)
    const persisted = mockCreate.mock.calls[0][0]
    expect(persisted.breakdown).toBeUndefined()
    expect(persisted.delta).toBe(10)
  })
})

describe('getDrillHistory (Wave 5 competency filter)', () => {
  function attemptsChain(rows: unknown[]) {
    return {
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue(rows),
    }
  }

  it('applies a competency filter at the DB layer when provided', async () => {
    mockFind.mockReturnValue(attemptsChain([]))
    await getDrillHistory(USER_ID, 10, 'specificity')
    const filter = mockFind.mock.calls[0][0]
    expect(filter.competency).toBe('specificity')
  })

  it('does NOT add a competency filter when omitted', async () => {
    mockFind.mockReturnValue(attemptsChain([]))
    await getDrillHistory(USER_ID, 10)
    const filter = mockFind.mock.calls[0][0]
    expect(filter.competency).toBeUndefined()
  })

  it('passes through breakdown when present on the row, undefined when absent (mixed compat)', async () => {
    mockFind.mockReturnValue(
      attemptsChain([
        {
          _id: { toString: () => 'a1' },
          question: 'new q',
          originalScore: 50,
          newScore: 70,
          delta: 20,
          competency: 'specificity',
          createdAt: new Date('2026-05-17T00:00:00Z'),
          breakdown: { relevance: 75, structure: 60, specificity: 70, ownership: 75 },
        },
        {
          _id: { toString: () => 'a2' },
          question: 'old q',
          originalScore: 40,
          newScore: 50,
          delta: 10,
          competency: 'specificity',
          createdAt: new Date('2026-04-01T00:00:00Z'),
          // No breakdown — pre-Wave-5 row
        },
      ]),
    )
    const out = await getDrillHistory(USER_ID, 10, 'specificity')
    expect(out).toHaveLength(2)
    expect(out[0].breakdown).toBeTruthy()
    expect(out[1].breakdown).toBeUndefined()
  })

  it('returns [] on DB error (best-effort)', async () => {
    mockFind.mockImplementation(() => {
      throw new Error('boom')
    })
    const out = await getDrillHistory(USER_ID)
    expect(out).toEqual([])
  })
})

describe('getWeakQuestions (E1 cluster + count)', () => {
  // All scores below 60 → all included as weak. Cluster on normalized
  // question text. The dedup keeps the WORST-scoring attempt per
  // cluster and stamps `attemptCount` with the full cluster size.
  const SCORES_30 = { r: 30, s: 30, sp: 30, o: 30 } // avg 30
  const SCORES_40 = { r: 40, s: 40, sp: 40, o: 40 } // avg 40
  const SCORES_50 = { r: 50, s: 50, sp: 50, o: 50 } // avg 50

  it('clubs the same question across sessions and stamps attemptCount', async () => {
    mockSessionsReturning([
      {
        _id: { toString: () => 'sess-a' },
        createdAt: new Date('2026-05-01'),
        evaluations: [mkEval(0, 'Tell me about a time you led a team.', SCORES_50)],
      },
      {
        _id: { toString: () => 'sess-b' },
        createdAt: new Date('2026-05-02'),
        evaluations: [mkEval(0, 'Tell me about a time you led a team.', SCORES_40)],
      },
      {
        _id: { toString: () => 'sess-c' },
        createdAt: new Date('2026-05-03'),
        evaluations: [mkEval(0, 'Tell me about a time you led a team.', SCORES_30)],
      },
    ])

    const out = await getWeakQuestions(USER_ID, 20)
    expect(out).toHaveLength(1)
    expect(out[0].attemptCount).toBe(3)
    // Worst-scoring attempt is kept (matches the practice-mode
    // mental model: "drill where I'm weakest")
    expect(out[0].avgScore).toBe(30)
    expect(out[0].sessionId).toBe('sess-c')
  })

  it('clubs near-duplicates that differ only in trailing punctuation', async () => {
    // Two LLM-generated phrasings of the same question — the prior
    // .toLowerCase().trim() dedup let these through; the aggressive
    // normalizer (strip punctuation + collapse whitespace) catches
    // them.
    mockSessionsReturning([
      {
        _id: { toString: () => 'sess-a' },
        createdAt: new Date('2026-05-01'),
        evaluations: [mkEval(0, 'Tell me about a time you led a team.', SCORES_40)],
      },
      {
        _id: { toString: () => 'sess-b' },
        createdAt: new Date('2026-05-02'),
        evaluations: [mkEval(0, 'Tell me about a time you led a team', SCORES_30)],
      },
    ])

    const out = await getWeakQuestions(USER_ID, 20)
    expect(out).toHaveLength(1)
    expect(out[0].attemptCount).toBe(2)
  })

  it('treats different questions as separate clusters', async () => {
    mockSessionsReturning([
      {
        _id: { toString: () => 'sess-a' },
        createdAt: new Date('2026-05-01'),
        evaluations: [
          mkEval(0, 'Tell me about a time you led a team.', SCORES_40),
          mkEval(1, 'How do you handle conflicting priorities?', SCORES_30),
        ],
      },
    ])

    const out = await getWeakQuestions(USER_ID, 20)
    expect(out).toHaveLength(2)
    // Each cluster has 1 attempt
    expect(out.every((q) => q.attemptCount === 1)).toBe(true)
  })

  it('handles case + whitespace + punctuation variants together', async () => {
    mockSessionsReturning([
      {
        _id: { toString: () => 'sess-a' },
        createdAt: new Date('2026-05-01'),
        evaluations: [mkEval(0, "What's your biggest weakness?", SCORES_40)],
      },
      {
        _id: { toString: () => 'sess-b' },
        createdAt: new Date('2026-05-02'),
        evaluations: [mkEval(0, 'WHATS YOUR  BIGGEST WEAKNESS', SCORES_30)],
      },
    ])

    const out = await getWeakQuestions(USER_ID, 20)
    expect(out).toHaveLength(1)
    expect(out[0].attemptCount).toBe(2)
    expect(out[0].avgScore).toBe(30)
  })

  it('excludes questions scoring >= 60', async () => {
    mockSessionsReturning([
      {
        _id: { toString: () => 'sess-a' },
        createdAt: new Date('2026-05-01'),
        evaluations: [
          mkEval(0, 'Strong answer Q', { r: 80, s: 80, sp: 80, o: 80 }),
          mkEval(1, 'Weak Q', SCORES_30),
        ],
      },
    ])

    const out = await getWeakQuestions(USER_ID, 20)
    expect(out).toHaveLength(1)
    expect(out[0].question).toBe('Weak Q')
  })

  it('still applies the competency filter on the weakest dim', async () => {
    mockSessionsReturning([
      {
        _id: { toString: () => 'sess-a' },
        createdAt: new Date('2026-05-01'),
        evaluations: [
          // weakest = relevance
          mkEval(0, 'Q1', { r: 20, s: 50, sp: 50, o: 50 }),
          // weakest = structure
          mkEval(1, 'Q2', { r: 50, s: 20, sp: 50, o: 50 }),
        ],
      },
    ])

    const out = await getWeakQuestions(USER_ID, 20, 'structure')
    expect(out).toHaveLength(1)
    expect(out[0].question).toBe('Q2')
  })

  it('respects the limit after clustering', async () => {
    mockSessionsReturning([
      {
        _id: { toString: () => 'sess-a' },
        createdAt: new Date('2026-05-01'),
        evaluations: [
          mkEval(0, 'Q1', SCORES_30),
          mkEval(1, 'Q2', SCORES_30),
          mkEval(2, 'Q3', SCORES_30),
        ],
      },
    ])

    const out = await getWeakQuestions(USER_ID, 2)
    expect(out).toHaveLength(2)
  })

  it('returns [] on DB error (best-effort)', async () => {
    mockSessionFind.mockImplementation(() => {
      throw new Error('boom')
    })
    const out = await getWeakQuestions(USER_ID)
    expect(out).toEqual([])
  })

  // Codex P1 on PR #394 — the prior regex used ASCII-only `\w`,
  // which collapsed every non-Latin question to the empty string
  // and dedup'd them all into a single survivor. The Unicode-aware
  // `\p{L}\p{N}` with the `u` flag preserves letters from any
  // script.
  it('preserves non-Latin scripts in the dedup key (distinct CJK questions stay separate)', async () => {
    mockSessionsReturning([
      {
        _id: { toString: () => 'sess-a' },
        createdAt: new Date('2026-05-01'),
        evaluations: [
          mkEval(0, '你最大的弱点是什么?', SCORES_40),
          mkEval(1, '描述一个领导团队的经历', SCORES_30),
        ],
      },
    ])

    const out = await getWeakQuestions(USER_ID, 20)
    // Two distinct CJK questions — must NOT collapse into one.
    expect(out).toHaveLength(2)
    expect(out.every((q) => q.attemptCount === 1)).toBe(true)
  })

  it('preserves accented Latin characters in the dedup key', async () => {
    mockSessionsReturning([
      {
        _id: { toString: () => 'sess-a' },
        createdAt: new Date('2026-05-01'),
        evaluations: [
          mkEval(0, 'Describe naïve approach to São Paulo expansion', SCORES_40),
          mkEval(1, 'Describe the rollout strategy', SCORES_30),
        ],
      },
    ])

    const out = await getWeakQuestions(USER_ID, 20)
    // Accented letters must survive as content, not get stripped to
    // spaces — these are two genuinely different questions.
    expect(out).toHaveLength(2)
  })

  it('still clusters identical non-Latin questions across sessions', async () => {
    // Sanity: clustering still works for non-Latin text — the regex
    // change preserved letters but punctuation/whitespace
    // normalization still applies.
    mockSessionsReturning([
      {
        _id: { toString: () => 'sess-a' },
        createdAt: new Date('2026-05-01'),
        evaluations: [mkEval(0, '你最大的弱点是什么?', SCORES_40)],
      },
      {
        _id: { toString: () => 'sess-b' },
        createdAt: new Date('2026-05-02'),
        evaluations: [mkEval(0, '你最大的弱点是什么?', SCORES_30)],
      },
    ])

    const out = await getWeakQuestions(USER_ID, 20)
    expect(out).toHaveLength(1)
    expect(out[0].attemptCount).toBe(2)
  })
})

describe('getWeakQuestions — failed-eval + greeting-pattern filters (2026-05-19)', () => {
  const SCORES_30 = { r: 30, s: 30, sp: 30, o: 30 }

  it('skips evals with status=failed (LLM couldn\'t score the answer)', async () => {
    mockSessionsReturning([
      {
        _id: { toString: () => 'sess-a' },
        createdAt: new Date('2026-05-01'),
        evaluations: [
          { ...mkEval(0, 'Question with failed eval', SCORES_30), status: 'failed' },
          mkEval(1, 'Question that was scored OK', SCORES_30),
        ],
      },
    ])
    const out = await getWeakQuestions(USER_ID, 20)
    expect(out).toHaveLength(1)
    expect(out[0].question).toBe('Question that was scored OK')
  })

  it('skips ALL AI intro greeting variants (PM / SWE / Sales / MBA / coding / design)', async () => {
    // Codex P2 round 2 on PR #397: the prior `^Hi[,!]` regex only
    // caught the PM + generic + coding/design openers. The SWE
    // ("Hey, welcome!"), Sales ("Great to meet you!"), and MBA
    // ("Hello!") variants leaked through. New regex anchors on the
    // shared "I'm Alex" substring within the first 40 chars.
    mockSessionsReturning([
      {
        _id: { toString: () => 'sess-a' },
        createdAt: new Date('2026-05-01'),
        evaluations: [
          // PM intro (interviewConfig.ts)
          mkEval(0, "Hi, I'm Alex — thanks for making time today. We'll be doing a Product Manager screening.", SCORES_30),
          // SWE intro (interviewConfig.ts)
          mkEval(1, "Hey, welcome! I'm Alex from the talent team. We'll spend a bit of time today on your background.", SCORES_30),
          // Sales intro (interviewConfig.ts)
          mkEval(2, "Great to meet you! I'm Alex. We're going to talk about your sales experience and what drives you.", SCORES_30),
          // MBA intro (interviewConfig.ts)
          mkEval(3, "Hello! I'm Alex, nice to have you here. This is a general business leadership screen.", SCORES_30),
          // Coding intro (useInterview.ts)
          mkEval(4, "Hi! I'm Alex, and today we'll work through a coding challenge together.", SCORES_30),
          // Generic fallback (interviewConfig.ts)
          mkEval(5, "Hi, I'm Alex — thanks for joining today. We'll be doing a Pm screening.", SCORES_30),
          // Real candidate-facing question — must stay
          mkEval(6, 'A real question', SCORES_30),
        ],
      },
    ])
    const out = await getWeakQuestions(USER_ID, 20)
    expect(out).toHaveLength(1)
    expect(out[0].question).toBe('A real question')
  })

  it('catches smart-quote variants of the intro (LLM-echoed typographic apostrophes)', async () => {
    // Codex P2 round 3 on PR #397: the prior literal-smart-quote chars
    // in the regex source got silently flattened to ASCII apostrophe
    // by an editor pass, so an LLM-echoed question with U+2019 (right
    // single quotation mark) in "I’m Alex" would leak through.
    // Regex now uses ' ‘ ’ escapes — editor-proof.
    mockSessionsReturning([
      {
        _id: { toString: () => 'sess-a' },
        createdAt: new Date('2026-05-01'),
        evaluations: [
          // U+2019 right single quotation mark
          mkEval(0, 'Hi, I’m Alex — thanks for joining today.', SCORES_30),
          // U+2018 left single quotation mark (less common but possible)
          mkEval(1, 'Hey, welcome! I‘m Alex from the talent team.', SCORES_30),
          // ASCII (still must match)
          mkEval(2, "Hi, I'm Alex — same content, ASCII apostrophe.", SCORES_30),
          // Real question — must stay
          mkEval(3, 'A genuinely drillable question.', SCORES_30),
        ],
      },
    ])
    const out = await getWeakQuestions(USER_ID, 20)
    expect(out).toHaveLength(1)
    expect(out[0].question).toBe('A genuinely drillable question.')
  })

  it('PRESERVES a candidate\'s blank/off-topic 0/0/0/0 answer (Codex P2 regression guard)', async () => {
    // A candidate's genuinely-bad answer can score 0/0/0/0. The prior
    // all-zero filter would have hidden it; the new greeting-pattern
    // filter only targets the AI opener.
    mockSessionsReturning([
      {
        _id: { toString: () => 'sess-a' },
        createdAt: new Date('2026-05-01'),
        evaluations: [
          // Real question with a blank/off-topic answer → all zeros
          mkEval(0, 'Tell me about a time you led a team.', { r: 0, s: 0, sp: 0, o: 0 }),
        ],
      },
    ])
    const out = await getWeakQuestions(USER_ID, 20)
    expect(out).toHaveLength(1)
    expect(out[0].avgScore).toBe(0)
    expect(out[0].question).toBe('Tell me about a time you led a team.')
  })

  it('does NOT mistake real candidate questions starting with "Hi" for the AI greeting', async () => {
    // Pattern requires "I'm Alex" anywhere in the first 40 chars
    // (any opener prefix). A question like "Hi there — talk through
    // how you would prioritize?" doesn't contain "I'm Alex", so it
    // stays in the list.
    mockSessionsReturning([
      {
        _id: { toString: () => 'sess-a' },
        createdAt: new Date('2026-05-01'),
        evaluations: [
          mkEval(0, 'Hi there — talk through how you would prioritize.', SCORES_30),
          // Mention of "Alex" without "I'm" prefix — must not match
          mkEval(1, 'Tell me about a time Alex on your team underperformed.', SCORES_30),
        ],
      },
    ])
    const out = await getWeakQuestions(USER_ID, 20)
    expect(out).toHaveLength(2)
  })
})

describe('getWeakQuestions — embedding-based semantic clustering (2026-05-19)', () => {
  const SCORES_30 = { r: 30, s: 30, sp: 30, o: 30 }
  const SCORES_40 = { r: 40, s: 40, sp: 40, o: 40 }

  it('clusters semantically-similar questions (lexically very different)', async () => {
    // Real screenshot example: main question + AI follow-up probe on
    // the same topic. Lexically unrelated; semantically the same drill.
    // Mock returns close vectors for both "product launch" variants and
    // a far vector for an unrelated question.
    mockGenerateEmbedding.mockImplementation(async (text: string) => {
      if (text.includes('Tell me about a time you owned a product launch')) {
        return [1, 0.05, 0]
      }
      if (text.includes('walk me through a real product launch')) {
        return [0.95, 0.1, 0] // cos sim with above ≈ 0.998
      }
      return [0, 0, 1] // far from both
    })

    mockSessionsReturning([
      {
        _id: { toString: () => 'sess-a' },
        createdAt: new Date('2026-05-01'),
        evaluations: [
          mkEval(0, 'Tell me about a time you owned a product launch end to end.', SCORES_40),
          mkEval(1, 'Can you walk me through a real product launch you owned?', SCORES_30),
          mkEval(2, 'Describe how you handle conflict on a cross-functional team.', SCORES_40),
        ],
      },
    ])

    const out = await getWeakQuestions(USER_ID, 20)
    // Two clusters: product-launch (count 2) and conflict (count 1).
    expect(out).toHaveLength(2)
    const productLaunchCluster = out.find((q) => q.question.includes('product launch'))
    expect(productLaunchCluster?.attemptCount).toBe(2)
    // The lowest-scoring attempt survived (avg 30, the probe).
    expect(productLaunchCluster?.avgScore).toBe(30)
  })

  it('clusters template variants where only a noun phrase differs (semantic, lexically off)', async () => {
    // The "AI intro greeting" variant of this test was retired —
    // greeting templates are now filtered earlier by the
    // greeting-pattern rule (Codex P2 PR #397). This case keeps the
    // intent: two questions that share a template but differ on a
    // domain noun phrase (lexically far enough to dodge the text-
    // normalizer) must still cluster via embeddings.
    mockGenerateEmbedding.mockImplementation(async (text: string) => {
      if (text.includes('led a team through')) {
        return [1, 0, 0] // both template variants get the same vector
      }
      return [0, 1, 0]
    })

    mockSessionsReturning([
      {
        _id: { toString: () => 'sess-a' },
        createdAt: new Date('2026-05-01'),
        evaluations: [
          mkEval(0, 'Tell me about a time you led a team through a big API migration.', SCORES_40),
          mkEval(1, 'Tell me about a time you led a team through a major schema overhaul.', SCORES_30),
        ],
      },
    ])

    const out = await getWeakQuestions(USER_ID, 20)
    expect(out).toHaveLength(1)
    expect(out[0].attemptCount).toBe(2)
  })

  it('does NOT cluster questions on different topics (cosine below threshold)', async () => {
    // Sanity: two genuinely different questions must stay separate
    // even when both have low scores.
    mockGenerateEmbedding.mockImplementation(async (text: string) => {
      if (text.includes('product launch')) return [1, 0, 0]
      if (text.includes('conflict')) return [0, 1, 0]
      return [0, 0, 1]
    })

    mockSessionsReturning([
      {
        _id: { toString: () => 'sess-a' },
        createdAt: new Date('2026-05-01'),
        evaluations: [
          mkEval(0, 'Tell me about a product launch you owned.', SCORES_30),
          mkEval(1, 'Tell me about a time you handled team conflict.', SCORES_30),
        ],
      },
    ])

    const out = await getWeakQuestions(USER_ID, 20)
    expect(out).toHaveLength(2)
  })

  it('falls back to text-based clustering when embedding API throws', async () => {
    // Default mock setup (beforeEach) makes generateEmbedding reject
    // and Redis return all-nulls — so the embedding path bails to
    // null and clusterByText fires. Identical text should still
    // cluster via the text-normalizer.
    mockSessionsReturning([
      {
        _id: { toString: () => 'sess-a' },
        createdAt: new Date('2026-05-01'),
        evaluations: [
          mkEval(0, 'Identical question text.', SCORES_40),
        ],
      },
      {
        _id: { toString: () => 'sess-b' },
        createdAt: new Date('2026-05-02'),
        evaluations: [
          mkEval(0, 'Identical question text.', SCORES_30),
        ],
      },
    ])

    const out = await getWeakQuestions(USER_ID, 20)
    expect(out).toHaveLength(1)
    expect(out[0].attemptCount).toBe(2)
  })

  it('uses Redis-cached embeddings without calling the embedding API', async () => {
    // Pre-populate the cache for one of the texts. The drill loader
    // must read from Redis instead of calling generateEmbedding for it.
    mockRedisMget.mockImplementation((...keys: string[]) =>
      Promise.resolve(
        keys.map((k, i) =>
          // First key (the only unique text) returns a cached embedding
          i === 0 ? JSON.stringify([1, 0, 0]) : null,
        ),
      ),
    )

    mockSessionsReturning([
      {
        _id: { toString: () => 'sess-a' },
        createdAt: new Date('2026-05-01'),
        evaluations: [mkEval(0, 'Cached question.', SCORES_30)],
      },
    ])

    const out = await getWeakQuestions(USER_ID, 20)
    expect(out).toHaveLength(1)
    expect(mockGenerateEmbedding).not.toHaveBeenCalled()
  })
})

describe('getWeakQuestions — embedding safeguards (Codex P2 on PR #397)', () => {
  const SCORES_30 = { r: 30, s: 30, sp: 30, o: 30 }

  it('falls back to text-clustering when unique-question count exceeds the fan-out cap', async () => {
    // Heavy user: generate 60 unique weak questions (above the 50-cap).
    // The embedding path should bail entirely (return null), forcing
    // text-cluster — keeping the request bounded even if Redis is cold.
    mockSessionsReturning([
      {
        _id: { toString: () => 'sess-a' },
        createdAt: new Date('2026-05-01'),
        evaluations: Array.from({ length: 60 }, (_, i) =>
          mkEval(i, `Unique question text variant ${i}`, SCORES_30),
        ),
      },
    ])

    // Mock embedding API to record any call (should not be called).
    mockGenerateEmbedding.mockReset()
    mockGenerateEmbedding.mockResolvedValue([1, 0, 0])

    const out = await getWeakQuestions(USER_ID, 20)
    // 60 unique texts → cap exceeded → text-cluster → all 60 stay as
    // distinct (no duplicates by exact text), sliced to limit=20.
    expect(out).toHaveLength(20)
    expect(mockGenerateEmbedding).not.toHaveBeenCalled()
  })

  it('tolerates partial embedding-API failures (Promise.allSettled, not all-or-nothing)', async () => {
    // 4 weak questions; the embedding API succeeds for 3 and fails for
    // 1. Pre-fix (Promise.all), the whole batch would reject and the
    // semantic path would be dropped. Post-fix the request still uses
    // embeddings — the one failed item becomes its own cluster.
    mockSessionsReturning([
      {
        _id: { toString: () => 'sess-a' },
        createdAt: new Date('2026-05-01'),
        evaluations: [
          mkEval(0, 'Question A', SCORES_30),
          mkEval(1, 'Question A repeated', SCORES_30),
          mkEval(2, 'Question B', SCORES_30),
          mkEval(3, 'Question C (will fail)', SCORES_30),
        ],
      },
    ])

    mockGenerateEmbedding.mockReset()
    mockGenerateEmbedding.mockImplementation(async (text: string) => {
      if (text === 'Question C (will fail)') {
        throw new Error('transient embedding API error')
      }
      // Tight cluster for the two "Question A" variants
      if (text.startsWith('Question A')) return [1, 0.01, 0]
      if (text === 'Question B') return [0, 1, 0]
      return [0, 0, 1]
    })

    const out = await getWeakQuestions(USER_ID, 20)
    // Expected clusters:
    //   - Question A + Question A repeated (2 attempts) — embedded + clustered
    //   - Question B — embedded, own cluster
    //   - Question C (will fail) — failed embedding, own cluster
    // Total: 3 cards (down from 4 weak attempts).
    expect(out).toHaveLength(3)
    const aCluster = out.find((q) => q.question === 'Question A')
    expect(aCluster?.attemptCount).toBe(2)
  })

  it('text-clusters identical-text items whose embeddings BOTH failed (Codex P2 round 2)', async () => {
    // Codex regression catch: with the prior clusterByEmbedding, every
    // item whose embedding failed got its own cluster — so two
    // identical-text questions whose embeddings both failed showed as
    // 2 cards instead of 1. The fix routes missing-embedding items
    // through the text-key path so they still dedupe.
    //
    // Setup: 3 weak attempts → 2 unique texts. The "Two identical
    // failing questions" text fails to embed (both occurrences); the
    // "Different working question" succeeds. Result must be 2 cards,
    // with the failing-text cluster carrying attemptCount=2.
    mockSessionsReturning([
      {
        _id: { toString: () => 'sess-a' },
        createdAt: new Date('2026-05-01'),
        evaluations: [
          mkEval(0, 'Two identical failing questions', SCORES_30),
          mkEval(1, 'Two identical failing questions', { r: 40, s: 40, sp: 40, o: 40 }),
          mkEval(2, 'Different working question', SCORES_30),
        ],
      },
    ])

    mockGenerateEmbedding.mockReset()
    mockGenerateEmbedding.mockImplementation(async (text: string) => {
      if (text === 'Different working question') return [0, 1, 0]
      throw new Error('embedding API failed for this text only')
    })

    const out = await getWeakQuestions(USER_ID, 20)
    expect(out).toHaveLength(2)
    const failedCluster = out.find((q) => q.question === 'Two identical failing questions')
    expect(failedCluster?.attemptCount).toBe(2)
    // Lowest-scoring attempt survived as the representative.
    expect(failedCluster?.avgScore).toBe(30)
  })

  it('does NOT bail when one fresh cache miss fails alongside many cache hits (Codex P2 round 3)', async () => {
    // Codex regression: prior denominator was toFetch.length, so a
    // single cache-miss failure with many cached siblings tripped the
    // bail (`1 > 0.5 = true`) and dropped semantic clustering even
    // though 95%+ of data was available via cache. New denominator is
    // uniqueTexts.length so the threshold scales with request size.
    //
    // Setup: 5 unique texts, 4 are cache hits with embeddings that
    // cluster two of them together, 1 is a fresh fetch that fails.
    // Expected: NO bail, 4 cards (one cluster of 2 + 2 singletons +
    // the failed-fetch item as its own text-keyed cluster).
    const cachedA = JSON.stringify([1, 0, 0])
    const cachedAVariant = JSON.stringify([0.99, 0.05, 0]) // clusters with A
    const cachedB = JSON.stringify([0, 1, 0])
    const cachedC = JSON.stringify([0, 0, 1])

    // Mock Redis to return the 4 cached embeddings for the first 4
    // requested keys, null for the 5th (which triggers a fresh fetch).
    mockRedisMget.mockImplementation((...keys: string[]) =>
      Promise.resolve(
        keys.map((_k, i) => {
          if (i === 0) return cachedA
          if (i === 1) return cachedAVariant
          if (i === 2) return cachedB
          if (i === 3) return cachedC
          return null // fresh fetch needed
        }),
      ),
    )

    mockGenerateEmbedding.mockReset()
    mockGenerateEmbedding.mockRejectedValue(new Error('transient cache-miss failure'))

    mockSessionsReturning([
      {
        _id: { toString: () => 'sess-a' },
        createdAt: new Date('2026-05-01'),
        evaluations: [
          mkEval(0, 'Question A', SCORES_30),
          mkEval(1, 'Question A variant', SCORES_30),
          mkEval(2, 'Question B', SCORES_30),
          mkEval(3, 'Question C', SCORES_30),
          mkEval(4, 'Question D (cache miss + fetch fail)', SCORES_30),
        ],
      },
    ])

    const out = await getWeakQuestions(USER_ID, 20)
    // 4 clusters: {A + A-variant via cosine} + {B} + {C} + {D text-key fallback}.
    // Critically NOT 5 (which would mean the embedding path bailed and
    // text-cluster ran with no dedup).
    expect(out).toHaveLength(4)
    const aCluster = out.find((q) => q.question === 'Question A')
    expect(aCluster?.attemptCount).toBe(2)
    // Fresh-fetch failure was a single item — only 1 failure out of 5
    // unique texts → 1 > 2.5 false → no bail.
    expect(mockGenerateEmbedding).toHaveBeenCalledTimes(1)
  })

  it('bails to text-clustering when MAJORITY of embedding fetches fail', async () => {
    // 4 weak items, 3 of 4 embedding calls fail (>50%). Service treated
    // as unhealthy → bail to text-cluster path. The two identical items
    // ("Same question") still cluster via the text-normalizer.
    mockSessionsReturning([
      {
        _id: { toString: () => 'sess-a' },
        createdAt: new Date('2026-05-01'),
        evaluations: [
          mkEval(0, 'Same question', SCORES_30),
          mkEval(1, 'Same question', SCORES_30),
          mkEval(2, 'Different one', SCORES_30),
          mkEval(3, 'Yet another', SCORES_30),
        ],
      },
    ])

    let callCount = 0
    mockGenerateEmbedding.mockReset()
    mockGenerateEmbedding.mockImplementation(async () => {
      callCount++
      if (callCount === 1) return [1, 0, 0] // first succeeds
      throw new Error('embedding API unhealthy')
    })

    const out = await getWeakQuestions(USER_ID, 20)
    // Text-cluster collapses the "Same question" duplicates to one card.
    // 3 unique texts → 3 cards.
    expect(out).toHaveLength(3)
    const sameQ = out.find((q) => q.question === 'Same question')
    expect(sameQ?.attemptCount).toBe(2)
  })
})
