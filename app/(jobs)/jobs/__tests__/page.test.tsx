/**
 * Regression test for the ?domain= URL param on the /jobs feed page.
 *
 * Codex P2 on PR #527 — JobsCountLink (the press surfaces) links to
 * `/jobs?domain=<id>` promising "N {domain} jobs", but the page never
 * read the param, so users landed on the unfiltered feed and the
 * promised matching jobs were not shown.
 *
 * Invariants locked here:
 *  - a valid domain slug is forwarded to /api/jobs/feed
 *  - the active filter is visible and clearable (honest copy)
 *  - an unknown slug is ignored — no filter forwarded, no chip rendered
 *    (same validation the API applies: JOB_DOMAIN_IDS)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'

const { mockUseSearchParams, mockFetch } = vi.hoisted(() => ({
  mockUseSearchParams: vi.fn(),
  mockFetch: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => mockUseSearchParams(),
}))

import JobsPage from '../page'

function feedCallUrls(): string[] {
  return mockFetch.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.startsWith('/api/jobs/feed'))
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch)
  mockFetch.mockReset().mockImplementation((url: string) => {
    if (String(url).startsWith('/api/jobs/feed')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ cards: [], page: 1, hasMore: false }),
      })
    }
    // quick-wins (401 for anon) + events fire-and-forget
    return Promise.resolve({ ok: false, json: () => Promise.resolve(null) })
  })
  sessionStorage.clear()
})

describe('/jobs ?domain= param (Codex #527 — press links must land on the filtered feed)', () => {
  it('forwards a valid domain to the feed API and shows a clearable filter chip', async () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('domain=data-science'))
    render(<JobsPage />)

    await waitFor(() => expect(feedCallUrls().length).toBeGreaterThan(0))
    const url = new URL(feedCallUrls()[0], 'http://x')
    expect(url.searchParams.get('domain')).toBe('data-science')

    expect(await screen.findByText(/Showing data-science jobs/)).toBeTruthy()
    const clear = screen.getByRole('link', { name: 'Clear filter' })
    expect(clear.getAttribute('href')).toBe('/jobs')
  })

  it('ignores an unknown domain slug — no filter forwarded, no chip', async () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('domain=underwater-basket-weaving'))
    render(<JobsPage />)

    await waitFor(() => expect(feedCallUrls().length).toBeGreaterThan(0))
    const url = new URL(feedCallUrls()[0], 'http://x')
    expect(url.searchParams.get('domain')).toBeNull()
    expect(screen.queryByText(/Showing .* jobs/)).toBeNull()
  })

  it('no domain param behaves as before — unfiltered feed, no chip', async () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams(''))
    render(<JobsPage />)

    await waitFor(() => expect(feedCallUrls().length).toBeGreaterThan(0))
    const url = new URL(feedCallUrls()[0], 'http://x')
    expect(url.searchParams.get('domain')).toBeNull()
    expect(screen.queryByText('Clear filter')).toBeNull()
  })
})

describe('/jobs account deletion cleanup', () => {
  it('clears personalization and ignores an older personalized feed response', async () => {
    let resolveQuickWins!: (value: unknown) => void
    let resolvePersonalizedFeed!: (value: unknown) => void
    const quickWinsResponse = new Promise((resolve) => { resolveQuickWins = resolve })
    const personalizedFeedResponse = new Promise((resolve) => { resolvePersonalizedFeed = resolve })
    mockUseSearchParams.mockReturnValue(new URLSearchParams(''))
    sessionStorage.setItem('JOBS_TARGET', JSON.stringify({
      method: 'upload',
      role: 'Secret Role',
      skills: ['PrivateSkill'],
    }))
    sessionStorage.setItem('JOBS_CAP_NOTICE', '1')
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/jobs/quick-wins') return quickWinsResponse
      if (url.startsWith('/api/jobs/feed')) {
        const parsed = new URL(url, 'http://x')
        if (parsed.searchParams.has('targetRole')) return personalizedFeedResponse
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            cards: [{
              id: 'public-1',
              title: 'Public Job',
              company: 'Public Co',
              locations: [],
              isRemote: true,
            }],
            page: 1,
            pageSize: 20,
            hasMore: false,
            total: 1,
          }),
        })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    })

    render(<JobsPage />)
    await waitFor(() => {
      expect(feedCallUrls().some((url) => new URL(url, 'http://x').searchParams.has('targetRole'))).toBe(true)
    })

    await act(async () => {
      resolveQuickWins({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ code: 'ACCOUNT_UNAVAILABLE' }),
      })
    })

    expect(await screen.findByText(/personalized match signals were cleared/i)).toBeTruthy()
    expect(sessionStorage.getItem('JOBS_TARGET')).toBeNull()
    expect(sessionStorage.getItem('JOBS_CAP_NOTICE')).toBeNull()
    expect(await screen.findByText('Public Job')).toBeTruthy()

    await act(async () => {
      resolvePersonalizedFeed({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          cards: [{
            id: 'private-1',
            title: 'Old Personalized Job',
            company: 'Private Co',
            locations: [],
            isRemote: true,
            matchedSkills: ['PrivateSkill'],
          }],
          page: 1,
          pageSize: 20,
          hasMore: false,
          total: 1,
          sharpened: 1,
        }),
      })
    })
    expect(screen.queryByText('Old Personalized Job')).toBeNull()
    expect(screen.queryByText('PrivateSkill')).toBeNull()
    expect(screen.queryByText(/Sorted for you/i)).toBeNull()
  })
})
