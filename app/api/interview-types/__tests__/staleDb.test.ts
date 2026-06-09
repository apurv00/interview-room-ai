import { describe, it, expect, vi } from 'vitest'

// Migration window: Mongo is REACHABLE and has the pre-migration 5 depth rows
// (no applicableCategories), but the new role docs aren't seeded yet.
const OLD_DEPTHS = [
  { slug: 'behavioral', label: 'Behavioral', icon: '🧠', description: '', applicableDomains: [] },
  { slug: 'technical', label: 'Technical', icon: '⚙️', description: '', applicableDomains: [] },
  { slug: 'case-study', label: 'Case Study', icon: '📋', description: '', applicableDomains: ['pm', 'business', 'data-science', 'design', 'general'] },
  { slug: 'system-design', label: 'System Design', icon: '🏗️', description: '', applicableDomains: ['backend', 'frontend', 'data-science', 'sdet', 'general'] },
  { slug: 'coding', label: 'Coding', icon: '💻', description: '', applicableDomains: ['backend', 'frontend', 'data-science', 'sdet'] },
]

vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@shared/db/models', () => ({
  InterviewDepth: { find: () => ({ sort: () => ({ select: () => ({ lean: () => Promise.resolve(OLD_DEPTHS) }) }) }) },
  // role not seeded yet → findOne resolves null
  InterviewDomain: { findOne: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }) },
}))

import { GET } from '../route'

const slugsFor = async (domain: string): Promise<string[]> => {
  const res = await GET(new Request(`http://localhost/api/interview-types?domain=${domain}`))
  return (await res.json()).map((d: { slug: string }) => d.slug)
}

describe('GET /api/interview-types — pre-migration DB is treated as stale', () => {
  it('fullstack still inherits coding/system-design (falls back to seeded depths)', async () => {
    const slugs = await slugsFor('fullstack')
    expect(slugs).toContain('coding')
    expect(slugs).toContain('system-design')
  })

  it('mechanical still gets behavioral+technical but not coding', async () => {
    const slugs = await slugsFor('mechanical')
    expect(slugs).toContain('behavioral')
    expect(slugs).toContain('technical')
    expect(slugs).not.toContain('coding')
  })
})
