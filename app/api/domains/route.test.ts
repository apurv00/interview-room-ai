import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FALLBACK_DOMAINS, FALLBACK_CATEGORIES } from '@shared/db/seed'

const mockLean = vi.fn()
const mockCatLean = vi.fn()
const mockConnectDB = vi.fn()

vi.mock('@shared/db/connection', () => ({
  connectDB: (...a: unknown[]) => mockConnectDB(...a),
}))

// InterviewDomain: find().sort().select().lean()   Category: find().select().lean()
vi.mock('@shared/db/models', () => ({
  InterviewDomain: {
    find: () => ({ sort: () => ({ select: () => ({ lean: (...a: unknown[]) => mockLean(...a) }) }) }),
  },
  Category: {
    find: () => ({ select: () => ({ lean: (...a: unknown[]) => mockCatLean(...a) }) }),
  },
}))

import { GET } from './route'

beforeEach(() => {
  vi.clearAllMocks()
  mockConnectDB.mockResolvedValue(undefined)
  // Default: the live Category set is the seven seeded categories.
  mockCatLean.mockResolvedValue(FALLBACK_CATEGORIES.map((c) => ({ slug: c.slug })))
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

  it('returns CMS-added domains that are not in the seed (de-gated in Phase 1)', async () => {
    // Pre-Phase-1 the ACTIVE_DOMAIN_SLUGS whitelist dropped any non-seed slug,
    // so this domain would never have reached the client. Now the DB is the
    // source of truth and it appears.
    mockLean.mockResolvedValue([
      {
        slug: 'mechanical', label: 'Mechanical Engineer', shortLabel: 'ME', icon: '⚙️',
        description: 'Thermodynamics, CAD, manufacturing.', color: 'indigo',
        category: 'core-engineering', categorySlug: 'core-engineering',
      },
    ])
    const res = await GET()
    const body = await res.json()
    expect(body.map((d: { slug: string }) => d.slug)).toContain('mechanical')
    expect(body.find((d: { slug: string }) => d.slug === 'mechanical').categorySlug).toBe('core-engineering')
  })

  it('honors a custom (admin-created) categorySlug present in the live Category set', async () => {
    // Codex P2: validation must be against the live Category collection, not a
    // hardcoded list — a valid DB-backed custom category must pass through.
    mockCatLean.mockResolvedValue([
      ...FALLBACK_CATEGORIES.map((c) => ({ slug: c.slug })),
      { slug: 'renewable-energy' },
    ])
    mockLean.mockResolvedValue([
      { slug: 'solar-engineer', label: 'Solar Engineer', shortLabel: 'SOL', icon: '☀️',
        description: 'PV systems.', color: 'indigo', category: 'engineering', categorySlug: 'renewable-energy' },
    ])
    const res = await GET()
    const body = await res.json()
    expect(body.find((d: { slug: string }) => d.slug === 'solar-engineer').categorySlug).toBe('renewable-energy')
  })

  it('rejects a categorySlug that is NOT in the live Category set', async () => {
    // Same domain, but the custom category is not (or no longer) active → the
    // resolver must not emit it; falls through to legacy/general.
    mockCatLean.mockResolvedValue(FALLBACK_CATEGORIES.map((c) => ({ slug: c.slug })))
    mockLean.mockResolvedValue([
      { slug: 'solar-engineer', label: 'Solar Engineer', shortLabel: 'SOL', icon: '☀️',
        description: 'PV systems.', color: 'indigo', category: 'engineering', categorySlug: 'renewable-energy' },
    ])
    const res = await GET()
    const body = await res.json()
    // categorySlug 'renewable-energy' not in set → ignored → legacy 'engineering' → 'programming'
    expect(body.find((d: { slug: string }) => d.slug === 'solar-engineer').categorySlug).toBe('programming')
  })

  it('buckets a CMS domain with only a legacy category (no categorySlug) via the legacy map', async () => {
    // Codex P2: a CMS role written through the old path has `category` but no
    // `categorySlug`. It must bucket by the legacy category, not flat 'general'.
    mockLean.mockResolvedValue([
      {
        slug: 'consulting', label: 'Strategy Consultant', shortLabel: 'CON', icon: '📈',
        description: 'Case interviews.', color: 'indigo', category: 'business',
        // categorySlug intentionally omitted (legacy CMS write)
      },
    ])
    const res = await GET()
    const body = await res.json()
    expect(body.find((d: { slug: string }) => d.slug === 'consulting').categorySlug).toBe('business')
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
