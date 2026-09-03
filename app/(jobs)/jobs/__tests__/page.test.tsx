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
 *  - supported Interview-role aliases resolve to a canonical Jobs domain
 *  - an unknown slug never becomes an unfiltered feed
 */

import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

const { mockUseSearchParams, mockFetch, mockRouter, sessionState } = vi.hoisted(() => ({
  mockUseSearchParams: vi.fn(),
  mockFetch: vi.fn(),
  mockRouter: { push: vi.fn(), replace: vi.fn() },
  sessionState: {
    value: {
      status: 'unauthenticated' as 'loading' | 'authenticated' | 'unauthenticated',
      data: null as null | { user: { id: string } },
    },
  },
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => mockUseSearchParams(),
  usePathname: () => '/jobs',
  useRouter: () => mockRouter,
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

function feedPayload(over: Record<string, unknown> = {}) {
  return {
    cards: [],
    pageSize: 20,
    hasMore: false,
    hasPrevious: false,
    total: 0,
    accessibleTotal: 0,
    resultCap: 400,
    capped: false,
    sharpened: 0,
    sort: 'best',
    ...over,
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch)
  mockRouter.push.mockReset()
  mockRouter.replace.mockReset()
  mockFetch.mockReset().mockImplementation((url: string) => {
    if (String(url).startsWith('/api/jobs/feed')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          cards: [],
          pageSize: 20,
          hasMore: false,
          hasPrevious: false,
          total: 0,
          accessibleTotal: 0,
          resultCap: 400,
          capped: false,
          sharpened: 0,
          sort: 'best',
        }),
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

    const chip = await screen.findByRole('button', { name: /Remove Domain: data-science filter/ })
    fireEvent.click(chip)
    expect(mockRouter.push).toHaveBeenCalledWith('/jobs', { scroll: false })
  })

  it('canonicalizes a supported Interview-role alias before loading', async () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('domain=product-designer'))
    render(<JobsPage />)

    await waitFor(() => expect(feedCallUrls().length).toBeGreaterThan(0))
    const url = new URL(feedCallUrls()[0], 'http://x')
    expect(url.searchParams.get('domain')).toBe('design')
    expect(await screen.findByRole('button', { name: /Remove Domain: design filter/ })).toBeTruthy()
  })

  it('shows a clearable unsupported state without loading the unfiltered feed', async () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('domain=underwater-basket-weaving'))
    render(<JobsPage />)

    expect(await screen.findByText('This job category is not supported in Jobs yet.')).toBeTruthy()
    expect(feedCallUrls()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Clear category' }))
    expect(mockRouter.push).toHaveBeenCalledWith('/jobs', { scroll: false })
  })

  it('no domain param behaves as before — unfiltered feed, no chip', async () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams(''))
    render(<JobsPage />)

    await waitFor(() => expect(feedCallUrls().length).toBeGreaterThan(0))
    const url = new URL(feedCallUrls()[0], 'http://x')
    expect(url.searchParams.get('domain')).toBeNull()
    expect(screen.queryByText('Clear all')).toBeNull()
    expect(mockRouter.replace).not.toHaveBeenCalled()
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
    mockUseSearchParams.mockReturnValue(new URLSearchParams(
      'domain=pm&experience=entry&location=Pune&remote=remote&company=Acme&freshness=7d',
    ))
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
      domain: 'pm',
      experience: 'entry',
      targetRole: 'Product Manager',
      skills: ['Roadmaps', 'SQL'],
    })
    expect(mockRouter.replace).toHaveBeenCalledWith('/jobs?domain=pm&experience=entry', { scroll: false })
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
    expect(feedCallUrls()[0]).toBe('/api/jobs/feed')
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
    expect(feedCallUrls()[0]).toBe('/api/jobs/feed')
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

describe('/jobs URL discovery and request lifecycle', () => {
  it('shows only retained controls and removes retired filters and their cursor state', async () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams(
      'q=Backend&location=Bangalore&remote=remote&experience=mid&company=Acme&freshness=7d&sort=newest&cursor=old&direction=after&utm_campaign=spring',
    ))
    render(<JobsPage />)

    expect(await screen.findByDisplayValue('Backend')).toBeTruthy()
    expect(screen.getByDisplayValue('Mid level')).toBeTruthy()
    expect(screen.getByDisplayValue('Newest')).toBeTruthy()
    expect(screen.getByLabelText('Experience level')).toBeTruthy()
    expect(screen.getByText(/show only jobs whose title clearly states that level/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Search' })).toBeTruthy()
    expect(screen.queryByLabelText('Location preference')).toBeNull()
    expect(screen.queryByLabelText('Work mode')).toBeNull()
    expect(screen.queryByLabelText('Date posted')).toBeNull()
    expect(screen.queryByLabelText('Company')).toBeNull()

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith(
      '/jobs?q=Backend&experience=mid&sort=newest&utm_campaign=spring',
      { scroll: false },
    ))
    await waitFor(() => expect(feedCallUrls()).toContain(
      '/api/jobs/feed?q=Backend&experience=mid&sort=newest',
    ))

    fireEvent.change(screen.getByLabelText('Search jobs'), { target: { value: 'Platform Engineer' } })
    fireEvent.submit(screen.getByRole('search'))

    expect(mockRouter.push).toHaveBeenCalledWith(
      '/jobs?q=Platform+Engineer&experience=mid&sort=newest',
      { scroll: false },
    )
  })

  it('treats an experience-only selection as a hard filter in the empty state', async () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('experience=entry'))
    render(<JobsPage />)

    expect(await screen.findByText('No jobs match these filters.')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Remove Experience level: Entry level filter/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeTruthy()
  })

  it('turns a retired-only URL into the unfiltered first page', async () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams(
      'location=Pune&remote=remote&company=Acme&freshness=7d&cursor=old&direction=after',
    ))
    render(<JobsPage />)

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/jobs', { scroll: false }))
    await waitFor(() => expect(feedCallUrls()).toContain('/api/jobs/feed'))
    expect(screen.queryByLabelText('Location preference')).toBeNull()
  })

  it('synchronizes editable controls when Back or Forward changes URL state', async () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('q=First'))
    const view = render(<JobsPage />)
    expect(await screen.findByDisplayValue('First')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Search jobs'), { target: { value: 'Unsaved draft' } })
    mockUseSearchParams.mockReturnValue(new URLSearchParams('q=Second&experience=senior'))
    view.rerender(<JobsPage />)

    await waitFor(() => expect((screen.getByLabelText('Search jobs') as HTMLInputElement).value).toBe('Second'))
    expect((screen.getByLabelText('Experience level') as HTMLSelectElement).value).toBe('senior')
  })

  it('aborts superseded requests and ignores a late stale response', async () => {
    let resolveFirst!: (response: unknown) => void
    let resolveSecond!: (response: unknown) => void
    const firstResponse = new Promise((resolve) => { resolveFirst = resolve })
    const secondResponse = new Promise((resolve) => { resolveSecond = resolve })
    mockUseSearchParams.mockReturnValue(new URLSearchParams('q=First'))
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/jobs/feed?q=First')) return firstResponse
      if (url.includes('/api/jobs/feed?q=Second')) return secondResponse
      return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve(null) })
    })

    const view = render(<JobsPage />)
    await waitFor(() => expect(feedCallUrls()).toContain('/api/jobs/feed?q=First'))
    const firstCall = mockFetch.mock.calls.find((call) => String(call[0]).includes('q=First'))!
    const firstSignal = firstCall[1]?.signal as AbortSignal

    mockUseSearchParams.mockReturnValue(new URLSearchParams('q=Second'))
    view.rerender(<JobsPage />)
    await waitFor(() => expect(feedCallUrls()).toContain('/api/jobs/feed?q=Second'))
    expect(firstSignal.aborted).toBe(true)

    await act(async () => {
      resolveSecond({
        ok: true,
        status: 200,
        json: () => Promise.resolve(feedPayload({
          cards: [{ id: 'second', title: 'Second result', company: 'Acme', locations: [], isRemote: false }],
          total: 1,
          accessibleTotal: 1,
        })),
      })
    })
    expect(await screen.findByText('Second result')).toBeTruthy()

    await act(async () => {
      resolveFirst({
        ok: true,
        status: 200,
        json: () => Promise.resolve(feedPayload({
          cards: [{ id: 'first', title: 'Stale first result', company: 'Old Co', locations: [], isRemote: false }],
          total: 1,
          accessibleTotal: 1,
        })),
      })
    })
    expect(screen.queryByText('Stale first result')).toBeNull()
  })

  it('renders cursor navigation as a shareable public URL', async () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('q=Backend'))
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/jobs/feed')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(feedPayload({
            cards: [{ id: 'one', title: 'Backend role', company: 'Acme', locations: [], isRemote: false }],
            total: 2,
            accessibleTotal: 2,
            hasMore: true,
            nextCursor: 'next-token',
          })),
        })
      }
      return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve(null) })
    })
    render(<JobsPage />)

    const next = await screen.findByRole('link', { name: 'Next →' })
    expect(next.getAttribute('href')).toBe('/jobs?q=Backend&cursor=next-token&direction=after')
  })
})

describe('/jobs truthful product copy', () => {
  it('gives resume upload a direct entry while preserving the role-only chooser', async () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams(''))
    render(<JobsPage />)

    expect(await screen.findByRole('link', { name: 'Upload resume' })).toHaveAttribute(
      'href',
      '/jobs/start?intent=upload',
    )
    expect(screen.getByRole('link', { name: 'Answer one question' })).toHaveAttribute(
      'href',
      '/jobs/start',
    )
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
              { id: 'undated', title: 'Undated role', company: 'Acme', locations: ['Pune'], isRemote: true },
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
    expect(screen.getByText('Acme · Pune · Remote')).toBeTruthy()
  })
})
