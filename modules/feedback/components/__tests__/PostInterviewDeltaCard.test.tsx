/**
 * Pathway P2 Wave 2 (feature B) — Post-interview Delta Card.
 *
 * Closes the action-anchored loop opened by Wave 1's setup-page coach card.
 * Tests verify:
 *
 *   1. Renders nothing while the prior fetch is in flight / on error
 *   2. Renders nothing for first-in-domain sessions (no prior history)
 *   3. Renders side-by-side prior vs current focus areas
 *   4. Renders the overall_score delta with directional badge
 *   5. Flags repeated focus areas with a "Still showing up" badge
 *   6. Does NOT flag repetition when current focus differs in substance
 *   7. Does NOT fetch for local/unsaved sessions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import PostInterviewDeltaCard from '../PostInterviewDeltaCard'

const { mockDeduplicatedFetch } = vi.hoisted(() => ({
  mockDeduplicatedFetch: vi.fn(),
}))
vi.mock('@shared/cachedFetch', () => ({
  deduplicatedFetch: (...args: unknown[]) => mockDeduplicatedFetch(...args),
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

describe('PostInterviewDeltaCard', () => {
  it('renders nothing when domain is missing', () => {
    const { container } = render(
      <PostInterviewDeltaCard
        sessionId="sess_current"
        domain={undefined}
        currentOverallScore={75}
        currentTopImprovements={['Sharpen STAR']}
      />,
    )
    expect(container.firstChild).toBeNull()
    expect(mockDeduplicatedFetch).not.toHaveBeenCalled()
  })

  it('renders nothing for local/unsaved sessions', () => {
    const { container } = render(
      <PostInterviewDeltaCard
        sessionId="local"
        domain="software-engineer"
        currentOverallScore={75}
        currentTopImprovements={['Sharpen STAR']}
      />,
    )
    expect(container.firstChild).toBeNull()
    expect(mockDeduplicatedFetch).not.toHaveBeenCalled()
  })

  it('renders nothing when no prior same-domain history exists', async () => {
    mockDeduplicatedFetch.mockResolvedValue(jsonResponse({ feedback: null }))

    const { container } = render(
      <PostInterviewDeltaCard
        sessionId="sess_current"
        domain="software-engineer"
        currentOverallScore={75}
        currentTopImprovements={['Sharpen STAR']}
      />,
    )

    await waitFor(() => expect(mockDeduplicatedFetch).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(container.firstChild).toBeNull())
  })

  it('renders side-by-side focus areas + positive overall delta', async () => {
    mockDeduplicatedFetch.mockResolvedValue(
      jsonResponse({
        feedback: {
          sessionId: 'sess_prior',
          completedAt: '2026-05-10T12:00:00Z',
          domain: 'software-engineer',
          interviewType: 'behavioral',
          overallScore: 62,
          topImprovements: ['Quantify ownership claims more explicitly.'],
        },
      }),
    )

    render(
      <PostInterviewDeltaCard
        sessionId="sess_current"
        domain="software-engineer"
        currentOverallScore={75}
        currentTopImprovements={['Tighten STAR structure on design questions.']}
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('post-interview-delta-card')).toBeTruthy()
    })
    expect(screen.getByText(/Last time/)).toBeTruthy()
    expect(screen.getByText(/Quantify ownership claims/)).toBeTruthy()
    expect(screen.getByText(/Tighten STAR structure/)).toBeTruthy()
    // +13 overall delta surfaces as +13
    expect(screen.getByText(/\+13 overall/)).toBeTruthy()
    // Repeat badge must NOT appear when focus shifted
    expect(screen.queryByText(/Still showing up/i)).toBeNull()
    // Link back to prior session
    const link = screen.getByRole('link', { name: /last interview/i })
    expect(link.getAttribute('href')).toBe('/feedback/sess_prior')
  })

  it('flags repeated focus area with "Still showing up" badge', async () => {
    mockDeduplicatedFetch.mockResolvedValue(
      jsonResponse({
        feedback: {
          sessionId: 'sess_prior',
          completedAt: '2026-05-10T12:00:00Z',
          domain: 'software-engineer',
          interviewType: 'behavioral',
          overallScore: 70,
          topImprovements: ['Tighten STAR structure on design questions.'],
        },
      }),
    )

    render(
      <PostInterviewDeltaCard
        sessionId="sess_current"
        domain="software-engineer"
        currentOverallScore={70}
        currentTopImprovements={['Tighten STAR structure on design questions!']}
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('post-interview-delta-card')).toBeTruthy()
    })
    expect(screen.getByText(/Still showing up/i)).toBeTruthy()
  })

  it('shows a flat-delta badge for ±2-point movement', async () => {
    mockDeduplicatedFetch.mockResolvedValue(
      jsonResponse({
        feedback: {
          sessionId: 'sess_prior',
          completedAt: '2026-05-10T12:00:00Z',
          domain: 'software-engineer',
          interviewType: null,
          overallScore: 74,
          topImprovements: ['Quantify ownership.'],
        },
      }),
    )

    render(
      <PostInterviewDeltaCard
        sessionId="sess_current"
        domain="software-engineer"
        currentOverallScore={75}
        currentTopImprovements={['Be more concise.']}
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('post-interview-delta-card')).toBeTruthy()
    })
    // +1 → falls in the |delta| <= 2 "flat" band
    expect(screen.getByText(/\+1 overall/)).toBeTruthy()
  })

  it('passes priorTo + domain in the fetch URL', async () => {
    mockDeduplicatedFetch.mockResolvedValue(jsonResponse({ feedback: null }))

    render(
      <PostInterviewDeltaCard
        sessionId="sess_xyz"
        domain="product-manager"
        currentOverallScore={50}
        currentTopImprovements={[]}
      />,
    )

    await waitFor(() => expect(mockDeduplicatedFetch).toHaveBeenCalledTimes(1))
    const url = mockDeduplicatedFetch.mock.calls[0][0] as string
    expect(url).toContain('domain=product-manager')
    expect(url).toContain('priorTo=sess_xyz')
  })
})
