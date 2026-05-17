/**
 * Regression tests for two distinct lesson-queue bugs in universal pathway
 * (production diagnosis 2026-05-17 — user reported empty Lesson queue (0/0)
 * after 9 sessions in Phase 3 of 6):
 *
 *   Bug #1 — Legacy plans never self-heal
 *     Plans created before 2026-05-14 (commit 3a9a9e7 added the
 *     UNIVERSAL_FALLBACK_COMPETENCIES fallback) persisted `lessons: []`
 *     for users with no competency history. The UI showed
 *     "Lesson queue (0/0)" with no recovery path.
 *     Fix: getUniversalPlan self-heals empty lessons[] on first read.
 *
 *   Bug #2 — Plans don't refresh on phase transition
 *     advanceUniversalPlan bumped sessionsCompleted + phaseHistory but
 *     never recomputed plan.lessons. A user 3 phases deep kept seeing
 *     phase-1 lessons (or empty queue).
 *     Fix: advanceUniversalPlan rebuilds plan.lessons when graduated,
 *     preserving completion state for any lessons already finished.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  mockConnectDB,
  mockFindOnePlain,
  mockUpdateOne,
  mockGetCompetencySummary,
  mockIsFeatureEnabled,
  mockEmitPathwayEvent,
} = vi.hoisted(() => ({
  mockConnectDB: vi.fn().mockResolvedValue(undefined),
  mockFindOnePlain: vi.fn(),
  mockUpdateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  mockGetCompetencySummary: vi.fn(),
  mockIsFeatureEnabled: vi.fn().mockReturnValue(true),
  mockEmitPathwayEvent: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/db/connection', () => ({
  connectDB: (...a: unknown[]) => mockConnectDB(...a),
}))

vi.mock('@shared/featureFlags', () => ({
  isFeatureEnabled: (...a: unknown[]) => mockIsFeatureEnabled(...a),
}))

vi.mock('@shared/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@learn/services/competencyService', () => ({
  getUserCompetencySummary: (...a: unknown[]) => mockGetCompetencySummary(...a),
  getUserWeaknesses: vi.fn().mockResolvedValue([]),
}))

vi.mock('@learn/services/pathwayEvents', () => ({
  emitPathwayEvent: (...a: unknown[]) => mockEmitPathwayEvent(...a),
}))

vi.mock('@learn/services/lessonGenerator', () => ({
  getOrGenerateLesson: vi.fn().mockResolvedValue({ lessonId: 'cached' }),
  // Mirror production: deterministic key per (competency, domain, depth).
  // Tests rely on the COMPLETION-PRESERVATION path receiving the same key
  // shape that the source builds, so swap the SHA for a readable
  // concatenation — the assertion in `preserves completion state` matches
  // this format.
  buildLessonCacheKey: (competency: string, domain: string, depth: string) =>
    `${competency}::${domain}::${depth}`,
}))

vi.mock('@shared/db/models', () => ({
  PathwayPlan: {
    findOne: (...args: unknown[]) => mockFindOnePlain(...args),
    findOneAndUpdate: vi.fn(),
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
  },
  User: {
    findById: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      }),
    }),
  },
}))

import { getUniversalPlan, advanceUniversalPlan } from '@learn/services/pathwayPlanner'

const TEST_USER_ID = '507f1f77bcf86cd799439011'

beforeEach(() => {
  vi.clearAllMocks()
  mockConnectDB.mockResolvedValue(undefined)
  mockIsFeatureEnabled.mockReturnValue(true)
  mockUpdateOne.mockResolvedValue({ modifiedCount: 1 })
  mockGetCompetencySummary.mockResolvedValue({
    competencies: [],
    strongAreas: [],
    weakAreas: [],
    overallReadiness: 0,
  })
  mockEmitPathwayEvent.mockResolvedValue(undefined)
})

describe('getUniversalPlan — Bug #1: backfill empty lessons[]', () => {
  it('self-heals a legacy plan whose lessons[] is empty', async () => {
    // Plan exists, has currentPhase + domain + depth, but lessons is empty
    // (matches the production scenario the user reported).
    const planRow = {
      _id: 'plan-1',
      planType: 'universal',
      domain: 'general',
      depth: 'behavioral',
      currentPhase: 'building',
      sessionsCompleted: 9,
      lessons: [],
    }
    mockFindOnePlain.mockReturnValue({
      lean: vi.fn().mockResolvedValue(planRow),
    })

    const result = await getUniversalPlan(TEST_USER_ID)

    // Backfill ran: fallback ['relevance','structure','specificity']
    // (resolveUniversalFocus returns these when weak/strong areas are empty)
    expect(result?.lessons).toHaveLength(3)
    expect(result?.lessons?.[0]).toMatchObject({
      competency: expect.any(String),
      completed: false,
    })
    // Persisted back to Mongo so the next read sees the populated plan
    expect(mockUpdateOne).toHaveBeenCalledTimes(1)
    expect(mockUpdateOne.mock.calls[0][1]).toEqual({
      $set: { lessons: expect.any(Array) },
    })
  })

  it('does NOT backfill or persist when plan has lessons already', async () => {
    const planRow = {
      _id: 'plan-2',
      planType: 'universal',
      domain: 'general',
      depth: 'behavioral',
      currentPhase: 'building',
      sessionsCompleted: 9,
      lessons: [{ lessonId: 'L1', competency: 'specificity', completed: false }],
    }
    mockFindOnePlain.mockReturnValue({
      lean: vi.fn().mockResolvedValue(planRow),
    })

    const result = await getUniversalPlan(TEST_USER_ID)

    expect(result?.lessons).toHaveLength(1)
    expect(mockUpdateOne).not.toHaveBeenCalled()
  })

  it('does NOT crash when domain/depth missing — cannot compute lessonId cache key safely', async () => {
    const planRow = {
      _id: 'plan-3',
      planType: 'universal',
      // domain + depth absent
      currentPhase: 'building',
      sessionsCompleted: 9,
      lessons: [],
    }
    mockFindOnePlain.mockReturnValue({
      lean: vi.fn().mockResolvedValue(planRow),
    })

    const result = await getUniversalPlan(TEST_USER_ID)

    expect(result?.lessons).toEqual([])
    expect(mockUpdateOne).not.toHaveBeenCalled()
  })

  it('returns null when no plan exists', async () => {
    mockFindOnePlain.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    })

    const result = await getUniversalPlan(TEST_USER_ID)

    expect(result).toBeNull()
    expect(mockUpdateOne).not.toHaveBeenCalled()
  })

  it('degrades silently when competency-summary lookup throws (best-effort heal)', async () => {
    const planRow = {
      _id: 'plan-4',
      planType: 'universal',
      domain: 'general',
      depth: 'behavioral',
      currentPhase: 'building',
      sessionsCompleted: 9,
      lessons: [],
    }
    mockFindOnePlain.mockReturnValue({
      lean: vi.fn().mockResolvedValue(planRow),
    })
    mockGetCompetencySummary.mockRejectedValueOnce(new Error('boom'))

    const result = await getUniversalPlan(TEST_USER_ID)

    // Still returns the plan, just with the empty lessons array
    expect(result?._id).toBe('plan-4')
    expect(result?.lessons).toEqual([])
    // No persistence attempt when heal failed
    expect(mockUpdateOne).not.toHaveBeenCalled()
  })
})

describe('advanceUniversalPlan — Bug #2: refresh lessons on phase transition', () => {
  // The mongoose-document mock needs .save() to be a real spy and the plan
  // shape needs to be mutable across the function so we can assert on it.
  function makePlanDoc(overrides: Record<string, unknown> = {}) {
    const doc: Record<string, unknown> = {
      _id: 'plan-1',
      planType: 'universal',
      domain: 'general',
      depth: 'behavioral',
      // Cross the assessment→foundation threshold by advancing from 1 to 2
      sessionsCompleted: 1,
      currentPhase: 'assessment',
      phaseThresholds: { assessment: 2, foundation: 6, building: 14, intensity: 22, mastery: 28, review: 30 },
      phaseHistory: [],
      lessons: [],
      generatedAt: new Date('2026-04-01T00:00:00Z'),
      save: vi.fn().mockImplementation(async function (this: typeof doc) { return doc }),
      ...overrides,
    }
    return doc
  }

  it('refreshes plan.lessons when the user graduates into a new phase', async () => {
    const planDoc = makePlanDoc()
    // findOne (the mongoose document one — not lean) returns the doc directly
    mockFindOnePlain.mockResolvedValue(planDoc)

    const result = await advanceUniversalPlan(TEST_USER_ID)

    expect(result).not.toBeNull()
    expect(planDoc.sessionsCompleted).toBe(2) // bumped
    expect(planDoc.currentPhase).toBe('foundation') // graduated
    // lessons refreshed for new phase — 3 fallback entries since weak/strong empty
    expect(Array.isArray(planDoc.lessons)).toBe(true)
    expect((planDoc.lessons as unknown[]).length).toBeGreaterThan(0)
    expect(planDoc.save).toHaveBeenCalledTimes(1)
  })

  it('preserves completion state of existing lessons across the refresh', async () => {
    const existingCompletedAt = new Date('2026-05-01T00:00:00Z')
    const planDoc = makePlanDoc({
      lessons: [
        // Use the deterministic cache-key format so the refresh sees a match.
        // buildLessonCacheKey is `${competency}::${domain}::${depth}` per
        // pathwayPlanner internals — we mirror that here.
        {
          lessonId: 'relevance::general::behavioral',
          competency: 'relevance',
          completed: true,
          completedAt: existingCompletedAt,
        },
      ],
    })
    mockFindOnePlain.mockResolvedValue(planDoc)

    await advanceUniversalPlan(TEST_USER_ID)

    const lessons = planDoc.lessons as Array<{
      lessonId: string
      competency: string
      completed: boolean
      completedAt?: Date
    }>
    const relevance = lessons.find((l) => l.competency === 'relevance')
    expect(relevance?.completed).toBe(true)
    expect(relevance?.completedAt).toEqual(existingCompletedAt)
  })

  it('does NOT refresh lessons when no phase graduation occurred', async () => {
    const planDoc = makePlanDoc({
      sessionsCompleted: 5, // bumping to 6 graduates foundation→building... actually graduates
    })
    // Use a sessionsCompleted that won't graduate: from 2 to 3 stays in foundation
    planDoc.sessionsCompleted = 2 // graduates assessment, not what we want
    planDoc.sessionsCompleted = 3 // 3→4: stays in foundation (threshold 6)
    const originalLessons = planDoc.lessons
    mockFindOnePlain.mockResolvedValue(planDoc)

    await advanceUniversalPlan(TEST_USER_ID)

    // 4 is below foundation threshold of 6 → still foundation → no graduation
    expect(planDoc.currentPhase).toBe('foundation')
    // Lessons untouched (still the same array reference / same content)
    expect(planDoc.lessons).toBe(originalLessons)
  })

  it('survives a competency-summary error during refresh — sessions still advance', async () => {
    const planDoc = makePlanDoc()
    mockFindOnePlain.mockResolvedValue(planDoc)
    mockGetCompetencySummary.mockRejectedValueOnce(new Error('boom'))

    const result = await advanceUniversalPlan(TEST_USER_ID)

    expect(result).not.toBeNull()
    // sessionsCompleted + phase advancement still landed
    expect(planDoc.sessionsCompleted).toBe(2)
    expect(planDoc.currentPhase).toBe('foundation')
    // Save still called — lesson refresh failure must not block the
    // higher-priority progression update
    expect(planDoc.save).toHaveBeenCalledTimes(1)
  })
})
