/**
 * Honest-copy regression tests for JobsCountLink (the Wave-5 press surface).
 *
 * Codex P2s on PR #527:
 *  - Evidence claims ("this session counts toward them" / "practice here
 *    counts as evidence there") were shown to users whose sessions are NOT
 *    jobs-attributed — recordPracticeEvidence only records sessions with
 *    attribution.source='jobs', so the claim was false everywhere this
 *    component renders. Locked here: NO variant's copy ever claims evidence.
 *  - The pathway header claimed "Jobs matching your prep" without measuring
 *    a match. Locked: filtered counts only claim the selected practice area.
 *
 * Plus the standing Wave-5 invariants: zero jobs renders nothing; the
 * domain is named only when valid (JOB_DOMAIN_IDS).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import JobsCountLink from '../components/JobsCountLink'

const mockFetch = vi.fn()

const EVIDENCE_CLAIMS = /counts toward|counts as evidence|evidence/i

function feedResponds(total: number) {
  mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ total }) })
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch)
  mockFetch.mockReset()
})

describe('JobsCountLink honest copy (Codex #527)', () => {
  it('no variant ever claims practice evidence — sessions here are not jobs-attributed', async () => {
    feedResponds(12)
    for (const variant of ['feedback', 'pathway', 'home'] as const) {
      const { container, unmount } = render(<JobsCountLink domain="backend" variant={variant} />)
      await waitFor(() => expect(container.textContent).toContain('12'))
      expect(container.textContent).not.toMatch(EVIDENCE_CLAIMS)
      unmount()
    }
  })

  it('pathway header names a filtered practice area without claiming a match', async () => {
    feedResponds(7)
    const filtered = render(<JobsCountLink domain="data-science" variant="pathway" />)
    expect(await filtered.findByText('Jobs in this practice area')).toBeTruthy()
    expect(filtered.container.textContent).toContain('data-science')
    expect(filtered.container.textContent).not.toContain('matching your prep')
    filtered.unmount()

    const unsupported = render(<JobsCountLink domain="not-a-real-domain" variant="pathway" />)
    await waitFor(() => expect(unsupported.container.innerHTML).toBe(''))
    expect(unsupported.queryByText('Jobs matching your prep')).toBeNull()
  })

  it('unknown domain suppresses the CTA instead of silently linking to all jobs', async () => {
    feedResponds(30)
    const { container } = render(<JobsCountLink domain="underwater-basket-weaving" variant="feedback" />)
    await waitFor(() => expect(container.innerHTML).toBe(''))
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it.each(['ui-designer', 'product-designer'])(
    'maps the Interview role %s to the supported design feed',
    async (domain) => {
      feedResponds(11)
      render(<JobsCountLink domain={domain} variant="feedback" />)
      await waitFor(() => expect(mockFetch).toHaveBeenCalled())
      expect(String(mockFetch.mock.calls[0][0])).toContain('domain=design')
      expect(screen.getByRole('link').getAttribute('href')).toBe('/jobs?domain=design')
    },
  )

  it('keeps general as an explicit unfiltered capability', async () => {
    feedResponds(30)
    render(<JobsCountLink domain="general" variant="feedback" />)
    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    expect(String(mockFetch.mock.calls[0][0])).not.toContain('domain=')
    expect(screen.getByRole('link').getAttribute('href')).toBe('/jobs')
  })

  it('ignores an older count response after the domain changes', async () => {
    let resolveBackend!: (value: unknown) => void
    let resolveFrontend!: (value: unknown) => void
    mockFetch.mockImplementation((url: string) => new Promise((resolve) => {
      if (url.includes('domain=backend')) resolveBackend = resolve
      if (url.includes('domain=frontend')) resolveFrontend = resolve
    }))
    const view = render(<JobsCountLink domain="backend" variant="feedback" />)
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    view.rerender(<JobsCountLink domain="frontend" variant="feedback" />)
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
    await act(async () => {
      resolveFrontend({ ok: true, json: () => Promise.resolve({ total: 7 }) })
    })
    expect(screen.getByText(/7 live frontend jobs/)).toBeTruthy()

    await act(async () => {
      resolveBackend({ ok: true, json: () => Promise.resolve({ total: 30 }) })
    })
    expect(screen.queryByText(/30 live frontend jobs/)).toBeNull()
    expect(screen.getByText(/7 live frontend jobs/)).toBeTruthy()
  })

  it('valid domain links to /jobs?domain=<id> (the feed page honors it)', async () => {
    feedResponds(9)
    const { container } = render(<JobsCountLink domain="frontend" variant="feedback" />)
    await waitFor(() => expect(container.textContent).toContain('9'))
    expect(String(mockFetch.mock.calls[0][0])).toContain('domain=frontend')
    expect(screen.getByRole('link').getAttribute('href')).toBe('/jobs?domain=frontend')
  })

  it('zero jobs renders NOTHING — no promises about an empty feed', async () => {
    feedResponds(0)
    const { container } = render(<JobsCountLink domain="backend" variant="feedback" />)
    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 0))
    expect(container.innerHTML).toBe('')
  })
})
