/**
 * Tests for /api/learn/pathway/lesson/[lessonId] route.
 *
 * Verifies 400/404 guards, that it validates lesson membership in the
 * user's universal plan, and forwards the result from getOrGenerateLesson.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import mongoose from 'mongoose'

const {
  mockGetUniversalPlan,
  mockGetOrGenerateLesson,
  mockEngagementCreate,
} = vi.hoisted(() => ({
  mockGetUniversalPlan: vi.fn(),
  mockGetOrGenerateLesson: vi.fn(),
  mockEngagementCreate: vi.fn().mockResolvedValue(undefined),
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

vi.mock('@learn/services/pathwayPlanner', () => ({
  getUniversalPlan: (...a: unknown[]) => mockGetUniversalPlan(...a),
}))

vi.mock('@learn/services/lessonGenerator', () => ({
  getOrGenerateLesson: (...a: unknown[]) => mockGetOrGenerateLesson(...a),
}))

vi.mock('@shared/db/models/LessonEngagement', () => ({
  LessonEngagement: {
    create: (...a: unknown[]) => mockEngagementCreate(...a),
  },
}))

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

import { GET } from '../../../app/api/learn/pathway/lesson/[lessonId]/route'

describe('/api/learn/pathway/lesson/[lessonId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('400 when lessonId param is missing', async () => {
    const req = new NextRequest('http://localhost/api/learn/pathway/lesson/')
    const res = await GET(req, { params: {} })
    expect(res.status).toBe(400)
  })

  it('404 when user has no universal plan', async () => {
    mockGetUniversalPlan.mockResolvedValue(null)
    const req = new NextRequest('http://localhost/api/learn/pathway/lesson/L1')
    const res = await GET(req, { params: { lessonId: 'L1' } })
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toBe('No universal plan')
  })

  it('404 when lesson is not in plan', async () => {
    mockGetUniversalPlan.mockResolvedValue({
      lessons: [{ lessonId: 'other', competency: 'x', completed: false }],
    })
    const req = new NextRequest('http://localhost/api/learn/pathway/lesson/L1')
    const res = await GET(req, { params: { lessonId: 'L1' } })
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toBe('Lesson not in plan')
  })

  it('502 when lesson generation fails', async () => {
    mockGetUniversalPlan.mockResolvedValue({
      lessons: [{ lessonId: 'L1', competency: 'structure', completed: false }],
    })
    mockGetOrGenerateLesson.mockResolvedValue(null)
    const req = new NextRequest('http://localhost/api/learn/pathway/lesson/L1')
    const res = await GET(req, { params: { lessonId: 'L1' } })
    expect(res.status).toBe(502)
  })

  it('returns lesson data and records engagement on success', async () => {
    mockGetUniversalPlan.mockResolvedValue({
      lessons: [{ lessonId: 'L1', competency: 'structure', completed: true }],
    })
    const objectId = new mongoose.Types.ObjectId()
    mockGetOrGenerateLesson.mockResolvedValue({
      _id: objectId,
      title: 'STAR structure',
      conceptSummary: 'Situation, Task, Action, Result.',
      conceptDeepDive: 'Deep dive text',
      example: { question: 'Q', goodAnswer: 'A', annotations: ['note'] },
      keyTakeaways: ['Always close with Result'],
    })

    const req = new NextRequest('http://localhost/api/learn/pathway/lesson/L1?domain=pm&depth=behavioral')
    const res = await GET(req, { params: { lessonId: 'L1' } })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.lesson.title).toBe('STAR structure')
    expect(json.lesson.lessonId).toBe('L1')
    expect(json.completed).toBe(true)

    expect(mockGetOrGenerateLesson).toHaveBeenCalledWith({
      competency: 'structure',
      domain: 'pm',
      depth: 'behavioral',
    })
    // fire-and-forget engagement write; wait a microtask for the .catch chain
    await new Promise((r) => setTimeout(r, 0))
    expect(mockEngagementCreate).toHaveBeenCalledOnce()
  })

  it('uses default domain/depth when not provided', async () => {
    mockGetUniversalPlan.mockResolvedValue({
      lessons: [{ lessonId: 'L1', competency: 'ownership', completed: false }],
    })
    mockGetOrGenerateLesson.mockResolvedValue({
      _id: new mongoose.Types.ObjectId(),
      title: 't', conceptSummary: 's', conceptDeepDive: '', example: { question: '', goodAnswer: '', annotations: [] }, keyTakeaways: [],
    })
    const req = new NextRequest('http://localhost/api/learn/pathway/lesson/L1')
    await GET(req, { params: { lessonId: 'L1' } })
    expect(mockGetOrGenerateLesson).toHaveBeenCalledWith({
      competency: 'ownership',
      domain: 'general',
      depth: 'behavioral',
    })
  })
})
