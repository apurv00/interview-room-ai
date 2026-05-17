/**
 * Pathway P2 Wave 1 (feature A) — Pre-interview coach card.
 *
 * Tests verify the surfaces the user actually sees:
 *
 *   1. Renders nothing while no domain is selected (Step 0 entry state)
 *   2. Renders nothing when the API returns `{ feedback: null }`
 *      (user has no prior same-domain history)
 *   3. Renders the first top_3_improvement as the primary callout
 *      and the rest as list items, with a link to the source feedback
 *   4. Re-fetches when the user switches domains mid-Step-0
 *
 * The API mocks return synchronously through a Promise so we don't
 * have to advance fake timers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import PreInterviewCoachCard from '../components/PreInterviewCoachCard'

const { mockDeduplicatedFetch } = vi.hoisted(() => ({
  mockDeduplicatedFetch: vi.fn(),
}))
vi.mock('@shared/cachedFetch', () => ({
  deduplicatedFetch: (...args: unknown[]) => mockDeduplicatedFetch(...args),
}))

vi.mock('@interview/config/interviewConfig', () => ({
  // Real getDomainLabel walks a CMS-derived cache; tests just want a
  // predictable label for assertion.
  getDomainLabel: (slug: string) => (slug === 'software-engineer' ? 'Software Engineer' : slug),
}))

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

beforeEach(() => {
  mockDeduplicatedFetch.mockReset()
})

describe('PreInterviewCoachCard', () => {
  it('renders nothing while no domain is selected', () => {
    const { container } = render(<PreInterviewCoachCard domain={null} />)
    expect(container.firstChild).toBeNull()
    expect(mockDeduplicatedFetch).not.toHaveBeenCalled()
  })

  it('renders nothing when the user has no prior same-domain feedback', async () => {
    mockDeduplicatedFetch.mockResolvedValue(jsonResponse({ feedback: null }))

    const { container } = render(<PreInterviewCoachCard domain="software-engineer" />)

    await waitFor(() => {
      expect(mockDeduplicatedFetch).toHaveBeenCalledTimes(1)
    })
    // After the fetch settles, still nothing rendered
    await waitFor(() => {
      expect(container.firstChild).toBeNull()
    })
  })

  it('surfaces the first improvement as primary copy and the rest as list items', async () => {
    mockDeduplicatedFetch.mockResolvedValue(
      jsonResponse({
        feedback: {
          sessionId: 'sess_abc',
          completedAt: '2026-05-10T12:00:00Z',
          domain: 'software-engineer',
          interviewType: 'behavioral',
          overallScore: 72,
          topImprovements: [
            'Tighten STAR structure on system design questions.',
            'Quantify ownership claims more explicitly.',
            'Reduce filler words around transitions.',
          ],
        },
      }),
    )

    render(<PreInterviewCoachCard domain="software-engineer" />)

    await waitFor(() => {
      expect(screen.getByTestId('pre-interview-coach-card')).toBeTruthy()
    })
    expect(screen.getByText(/From your last Software Engineer interview/i)).toBeTruthy()
    expect(screen.getByText(/Tighten STAR structure/)).toBeTruthy()
    expect(screen.getByText(/Quantify ownership claims/)).toBeTruthy()
    expect(screen.getByText(/Reduce filler words/)).toBeTruthy()
    const link = screen.getByRole('link', { name: /See full feedback/i })
    expect(link.getAttribute('href')).toBe('/feedback/sess_abc')
  })

  it('re-fetches when the selected domain changes', async () => {
    mockDeduplicatedFetch
      .mockResolvedValueOnce(jsonResponse({ feedback: null }))
      .mockResolvedValueOnce(jsonResponse({ feedback: null }))

    const { rerender } = render(<PreInterviewCoachCard domain="software-engineer" />)
    await waitFor(() => expect(mockDeduplicatedFetch).toHaveBeenCalledTimes(1))
    expect(mockDeduplicatedFetch.mock.calls[0][0]).toContain('domain=software-engineer')

    rerender(<PreInterviewCoachCard domain="product-manager" />)
    await waitFor(() => expect(mockDeduplicatedFetch).toHaveBeenCalledTimes(2))
    expect(mockDeduplicatedFetch.mock.calls[1][0]).toContain('domain=product-manager')
  })

  it('renders nothing on fetch error (silent degradation, not a blocker)', async () => {
    mockDeduplicatedFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    } as unknown as Response)

    const { container } = render(<PreInterviewCoachCard domain="software-engineer" />)

    await waitFor(() => expect(mockDeduplicatedFetch).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      expect(container.firstChild).toBeNull()
    })
  })
})
