import { describe, it, expect, vi } from 'vitest'

// Force the fallback path so the test exercises the REAL seed data
// (FALLBACK_DEPTHS + FALLBACK_DOMAINS) and the category-aware filter end to end.
vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockRejectedValue(new Error('no db')) }))

import { GET } from '../route'

const slugsFor = async (domain?: string): Promise<string[]> => {
  const url = `http://localhost/api/interview-types${domain ? `?domain=${domain}` : ''}`
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
