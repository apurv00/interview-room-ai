import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FALLBACK_DOMAINS } from '@shared/db/seed'

const mockLean = vi.fn()
const mockConnectDB = vi.fn()

vi.mock('@shared/db/connection', () => ({
  connectDB: (...a: unknown[]) => mockConnectDB(...a),
}))

// find(...).sort(...).select(...).lean()
vi.mock('@shared/db/models', () => ({
  InterviewDomain: {
    find: () => ({ sort: () => ({ select: () => ({ lean: (...a: unknown[]) => mockLean(...a) }) }) }),
  },
}))

import { GET } from './route'

beforeEach(() => {
  vi.clearAllMocks()
  mockConnectDB.mockResolvedValue(undefined)
})

describe('GET /api/domains — categorySlug contract', () => {
  it('includes categorySlug on the DB path (all seeded slugs present)', async () => {
    // DB returns every fallback slug (satisfies the hasAll gate), each with categorySlug.
    mockLean.mockResolvedValue(
      FALLBACK_DOMAINS.map((d) => ({
        slug: d.slug, label: d.label, shortLabel: d.shortLabel, icon: d.icon,
        description: d.description, color: d.color, category: d.category,
        categorySlug: d.categorySlug,
      })),
    )
    const res = await GET()
    const body = await res.json()
    expect(body.length).toBeGreaterThan(0)
    for (const d of body) {
      expect(d.categorySlug, `${d.slug} exposes categorySlug on DB path`).toBeTruthy()
    }
  })

  it('includes categorySlug on the fallback path (DB error)', async () => {
    mockLean.mockRejectedValue(new Error('db down'))
    const res = await GET()
    const body = await res.json()
    expect(body.length).toBe(FALLBACK_DOMAINS.length)
    for (const d of body) {
      expect(d.categorySlug, `${d.slug} exposes categorySlug on fallback path`).toBeTruthy()
      expect(d.systemPromptContext, 'internal field stripped from fallback').toBeUndefined()
    }
  })
})
