/**
 * Contract tests for GET /api/learn/drill/history.
 *
 * Pathway P2 Wave 5 (5C). Thin wrapper over `getDrillHistory`; tests
 * lock that the competency filter is forwarded and the limit is
 * clamped so a forged `?limit=99999` can't drag a giant payload.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import mongoose from 'mongoose'

const { mockGetServerSession, mockGetDrillHistory } = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockGetDrillHistory: vi.fn(),
}))

vi.mock('next-auth', () => ({
  getServerSession: (...a: unknown[]) => mockGetServerSession(...a),
}))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@learn/services/drillService', () => ({
  getDrillHistory: (...a: unknown[]) => mockGetDrillHistory(...a),
}))
vi.mock('@shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { GET } from '../route'

const USER_ID = new mongoose.Types.ObjectId().toString()

beforeEach(() => {
  mockGetServerSession.mockReset()
  mockGetDrillHistory.mockReset()
  mockGetDrillHistory.mockResolvedValue([])
})

describe('GET /api/learn/drill/history', () => {
  it('401 when unauthenticated', async () => {
    mockGetServerSession.mockResolvedValue(null)
    const req = new NextRequest('http://localhost/api/learn/drill/history')
    const res = await GET(req)
    expect(res.status).toBe(401)
  })

  it('forwards the competency filter to getDrillHistory', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    const req = new NextRequest(
      'http://localhost/api/learn/drill/history?competency=relevance',
    )
    await GET(req)
    expect(mockGetDrillHistory).toHaveBeenCalledWith(USER_ID, 20, 'relevance')
  })

  it('uses default limit of 20 when none provided', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    await GET(new NextRequest('http://localhost/api/learn/drill/history'))
    const args = mockGetDrillHistory.mock.calls[0]
    expect(args[1]).toBe(20)
    expect(args[2]).toBeUndefined()
  })

  it('caps limit at 50 even if a larger value is requested', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    await GET(new NextRequest('http://localhost/api/learn/drill/history?limit=999'))
    expect(mockGetDrillHistory.mock.calls[0][1]).toBe(50)
  })

  it('falls back to default for non-numeric or non-positive limit', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    await GET(new NextRequest('http://localhost/api/learn/drill/history?limit=abc'))
    expect(mockGetDrillHistory.mock.calls[0][1]).toBe(20)
    mockGetDrillHistory.mockClear()
    await GET(new NextRequest('http://localhost/api/learn/drill/history?limit=-5'))
    expect(mockGetDrillHistory.mock.calls[0][1]).toBe(20)
  })

  it('returns { attempts: [] } on service error rather than 500', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    mockGetDrillHistory.mockRejectedValue(new Error('boom'))
    const res = await GET(new NextRequest('http://localhost/api/learn/drill/history'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ attempts: [] })
  })
})
