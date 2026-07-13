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

  it('word-bounded + India-scoped remote only: Indianapolis / Remote - US excluded, Remote - India kept (Codex #513 round-4)', async () => {
    mockFetchJSON.mockResolvedValueOnce({
      ok: true, status: 200,
      data: { jobs: [
        { id: 3, title: 'SDE', location: { name: 'Indianapolis, Indiana, United States' }, content: 'x', absolute_url: 'https://boards.greenhouse.io/phonepe/jobs/3' },
        { id: 4, title: 'SDE', location: { name: 'Remote - US' }, content: 'x', absolute_url: 'https://boards.greenhouse.io/phonepe/jobs/4' },
        { id: 5, title: 'SDE', location: { name: 'Remote - India' }, content: 'x', absolute_url: 'https://boards.greenhouse.io/phonepe/jobs/5' },
      ] },
    })
    const res = await atsBoardAdapter.fetch(ghTarget)
    expect(res.raw).toHaveLength(1)
    const n = atsBoardAdapter.normalize(res.raw[0], ghTarget)
    expect(n!.externalId).toBe('5')
    expect(n!.isRemote).toBe(true)
  })

  it('an unexpected envelope is bodyError (drift-class), not zero supply', async () => {
    mockFetchJSON.mockResolvedValueOnce({ ok: true, status: 200, data: { unexpected: true } })
    const res = await atsBoardAdapter.fetch(ghTarget)
    expect(res.ok).toBe(false)
    expect(res.bodyError).toBe(true)
  })
})

describe('SmartRecruiters pagination (Codex #513 P1)', () => {
  it('pages by offset until a short page, aggregating rows', async () => {
    mockFetchJSON.mockReset()
    const fullPage = { content: Array.from({ length: 100 }, (_, i) => ({ id: `p1-${i}`, name: 'Engineer', location: { city: 'Pune' } })) }
    const shortPage = { content: [{ id: 'p2-0', name: 'Engineer', location: { city: 'Pune' } }] }
    mockFetchJSON.mockResolvedValueOnce({ ok: true, status: 200, data: fullPage })
    mockFetchJSON.mockResolvedValueOnce({ ok: true, status: 200, data: shortPage })
    const res = await atsBoardAdapter.fetch(srTarget)
    expect(res.ok).toBe(true)
    expect(res.raw).toHaveLength(101)
    expect(res.attempts).toBe(2)
    expect(String(mockFetchJSON.mock.calls[1][0])).toContain('offset=100')
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

  it('smartrecruiters: the API ref is NEVER the apply URL — public posting URL constructed (Codex #513 P1)', () => {
    const n = atsBoardAdapter.normalize(
      { kind: 'smartrecruiters', raw: { id: 'sr-1', name: 'Electrical Engineer', location: { city: 'Pune', country: 'in' }, releasedDate: '2026-07-01T00:00:00Z', ref: 'https://api.smartrecruiters.com/v1/companies/BoschGroup/postings/sr-1' } },
      srTarget
    )
    expect(n).toMatchObject({ title: 'Electrical Engineer', company: 'boschgroup', externalId: 'sr-1', description: '' })
    expect(n!.applyOptions[0].url).toBe('https://jobs.smartrecruiters.com/BoschGroup/sr-1')
    // and an api-host applyUrl is also rejected in favor of the public URL
    const n2 = atsBoardAdapter.normalize(
      { kind: 'smartrecruiters', raw: { id: 'sr-2', name: 'X', applyUrl: 'https://api.smartrecruiters.com/v1/x' } },
      srTarget
    )
    expect(n2!.applyOptions[0].url).toBe('https://jobs.smartrecruiters.com/BoschGroup/sr-2')
  })

  it('smartrecruiters: bare city for locationKey + location.remote preserved (Codex #513 round-3)', () => {
    const n = atsBoardAdapter.normalize(
      { kind: 'smartrecruiters', raw: { id: 'sr-3', name: 'ME', location: { city: 'Pune', country: 'in', remote: false } } },
      srTarget
    )
    expect(n!.city).toBe('Pune') // never 'Pune, IN'
    const r = atsBoardAdapter.normalize(
      { kind: 'smartrecruiters', raw: { id: 'sr-4', name: 'ME', location: { city: 'Bengaluru', country: 'in', remote: true } } },
      srTarget
    )
    expect(r!.isRemote).toBe(true)
  })

  it('rows missing load-bearing fields are drift (null)', () => {
    expect(atsBoardAdapter.normalize({ kind: 'greenhouse', raw: { location: { name: 'Pune' } } }, ghTarget)).toBeNull()
    expect(atsBoardAdapter.normalize({ kind: 'lever', raw: { text: 'X' } }, leverTarget)).toBeNull()
    expect(atsBoardAdapter.normalize(null, ghTarget)).toBeNull()
  })
})
