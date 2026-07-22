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

import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'

const { mockUseSearchParams, mockFetch, sessionState } = vi.hoisted(() => ({
  mockUseSearchParams: vi.fn(),
  mockFetch: vi.fn(),
  sessionState: {
    value: {
      status: 'unauthenticated' as 'loading' | 'authenticated' | 'unauthenticated',
      data: null as null | { user: { id: string } },
    },
  },
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => mockUseSearchParams(),
}))
vi.mock('next-auth/react', () => ({
  useSession: () => sessionState.value,
}))

import JobsPage from '../page'

function feedCallUrls(): string[] {
  return mockFetch.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.startsWith('/api/jobs/feed'))
}

function personalizedFeedCalls(): Array<[RequestInfo | URL, RequestInit]> {
  return mockFetch.mock.calls
    .filter((c) => String(c[0]) === '/api/jobs/feed' && c[1]?.method === 'POST') as Array<[RequestInfo | URL, RequestInit]>
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
  sessionState.value = { status: 'unauthenticated', data: null }
  sessionStorage.clear()
})

afterEach(() => vi.useRealTimers())

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
      ownerId: null,
    }))
    sessionStorage.setItem('JOBS_CAP_NOTICE', '1')
    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/jobs/quick-wins') return quickWinsResponse
      if (url.startsWith('/api/jobs/feed')) {
        if (init?.method === 'POST') return personalizedFeedResponse
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
      expect(personalizedFeedCalls()).toHaveLength(1)
    })
    expect(feedCallUrls().every((url) => !url.includes('Secret%20Role') && !url.includes('PrivateSkill'))).toBe(true)

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

describe('/jobs personalized-feed privacy', () => {
  it('sends resume-derived role and skills in a POST body, never the request URL', async () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('domain=pm'))
    sessionStorage.setItem('JOBS_TARGET', JSON.stringify({
      method: 'upload',
      role: ' Product Manager ',
      skills: [' Roadmaps ', 'roadmaps', 'SQL'],
      ownerId: null,
    }))

    render(<JobsPage />)

    await waitFor(() => expect(personalizedFeedCalls()).toHaveLength(1))
    const [url, init] = personalizedFeedCalls()[0]
    expect(String(url)).toBe('/api/jobs/feed')
    expect(String(url)).not.toContain('Product')
    expect(String(url)).not.toContain('Roadmaps')
    expect(String(url)).not.toContain('SQL')
    expect(init.cache).toBe('no-store')
    expect(JSON.parse(String(init.body))).toEqual({
      page: 1,
      domain: 'pm',
      targetRole: 'Product Manager',
      skills: ['Roadmaps', 'SQL'],
    })
  })

  it('removes corrupt target storage and falls back to a public GET without throwing', async () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams(''))
    sessionStorage.setItem('JOBS_TARGET', JSON.stringify({
      method: 'upload',
      role: 42,
      skills: 'PrivateSkill',
      ownerId: null,
    }))

    render(<JobsPage />)

    await waitFor(() => expect(feedCallUrls().length).toBeGreaterThan(0))
    expect(personalizedFeedCalls()).toHaveLength(0)
    expect(feedCallUrls()[0]).toBe('/api/jobs/feed?page=1')
    expect(sessionStorage.getItem('JOBS_TARGET')).toBeNull()
  })

  it('does not accept injected resume skills on the role-question path', async () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams(''))
    sessionStorage.setItem('JOBS_TARGET', JSON.stringify({
      method: 'questions',
      role: 'Sales Executive',
      skills: ['PrivateSkill'],
      ownerId: null,
    }))

    render(<JobsPage />)

    await waitFor(() => expect(personalizedFeedCalls()).toHaveLength(1))
    expect(JSON.parse(String(personalizedFeedCalls()[0][1].body))).toEqual({
      page: 1,
      targetRole: 'Sales Executive',
    })
  })

  it('clears a target owned by user A when the feed is opened as user B', async () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams(''))
    sessionState.value = { status: 'authenticated', data: { user: { id: 'user-b' } } }
    sessionStorage.setItem('JOBS_TARGET', JSON.stringify({
      method: 'import',
      role: 'User A Secret Role',
      skills: ['PrivateSkill'],
      ownerId: 'user-a',
    }))

    render(<JobsPage />)

    await waitFor(() => expect(feedCallUrls().length).toBeGreaterThan(0))
    expect(personalizedFeedCalls()).toHaveLength(0)
    expect(feedCallUrls()[0]).toBe('/api/jobs/feed?page=1')
    expect(sessionStorage.getItem('JOBS_TARGET')).toBeNull()
    expect(screen.queryByText(/User A Secret Role/i)).toBeNull()
  })

  it('discards a valid-looking legacy target with no owner provenance', async () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams(''))
    sessionStorage.setItem('JOBS_TARGET', JSON.stringify({
      method: 'upload',
      role: 'Legacy Private Role',
      skills: ['PrivateSkill'],
    }))

    render(<JobsPage />)

    await waitFor(() => expect(feedCallUrls().length).toBeGreaterThan(0))
    expect(personalizedFeedCalls()).toHaveLength(0)
    expect(sessionStorage.getItem('JOBS_TARGET')).toBeNull()
    expect(screen.queryByText(/Legacy Private Role/i)).toBeNull()
  })

  it('hides account-A personalization immediately while auth changes, then loads B publicly', async () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams(''))
    sessionState.value = { status: 'authenticated', data: { user: { id: 'user-a' } } }
    sessionStorage.setItem('JOBS_TARGET', JSON.stringify({
      method: 'import',
      role: 'User A Secret Role',
      skills: ['PrivateSkill'],
      ownerId: 'user-a',
    }))
    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/jobs/feed' && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            cards: [{ id: 'a', title: 'A Secret Job', company: 'A Co', locations: [], isRemote: true }],
            page: 1, pageSize: 20, hasMore: false, total: 1,
          }),
        })
      }
      if (url.startsWith('/api/jobs/feed')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            cards: [{ id: 'public', title: 'Public Job', company: 'Public Co', locations: [], isRemote: true }],
            page: 1, pageSize: 20, hasMore: false, total: 1,
          }),
        })
      }
      return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) })
    })

    const view = render(<JobsPage />)
    expect(await screen.findByText('A Secret Job')).toBeTruthy()

    sessionState.value = { status: 'loading', data: null }
    view.rerender(<JobsPage />)
    expect(screen.queryByText('A Secret Job')).toBeNull()
    expect(screen.queryByText(/User A Secret Role/i)).toBeNull()

    sessionState.value = { status: 'authenticated', data: { user: { id: 'user-b' } } }
    view.rerender(<JobsPage />)
    expect(await screen.findByText('Public Job')).toBeTruthy()
    expect(personalizedFeedCalls()).toHaveLength(1)
  })
})

describe('/jobs truthful product copy', () => {
  it('keeps the feed CTA aligned with the one-question target flow', async () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams(''))
    render(<JobsPage />)

    expect(await screen.findByRole('link', { name: 'Answer one question' })).toHaveAttribute('href', '/jobs/start')
    expect(screen.queryByText(/Answer 3 questions/i)).toBeNull()
  })

  it('does not invent freshness when an unmatched card has no trustworthy date', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-07-22T06:30:00.000Z'))
    mockUseSearchParams.mockReturnValue(new URLSearchParams(''))
    mockFetch.mockImplementation((url: string) => {
      if (String(url).startsWith('/api/jobs/feed')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            cards: [
              { id: 'undated', title: 'Undated role', company: 'Acme', locations: [], isRemote: false },
              { id: 'future', title: 'Future-dated role', company: 'Beta', locations: [], isRemote: false, postedAt: '2026-07-23T00:00:00.000Z' },
              { id: 'listed', title: 'Listed role', company: 'Gamma', locations: [], isRemote: false, postedAt: '2026-07-21T05:00:00.000Z' },
            ],
            page: 1,
            pageSize: 20,
            hasMore: false,
            total: 3,
          }),
        })
      }
      return Promise.resolve({ ok: false, json: () => Promise.resolve(null) })
    })

    render(<JobsPage />)
    expect(await screen.findByText('Undated role')).toBeTruthy()
    expect(screen.queryByText('Recently posted')).toBeNull()
    expect(screen.queryByText(/Posted /)).toBeNull()
    expect(screen.getByText('Listed yesterday')).toBeTruthy()
  })
})
