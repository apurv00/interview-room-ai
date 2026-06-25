import { describe, it, expect, vi } from 'vitest'

// Force the fallback path so the test exercises the REAL seed data
// (FALLBACK_DEPTHS + FALLBACK_DOMAINS) and the category-aware filter end to end.
vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockRejectedValue(new Error('no db')) }))

import { GET } from '../route'

const slugsFor = async (domain?: string, experience?: string): Promise<string[]> => {
  const params = new URLSearchParams()
  if (domain) params.set('domain', domain)
  if (experience) params.set('experience', experience)
  const qs = params.toString()
  const url = `http://localhost/api/interview-types${qs ? `?${qs}` : ''}`
  const res = await GET(new Request(url))
  const data = await res.json()
  return data.map((d: { slug: string }) => d.slug)
}

describe('GET /api/interview-types — category-aware depth filtering', () => {
  it('Programming roles inherit coding + system-design via category (not by per-slug list)', async () => {
    const slugs = await slugsFor('fullstack') // categorySlug: programming, NOT in any depth applicableDomains
    expect(slugs).toContain('behavioral')
    expect(slugs).toContain('coding')
    expect(slugs).toContain('system-design')
  })

  it('Core Engineering roles get behavioral + technical but NOT coding/case-study', async () => {
    const slugs = await slugsFor('mechanical') // categorySlug: core-engineering
    expect(slugs).toContain('behavioral')
    expect(slugs).toContain('technical')
    expect(slugs).not.toContain('coding')
    expect(slugs).not.toContain('case-study')
  })

  it('Business roles inherit case-study via category', async () => {
    const slugs = await slugsFor('finance') // categorySlug: business
    expect(slugs).toContain('case-study')
    expect(slugs).not.toContain('coding')
  })

  it('no domain → all depths', async () => {
    const slugs = await slugsFor()
    expect(slugs).toEqual(expect.arrayContaining(['behavioral', 'technical', 'case-study', 'system-design', 'coding']))
  })
})

describe('GET /api/interview-types — experience gating (academics → 0-2 only)', () => {
  it('shows academics for a 0-2 fresher in an applicable category', async () => {
    expect(await slugsFor('backend', '0-2')).toContain('academics')
  })

  it('hides academics for 3-6 / 7+ experience', async () => {
    expect(await slugsFor('backend', '3-6')).not.toContain('academics')
    expect(await slugsFor('backend', '7+')).not.toContain('academics')
  })

  it('hides academics when no experience is provided (a gated depth defaults to hidden)', async () => {
    expect(await slugsFor('backend')).not.toContain('academics')
  })

  it('gates academics the same way across all applicable categories', async () => {
    expect(await slugsFor('mechanical', '0-2')).toContain('academics') // core-engineering
    expect(await slugsFor('finance', '0-2')).toContain('academics')    // business
    expect(await slugsFor('data-analyst', '0-2')).toContain('academics') // data-ai
    expect(await slugsFor('mechanical', '3-6')).not.toContain('academics')
  })

  it('never offers academics to non-applicable categories, even at 0-2', async () => {
    expect(await slugsFor('pm', '0-2')).not.toContain('academics')      // product
    expect(await slugsFor('design', '0-2')).not.toContain('academics')  // design
  })
})
