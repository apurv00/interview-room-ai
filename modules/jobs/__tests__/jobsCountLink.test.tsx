/**
 * Honest-copy regression tests for JobsCountLink (the Wave-5 press surface).
 *
 * Codex P2s on PR #527:
 *  - Evidence claims ("this session counts toward them" / "practice here
 *    counts as evidence there") were shown to users whose sessions are NOT
 *    jobs-attributed — recordPracticeEvidence only records sessions with
 *    attribution.source='jobs', so the claim was false everywhere this
 *    component renders. Locked here: NO variant's copy ever claims evidence.
 *  - The pathway header claimed "Jobs matching your prep" even when the
 *    count was unfiltered (unknown/absent domain). Locked: the match claim
 *    exists only when the feed was actually domain-filtered.
 *
 * Plus the standing Wave-5 invariants: zero jobs renders nothing; the
 * domain is named only when valid (JOB_DOMAIN_IDS).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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

  it('pathway header claims "matching your prep" ONLY when the feed was domain-filtered', async () => {
    feedResponds(7)
    const filtered = render(<JobsCountLink domain="data-science" variant="pathway" />)
    expect(await filtered.findByText('Jobs matching your prep')).toBeTruthy()
    expect(filtered.container.textContent).toContain('data-science')
    filtered.unmount()

    const unfiltered = render(<JobsCountLink domain="not-a-real-domain" variant="pathway" />)
    expect(await unfiltered.findByText('Live jobs on the feed')).toBeTruthy()
    expect(unfiltered.queryByText('Jobs matching your prep')).toBeNull()
    expect(unfiltered.container.textContent).not.toContain('not-a-real-domain')
  })

  it('unknown domain falls back to the unfiltered count with generic copy and a plain /jobs link', async () => {
    feedResponds(30)
    const { container } = render(<JobsCountLink domain="underwater-basket-weaving" variant="feedback" />)
    await waitFor(() => expect(container.textContent).toContain('30'))
    expect(String(mockFetch.mock.calls[0][0])).not.toContain('domain=')
    const link = screen.getByRole('link')
    expect(link.getAttribute('href')).toBe('/jobs')
    expect(container.textContent).not.toContain('underwater-basket-weaving')
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
