import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockGetCurrentPathway = vi.fn()
const mockGetUserCompetencySummary = vi.fn()
const mockBuildPathwayViewModel = vi.fn()
const mockConnectDB = vi.fn()
const mockLean = vi.fn()

vi.mock('@shared/db/connection', () => ({
  connectDB: (...a: unknown[]) => mockConnectDB(...a),
}))

// Chainable query stub: findOne(...).select(...).sort(...).lean()
vi.mock('@shared/db/models', () => ({
  InterviewSession: {
    findOne: () => ({
      select: () => ({
        sort: () => ({
          lean: (...a: unknown[]) => mockLean(...a),
        }),
      }),
    }),
  },
}))

vi.mock('@learn/services/pathwayPlanner', () => ({
  getCurrentPathway: (...a: unknown[]) => mockGetCurrentPathway(...a),
}))

vi.mock('@learn/services/competencyService', () => ({
  getUserCompetencySummary: (...a: unknown[]) => mockGetUserCompetencySummary(...a),
}))

vi.mock('@learn/services/pathwayViewModel', () => ({
  buildPathwayViewModel: (...a: unknown[]) => mockBuildPathwayViewModel(...a),
}))

import {
  resolvePathwayNextHref,
  DEFAULT_NEXT_HREF,
} from '../services/resolvePathwayNextHref'

const USER = '507f1f77bcf86cd799439011'

beforeEach(() => {
  vi.clearAllMocks()
  mockGetCurrentPathway.mockResolvedValue(null)
  mockGetUserCompetencySummary.mockResolvedValue(null)
  mockConnectDB.mockResolvedValue(undefined)
  mockLean.mockResolvedValue(null)
  mockBuildPathwayViewModel.mockReturnValue({ nextAction: { href: '/interview/setup?source=pathway' } })
})

describe('resolvePathwayNextHref', () => {
  it('returns the view model nextAction.href', async () => {
    mockBuildPathwayViewModel.mockReturnValue({ nextAction: { href: '/learn/pathway/lesson/2' } })
    await expect(resolvePathwayNextHref(USER)).resolves.toBe('/learn/pathway/lesson/2')
  })

  it('falls back to DEFAULT_NEXT_HREF when nextAction has no href', async () => {
    mockBuildPathwayViewModel.mockReturnValue({ nextAction: { ctaLabel: 'Start' } })
    await expect(resolvePathwayNextHref(USER)).resolves.toBe(DEFAULT_NEXT_HREF)
  })

  it('falls back to DEFAULT_NEXT_HREF when a core service throws (outer catch)', async () => {
    mockGetCurrentPathway.mockRejectedValue(new Error('mongo down'))
    await expect(resolvePathwayNextHref(USER)).resolves.toBe(DEFAULT_NEXT_HREF)
  })

  it('still resolves when the last-session lookup throws (inner catch), passing null last-session fields', async () => {
    mockLean.mockRejectedValue(new Error('query failed'))
    mockBuildPathwayViewModel.mockReturnValue({ nextAction: { href: '/interview/setup?actionId=baseline' } })

    await expect(resolvePathwayNextHref(USER)).resolves.toBe('/interview/setup?actionId=baseline')
    expect(mockBuildPathwayViewModel).toHaveBeenCalledWith(
      expect.objectContaining({
        lastSessionAt: null,
        lastSessionId: null,
        lastSessionPathwayStatus: null,
      }),
    )
  })

  it('threads the resolved last completed session into the view model', async () => {
    const completedAt = new Date('2026-06-01T00:00:00.000Z')
    mockLean.mockResolvedValue({
      _id: { toString: () => 'sess-9' },
      completedAt,
      pathwayGenerationStatus: 'completed',
    })

    await resolvePathwayNextHref(USER)

    expect(mockBuildPathwayViewModel).toHaveBeenCalledWith(
      expect.objectContaining({
        lastSessionAt: completedAt,
        lastSessionId: 'sess-9',
        lastSessionPathwayStatus: 'completed',
        // insight queries are intentionally skipped for the CTA path
        weaknesses: [],
        fromFeedback: null,
      }),
    )
  })
})
