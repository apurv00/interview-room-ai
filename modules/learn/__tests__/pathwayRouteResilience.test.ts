/**
 * Regression tests for GET /api/learn/pathway resilience.
 *
 * Codex P1 on PR #383 — when the Wave 4 ActivityRhythm lookup
 * (`InterviewSession.findOne` for the user's most-recent completed
 * session) is placed unguarded inside `Promise.all`, any Mongo
 * hiccup or connection failure rejects the whole handler and
 * returns 500. The existing service helpers already degrade
 * gracefully via internal try/catch, so the page used to render
 * a usable payload even when individual fetches failed.
 *
 * These tests lock the invariant that:
 *
 *   1. A throw from connectDB during the rhythm lookup does NOT
 *      reject the handler; the response still includes pathway +
 *      competencySummary + weaknesses with activityRhythm degraded
 *      to nulls.
 *   2. A throw from the rhythm InterviewSession.findOne does NOT
 *      reject the handler — same degraded shape.
 *   3. Happy path: the rhythm timestamp flows through to the
 *      view model as `lastSessionAt`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const {
  mockConnectDB,
  mockGetCurrentPathway,
  mockGetUserCompetencySummary,
  mockGetUserWeaknesses,
  mockInterviewSessionFindOne,
  mockPathwayPlanFind,
  mockUserCompetencyStateFind,
  mockBuildPathwayViewModel,
} = vi.hoisted(() => ({
  mockConnectDB: vi.fn().mockResolvedValue(undefined),
  mockGetCurrentPathway: vi.fn(),
  mockGetUserCompetencySummary: vi.fn(),
  mockGetUserWeaknesses: vi.fn(),
  mockInterviewSessionFindOne: vi.fn(),
  mockPathwayPlanFind: vi.fn(),
  mockUserCompetencyStateFind: vi.fn(),
  mockBuildPathwayViewModel: vi.fn(),
}))

vi.mock('@shared/middleware/composeApiRoute', () => ({
  composeApiRoute: (opts: {
    handler: (
      req: NextRequest,
      ctx: { user: unknown; body: unknown; params: Record<string, string> },
    ) => Promise<Response>
  }) => async (req: NextRequest, ctx?: { params?: Record<string, string> }) => {
    return opts.handler(req, {
      user: { id: '507f1f77bcf86cd799439099', role: 'candidate', plan: 'free' },
      body: undefined,
      params: ctx?.params ?? {},
    })
  },
}))

vi.mock('@shared/db/connection', () => ({
  connectDB: (...a: unknown[]) => mockConnectDB(...a),
}))

vi.mock('@learn/services/pathwayPlanner', () => ({
  getCurrentPathway: (...a: unknown[]) => mockGetCurrentPathway(...a),
  markTaskComplete: vi.fn(),
}))

vi.mock('@learn/services/competencyService', () => ({
  getUserCompetencySummary: (...a: unknown[]) => mockGetUserCompetencySummary(...a),
  getUserWeaknesses: (...a: unknown[]) => mockGetUserWeaknesses(...a),
}))

vi.mock('@shared/db/models', () => ({
  InterviewSession: {
    findOne: (...a: unknown[]) => mockInterviewSessionFindOne(...a),
  },
  PathwayPlan: { find: (...a: unknown[]) => mockPathwayPlanFind(...a) },
  UserCompetencyState: { find: (...a: unknown[]) => mockUserCompetencyStateFind(...a) },
}))

vi.mock('@learn/services/pathwayViewModel', () => ({
  buildPathwayViewModel: (...a: unknown[]) => mockBuildPathwayViewModel(...a),
}))

vi.mock('@shared/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

import { GET } from '../../../app/api/learn/pathway/route'

function buildChain(result: unknown) {
  return {
    select: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(result),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockConnectDB.mockResolvedValue(undefined)
  mockGetCurrentPathway.mockResolvedValue(null)
  mockGetUserCompetencySummary.mockResolvedValue(null)
  mockGetUserWeaknesses.mockResolvedValue([])
  mockInterviewSessionFindOne.mockReturnValue(buildChain(null))
  mockPathwayPlanFind.mockReturnValue(buildChain([]))
  mockUserCompetencyStateFind.mockReturnValue(buildChain([]))
  mockBuildPathwayViewModel.mockReturnValue({
    state: 'empty',
    nextAction: { id: 'baseline', type: 'interview', title: '', description: '', ctaLabel: '' },
    planItems: [],
    progress: {
      readinessScore: 0,
      readinessLevel: null,
      completedTasks: 0,
      totalTasks: 0,
      achievedMilestones: 0,
      totalMilestones: 0,
      blockers: [],
      competencySummary: null,
      milestones: [],
      blockerInsights: {},
    },
    activity: { generatedFromSessionId: null, generatedAt: null, weaknessesCount: 0 },
    activityRhythm: { lastSessionAt: null, daysSinceLastSession: null, decayProfile: null },
  })
})

describe('GET /api/learn/pathway — Codex P1 resilience (Wave 4)', () => {
  it('returns 200 with degraded payload when connectDB throws during rhythm lookup', async () => {
    // First connectDB call (used by the rhythm try block) throws.
    // The previously-completed service fetchers should still surface.
    mockConnectDB.mockRejectedValueOnce(new Error('boom: cannot connect to Mongo'))

    const req = new NextRequest('http://localhost/api/learn/pathway')
    const res = await GET(req)
    expect(res.status).toBe(200)

    // Builder must have been called — meaning the handler did NOT abort
    expect(mockBuildPathwayViewModel).toHaveBeenCalledTimes(1)
    // And it must have received lastSessionAt: null (the graceful fallback)
    const args = mockBuildPathwayViewModel.mock.calls[0][0]
    expect(args.lastSessionAt).toBeNull()
  })

  it('returns 200 with degraded payload when InterviewSession.findOne throws', async () => {
    mockInterviewSessionFindOne.mockImplementation(() => {
      throw new Error('boom: mongo query failed')
    })

    const req = new NextRequest('http://localhost/api/learn/pathway')
    const res = await GET(req)
    expect(res.status).toBe(200)
    expect(mockBuildPathwayViewModel).toHaveBeenCalledTimes(1)
    expect(mockBuildPathwayViewModel.mock.calls[0][0].lastSessionAt).toBeNull()
  })

  it('returns 200 with degraded payload when the rhythm query rejects asynchronously', async () => {
    // The query chain itself rejects on .lean() — covers Mongoose's
    // typical "await fails" pattern.
    mockInterviewSessionFindOne.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      sort: vi.fn().mockReturnThis(),
      lean: vi.fn().mockRejectedValue(new Error('boom: lean failed')),
    })

    const req = new NextRequest('http://localhost/api/learn/pathway')
    const res = await GET(req)
    expect(res.status).toBe(200)
    expect(mockBuildPathwayViewModel).toHaveBeenCalledTimes(1)
    expect(mockBuildPathwayViewModel.mock.calls[0][0].lastSessionAt).toBeNull()
  })

  it('happy path: lastSessionAt flows through to the view model', async () => {
    const ts = new Date('2026-05-10T00:00:00Z')
    mockInterviewSessionFindOne.mockReturnValue(buildChain({ completedAt: ts }))

    const req = new NextRequest('http://localhost/api/learn/pathway')
    const res = await GET(req)
    expect(res.status).toBe(200)
    expect(mockBuildPathwayViewModel.mock.calls[0][0].lastSessionAt).toEqual(ts)
  })

  it('passes pathwayUpdate when fromFeedback session is loaded', async () => {
    const sessionId = '507f1f77bcf86cd799439011'
    mockInterviewSessionFindOne.mockReturnValue(
      buildChain({
        pathwayGenerationStatus: 'pending',
        completedAt: new Date(),
        answeredCount: 4,
        feedback: { overall_score: 65 },
        evaluations: [{}, {}, {}, {}],
      }),
    )

    const req = new NextRequest(
      `http://localhost/api/learn/pathway?fromFeedback=${sessionId}`,
    )
    const res = await GET(req)
    expect(res.status).toBe(200)
    const args = mockBuildPathwayViewModel.mock.calls[0][0]
    expect(args.fromFeedback).toBe(sessionId)
    expect(args.pathwayUpdate?.reason).toBe('pathway_in_flight')
    expect(args.pathwayUpdate?.poll).toBe(true)
  })

  it('polls when pathway uses synthesized feedback without persisted session.feedback', async () => {
    const sessionId = '507f1f77bcf86cd799439011'
    mockInterviewSessionFindOne.mockReturnValue(
      buildChain({
        pathwayGenerationStatus: 'pending',
        pathwayGenerationUseSynthesizedFeedback: true,
        completedAt: new Date(),
        answeredCount: 4,
        feedback: null,
        evaluations: [{}, {}, {}, {}],
      }),
    )

    const req = new NextRequest(
      `http://localhost/api/learn/pathway?fromFeedback=${sessionId}`,
    )
    const res = await GET(req)
    expect(res.status).toBe(200)
    const args = mockBuildPathwayViewModel.mock.calls[0][0]
    expect(args.pathwayUpdate?.reason).toBe('pathway_in_flight')
    expect(args.pathwayUpdate?.poll).toBe(true)
  })
})
