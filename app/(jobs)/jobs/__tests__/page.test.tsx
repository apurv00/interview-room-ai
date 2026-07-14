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
import { render, screen, waitFor } from '@testing-library/react'

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
