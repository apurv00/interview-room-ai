import { describe, it, expect, vi } from 'vitest'

const { mockFetchJSON } = vi.hoisted(() => ({ mockFetchJSON: vi.fn() }))
vi.mock('@shared/fetchJSONWithRetry', () => ({ fetchJSONWithRetry: mockFetchJSON }))

import { atsBoardAdapter } from '../adapters/atsBoardAdapter'
import type { FetchTarget } from '../adapters/types'

const ghTarget: FetchTarget = { kind: 'board', boardId: 'gh:phonepe', slug: 'phonepe', atsKind: 'greenhouse' }
const leverTarget: FetchTarget = { kind: 'board', boardId: 'lever:meesho', slug: 'meesho', atsKind: 'lever' }
const srTarget: FetchTarget = { kind: 'board', boardId: 'sr:boschgroup', slug: 'BoschGroup', atsKind: 'smartrecruiters' }

describe('atsBoardAdapter.buildTargets', () => {
  it('one board target per configured row; nothing without slug/atsKind or when disabled', () => {
    expect(atsBoardAdapter.buildTargets({ sourceId: 'gh:phonepe', enabled: true, slug: 'phonepe', atsKind: 'greenhouse' }, [])).toHaveLength(1)
    expect(atsBoardAdapter.buildTargets({ sourceId: 'gh:phonepe', enabled: false, slug: 'phonepe', atsKind: 'greenhouse' }, [])).toEqual([])
    expect(atsBoardAdapter.buildTargets({ sourceId: 'gh:phonepe', enabled: true }, [])).toEqual([])
  })
})

describe('atsBoardAdapter.fetch — India scoping is policy, not drift', () => {
  it('greenhouse: non-India rows are excluded at fetch; India rows tagged with kind', async () => {
    mockFetchJSON.mockResolvedValueOnce({
      ok: true, status: 200,
      data: { jobs: [
        { id: 1, title: 'SDE', location: { name: 'Bengaluru, India' }, content: 'x', absolute_url: 'https://boards.greenhouse.io/phonepe/jobs/1' },
        { id: 2, title: 'SDE', location: { name: 'New York, USA' }, content: 'x', absolute_url: 'https://boards.greenhouse.io/phonepe/jobs/2' },
      ] },
    })
    const res = await atsBoardAdapter.fetch(ghTarget)
    expect(res.ok).toBe(true)
    expect(res.raw).toHaveLength(1)
  })

  it('an unexpected envelope is bodyError (drift-class), not zero supply', async () => {
    mockFetchJSON.mockResolvedValueOnce({ ok: true, status: 200, data: { unexpected: true } })
    const res = await atsBoardAdapter.fetch(ghTarget)
    expect(res.ok).toBe(false)
    expect(res.bodyError).toBe(true)
  })
})

describe('atsBoardAdapter.normalize per platform', () => {
  it('greenhouse rows map with stable externalId and direct apply', () => {
    const n = atsBoardAdapter.normalize(
      { kind: 'greenhouse', raw: { id: 123, title: 'Backend Engineer', location: { name: 'Pune, India' }, content: '<p>Build things</p>', absolute_url: 'https://boards.greenhouse.io/phonepe/jobs/123', updated_at: '2026-07-10T00:00:00Z' } },
      ghTarget
    )
    expect(n).toMatchObject({
      title: 'Backend Engineer', company: 'phonepe', externalId: '123',
      viaSite: 'greenhouse', postedAt: '2026-07-10T00:00:00Z',
    })
    expect(n!.description).toContain('Build things')
    expect(n!.applyOptions[0].url).toContain('greenhouse.io')
  })

  it('lever rows map (createdAt epoch → ISO; descriptionPlain preferred)', () => {
    const n = atsBoardAdapter.normalize(
      { kind: 'lever', raw: { id: 'abc-uuid', text: 'Data Analyst', categories: { location: 'Bengaluru' }, descriptionPlain: 'Analyze', hostedUrl: 'https://jobs.lever.co/meesho/abc-uuid', createdAt: 1780000000000 } },
      leverTarget
    )
    expect(n).toMatchObject({ title: 'Data Analyst', company: 'meesho', externalId: 'abc-uuid', viaSite: 'lever' })
    expect(n!.postedAt).toMatch(/^20/)
  })

  it('smartrecruiters rows map; list-only payload without jobAd yields empty description (short-jd flagged downstream, still stored)', () => {
    const n = atsBoardAdapter.normalize(
      { kind: 'smartrecruiters', raw: { id: 'sr-1', name: 'Electrical Engineer', location: { city: 'Pune', country: 'in' }, releasedDate: '2026-07-01T00:00:00Z', ref: 'https://api.smartrecruiters.com/v1/companies/BoschGroup/postings/sr-1' } },
      srTarget
    )
    expect(n).toMatchObject({ title: 'Electrical Engineer', company: 'boschgroup', externalId: 'sr-1', description: '' })
  })

  it('rows missing load-bearing fields are drift (null)', () => {
    expect(atsBoardAdapter.normalize({ kind: 'greenhouse', raw: { location: { name: 'Pune' } } }, ghTarget)).toBeNull()
    expect(atsBoardAdapter.normalize({ kind: 'lever', raw: { text: 'X' } }, leverTarget)).toBeNull()
    expect(atsBoardAdapter.normalize(null, ghTarget)).toBeNull()
  })
})
