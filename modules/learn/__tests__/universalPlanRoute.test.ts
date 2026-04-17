/**
 * Tests for /api/learn/pathway/universal route handlers.
 *
 * Mocks composeApiRoute to inject a test user, stubs the pathwayPlanner
 * service to avoid DB/LLM, and asserts each verb's response shape +
 * error branches.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const {
  mockGetUniversalPlan,
  mockGenerateUniversalPlan,
  mockMarkLessonComplete,
} = vi.hoisted(() => ({
  mockGetUniversalPlan: vi.fn(),
  mockGenerateUniversalPlan: vi.fn(),
  mockMarkLessonComplete: vi.fn(),
}))

vi.mock('@shared/middleware/composeApiRoute', () => ({
  composeApiRoute: (opts: {
    schema?: { parse: (x: unknown) => unknown }
    handler: (
      req: NextRequest,
      ctx: { user: unknown; body: unknown; params: Record<string, string> },
    ) => Promise<Response>
  }) => async (req: NextRequest) => {
    const isBodyMethod = req.method === 'POST' || req.method === 'PATCH'
    const raw = isBodyMethod ? await req.json() : undefined
    const body = opts.schema ? opts.schema.parse(raw) : raw
    return opts.handler(req, {
      user: { id: 'u-test', role: 'candidate', plan: 'free' },
      body,
      params: {},
    })
  },
}))

vi.mock('@learn/services/pathwayPlanner', () => ({
  getUniversalPlan: (...a: unknown[]) => mockGetUniversalPlan(...a),
  generateUniversalPlan: (...a: unknown[]) => mockGenerateUniversalPlan(...a),
  markLessonComplete: (...a: unknown[]) => mockMarkLessonComplete(...a),
}))

vi.mock('@shared/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

import { GET, POST, PATCH } from '../../../app/api/learn/pathway/universal/route'

describe('/api/learn/pathway/universal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('GET', () => {
    it('returns null plan + null phaseStatus when no plan exists', async () => {
      mockGetUniversalPlan.mockResolvedValue(null)
      const req = new NextRequest('http://localhost/api/learn/pathway/universal')
      const res = await GET(req)
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json).toEqual({ plan: null, phaseStatus: null })
    })

    it('returns plan with computed phaseStatus when plan exists', async () => {
      mockGetUniversalPlan.mockResolvedValue({
        _id: 'p1',
        sessionsCompleted: 8,
        phaseThresholds: undefined,
      })
      const req = new NextRequest('http://localhost/api/learn/pathway/universal')
      const res = await GET(req)
      const json = await res.json()
      expect(json.plan._id).toBe('p1')
      expect(json.phaseStatus).toBeTruthy()
      expect(json.phaseStatus.sessionsCompleted).toBe(8)
      expect(json.phaseStatus.currentPhase).toBe('building')
    })
  })

  describe('POST', () => {
    it('generates a plan and returns phaseStatus', async () => {
      mockGenerateUniversalPlan.mockResolvedValue({
        _id: 'p2',
        sessionsCompleted: 0,
      })
      const req = new NextRequest('http://localhost/api/learn/pathway/universal', {
        method: 'POST',
        body: JSON.stringify({ domain: 'pm', depth: 'behavioral' }),
      })
      const res = await POST(req)
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.plan._id).toBe('p2')
      expect(json.phaseStatus.currentPhase).toBe('assessment')
      expect(mockGenerateUniversalPlan).toHaveBeenCalledWith({
        userId: 'u-test',
        domain: 'pm',
        depth: 'behavioral',
        targetRole: undefined,
      })
    })

    it('returns 500 when generation fails', async () => {
      mockGenerateUniversalPlan.mockResolvedValue(null)
      const req = new NextRequest('http://localhost/api/learn/pathway/universal', {
        method: 'POST',
        body: JSON.stringify({ domain: 'pm', depth: 'behavioral' }),
      })
      const res = await POST(req)
      expect(res.status).toBe(500)
    })
  })

  describe('PATCH', () => {
    it('returns success when lesson is marked complete', async () => {
      mockMarkLessonComplete.mockResolvedValue(true)
      const req = new NextRequest('http://localhost/api/learn/pathway/universal', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'complete_lesson', lessonId: 'L1' }),
      })
      const res = await PATCH(req)
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.success).toBe(true)
      expect(mockMarkLessonComplete).toHaveBeenCalledWith('u-test', 'L1')
    })

    it('returns 404 when lesson is not in plan', async () => {
      mockMarkLessonComplete.mockResolvedValue(false)
      const req = new NextRequest('http://localhost/api/learn/pathway/universal', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'complete_lesson', lessonId: 'missing' }),
      })
      const res = await PATCH(req)
      expect(res.status).toBe(404)
    })
  })
})
