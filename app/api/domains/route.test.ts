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

  it('derives categorySlug on the DB path when docs predate the seed backfill', async () => {
    // Deploy-before-seed race: DB has every slug (hasAll passes) but the docs
    // have no categorySlug yet. Response must still carry a derived value.
    mockLean.mockResolvedValue(
      FALLBACK_DOMAINS.map((d) => ({
        slug: d.slug, label: d.label, shortLabel: d.shortLabel, icon: d.icon,
        description: d.description, color: d.color, category: d.category,
        // categorySlug intentionally omitted
      })),
    )
    const res = await GET()
    const body = await res.json()
    const fe = body.find((d: { slug: string }) => d.slug === 'frontend')
    expect(fe.categorySlug).toBe('programming') // derived by slug, not undefined
    for (const d of body) expect(d.categorySlug).toBeTruthy()
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
