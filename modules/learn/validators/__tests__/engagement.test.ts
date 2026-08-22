import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockGetServerSession,
  mockSubmitChallengeAnswer,
  mockAwardXp,
  mockRecordActivity,
  mockUpdateStreak,
  mockCheckAndAwardBadges,
  mockMarkBadgeNotified,
  mockInvalidateBadges,
  mockGetXpHistory,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockSubmitChallengeAnswer: vi.fn(),
  mockAwardXp: vi.fn(),
  mockRecordActivity: vi.fn(),
  mockUpdateStreak: vi.fn(),
  mockCheckAndAwardBadges: vi.fn(),
  mockMarkBadgeNotified: vi.fn(),
  mockInvalidateBadges: vi.fn(),
  mockGetXpHistory: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@learn/services/dailyChallengeService', () => ({
  getTodaysChallenge: vi.fn(),
  hasUserCompletedToday: vi.fn(),
  submitChallengeAnswer: mockSubmitChallengeAnswer,
}))
vi.mock('@learn/services/xpService', () => ({
  awardXp: mockAwardXp,
  getXpHistory: mockGetXpHistory,
}))
vi.mock('@learn/services/streakService', () => ({
  recordActivity: mockRecordActivity,
  updateStreak: mockUpdateStreak,
}))
vi.mock('@learn/services/badgeService', () => ({
  checkAndAwardBadges: mockCheckAndAwardBadges,
  markBadgeNotified: mockMarkBadgeNotified,
}))
vi.mock('@learn/services/badgeCacheUtils', () => ({
  invalidateUnnotifiedBadgesCache: mockInvalidateBadges,
}))

import { POST as submitDailyChallenge } from '@/app/api/learn/daily-challenge/route'
import { POST as notifyBadge } from '@/app/api/learn/badges/notify/route'
import { GET as getXpHistory } from '@/app/api/learn/xp/history/route'

const USER_ID = '507f1f77bcf86cd799439010'
const postJson = (url: string, body: unknown) => new Request(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

beforeEach(() => {
  vi.clearAllMocks()
  mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
  mockSubmitChallengeAnswer.mockResolvedValue({ percentile: 50, score: 72 })
  mockAwardXp.mockResolvedValue(undefined)
  mockRecordActivity.mockResolvedValue(undefined)
  mockUpdateStreak.mockResolvedValue({ currentStreak: 1 })
  mockCheckAndAwardBadges.mockResolvedValue(undefined)
  mockMarkBadgeNotified.mockResolvedValue(undefined)
  mockInvalidateBadges.mockResolvedValue(undefined)
  mockGetXpHistory.mockResolvedValue([])
})

describe('engagement route validation', () => {
  describe('POST /api/learn/daily-challenge', () => {
    it.each([
      ['short answers', { answer: 'short' }, 'Answer must be at least 10 characters'],
      ['non-string answers', { answer: 42 }, 'Answer must be at least 10 characters'],
      ['answers over 5000 characters', { answer: 'A'.repeat(5001) }, 'Answer must be at most 5000 characters'],
    ])('rejects %s before submission', async (_label, body, error) => {
      const response = await submitDailyChallenge(postJson(
        'http://localhost/api/learn/daily-challenge',
        body,
      ))

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({ error })
      expect(mockSubmitChallengeAnswer).not.toHaveBeenCalled()
    })

    it.each([10, 5000])('accepts the %i-character boundary', async (length) => {
      const answer = 'A'.repeat(length)
      const response = await submitDailyChallenge(postJson(
        'http://localhost/api/learn/daily-challenge',
        { answer },
      ))

      expect(response.status).toBe(200)
      expect(mockSubmitChallengeAnswer).toHaveBeenCalledWith(
        USER_ID,
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        answer,
      )
    })
  })

  describe('POST /api/learn/badges/notify', () => {
    it.each([
      ['empty ids', { badgeId: '' }, 'Missing badgeId'],
      ['non-string ids', { badgeId: 42 }, 'Missing badgeId'],
      ['ids over 50 characters', { badgeId: 'x'.repeat(51) }, 'badgeId must be at most 50 characters'],
    ])('rejects %s before persistence', async (_label, body, error) => {
      const response = await notifyBadge(postJson(
        'http://localhost/api/learn/badges/notify',
        body,
      ))

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({ error })
      expect(mockMarkBadgeNotified).not.toHaveBeenCalled()
    })

    it.each([1, 50])('accepts the %i-character boundary', async (length) => {
      const badgeId = 'x'.repeat(length)
      const response = await notifyBadge(postJson(
        'http://localhost/api/learn/badges/notify',
        { badgeId },
      ))

      expect(response.status).toBe(200)
      expect(mockMarkBadgeNotified).toHaveBeenCalledWith(USER_ID, badgeId)
    })
  })

  describe('GET /api/learn/xp/history', () => {
    it.each(['0', '1.5', '101', 'invalid'])('rejects limit=%s before lookup', async (limit) => {
      const response = await getXpHistory(new Request(
        `http://localhost/api/learn/xp/history?limit=${limit}`,
      ))

      expect(response.status).toBe(400)
      expect(mockGetXpHistory).not.toHaveBeenCalled()
    })

    it.each([
      ['the default', '', 20],
      ['an empty query value', '?limit=', 20],
      ['the minimum', '?limit=1', 1],
      ['a string query value', '?limit=50', 50],
      ['the maximum', '?limit=100', 100],
    ])('uses %s limit', async (_label, query, expectedLimit) => {
      const response = await getXpHistory(new Request(
        `http://localhost/api/learn/xp/history${query}`,
      ))

      expect(response.status).toBe(200)
      expect(mockGetXpHistory).toHaveBeenCalledWith(USER_ID, expectedLimit)
    })
  })
})
