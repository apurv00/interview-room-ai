import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FALLBACK_CATEGORIES } from '@shared/db/seed'

const mockLean = vi.fn()
const mockConnectDB = vi.fn()

vi.mock('@shared/db/connection', () => ({
  connectDB: (...a: unknown[]) => mockConnectDB(...a),
}))

// find(...).sort(...).select(...).lean()
vi.mock('@shared/db/models', () => ({
  Category: {
    find: () => ({ sort: () => ({ select: () => ({ lean: (...a: unknown[]) => mockLean(...a) }) }) }),
  },
}))

import { GET } from './route'

beforeEach(() => {
  vi.clearAllMocks()
  mockConnectDB.mockResolvedValue(undefined)
})

describe('GET /api/categories', () => {
  it('returns active categories from the DB when present', async () => {
    mockLean.mockResolvedValue([
      { slug: 'programming', label: 'Programming', icon: '💻', description: 'Software', sortOrder: 1 },
      { slug: 'data-ai', label: 'Data & AI', icon: '📊', description: 'Data', sortOrder: 2 },
    ])
    const res = await GET()
    const body = await res.json()
    expect(body.map((c: { slug: string }) => c.slug)).toEqual(['programming', 'data-ai'])
  })

  it('falls back to the seed categories when the DB is unavailable', async () => {
    mockLean.mockRejectedValue(new Error('db down'))
    const res = await GET()
    const body = await res.json()
    expect(body.length).toBe(FALLBACK_CATEGORIES.length)
    expect(body.map((c: { slug: string }) => c.slug)).toContain('core-engineering')
  })

  it('falls back to the seed categories when the DB is empty (unseeded)', async () => {
    mockLean.mockResolvedValue([])
    const res = await GET()
    const body = await res.json()
    expect(body.length).toBe(FALLBACK_CATEGORIES.length)
  })
})
