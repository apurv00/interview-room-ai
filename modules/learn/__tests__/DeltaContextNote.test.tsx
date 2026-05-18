/**
 * Pathway P2 Wave 5 (5C) — DeltaContextNote tests.
 *
 * Locks the three rendered states (first-attempt / trend / hidden)
 * AND the approx-caveat trigger for large deltas (the
 * cross-prompt scoring incommensurability flagged by the Plan agent).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import DeltaContextNote from '../components/drill/DeltaContextNote'

const { mockDeduplicatedFetch } = vi.hoisted(() => ({
  mockDeduplicatedFetch: vi.fn(),
}))
vi.mock('@shared/cachedFetch', () => ({
  deduplicatedFetch: (...a: unknown[]) => mockDeduplicatedFetch(...a),
}))

function jsonResponse(attempts: Array<{ id: string; delta: number; competency: string; createdAt: string }>) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ attempts }),
  } as unknown as Response
}

beforeEach(() => {
  mockDeduplicatedFetch.mockReset()
})

describe('DeltaContextNote', () => {
  it('renders the first-drill copy when no prior attempts exist (after self-filtering)', async () => {
    // Only the just-submitted attempt is in the response.
    mockDeduplicatedFetch.mockResolvedValue(
      jsonResponse([
        { id: 'a1', delta: 12, competency: 'relevance', createdAt: '2026-05-17T00:00:00Z' },
      ]),
    )

    render(<DeltaContextNote competency="relevance" latestDelta={12} />)

    await waitFor(() => {
      expect(screen.getByTestId('delta-context-note')).toBeTruthy()
    })
    expect(screen.getByText(/First relevance drill/i)).toBeTruthy()
  })

  it('renders mean-delta trend across N prior attempts (excluding the just-submitted one)', async () => {
    // 1 just-submitted (delta=8) + 3 priors (delta=4, 6, 8). After
    // filtering the most recent matching delta, priors are 4,6,8 →
    // mean = 6.
    mockDeduplicatedFetch.mockResolvedValue(
      jsonResponse([
        { id: 'a1', delta: 8, competency: 'relevance', createdAt: '2026-05-17T00:00:00Z' },
        { id: 'a2', delta: 4, competency: 'relevance', createdAt: '2026-05-15T00:00:00Z' },
        { id: 'a3', delta: 6, competency: 'relevance', createdAt: '2026-05-12T00:00:00Z' },
        { id: 'a4', delta: 8, competency: 'relevance', createdAt: '2026-05-10T00:00:00Z' },
      ]),
    )

    render(<DeltaContextNote competency="relevance" latestDelta={8} />)

    await waitFor(() => {
      expect(screen.getByTestId('delta-context-note')).toBeTruthy()
    })
    // Three priors after dropping one matching the latest delta.
    expect(screen.getByText(/3 prior relevance drills/i)).toBeTruthy()
    expect(screen.getByText(/\+6/)).toBeTruthy()
  })

  it('shows the "approximate" caveat for large deltas (|delta| > 15)', async () => {
    mockDeduplicatedFetch.mockResolvedValue(
      jsonResponse([
        { id: 'a1', delta: 20, competency: 'specificity', createdAt: '2026-05-17T00:00:00Z' },
        { id: 'a2', delta: 5, competency: 'specificity', createdAt: '2026-05-15T00:00:00Z' },
      ]),
    )

    render(<DeltaContextNote competency="specificity" latestDelta={20} />)

    await waitFor(() => {
      expect(screen.getByTestId('delta-context-approx-caveat')).toBeTruthy()
    })
    expect(screen.getByText(/Approximate/)).toBeTruthy()
  })

  it('does NOT show the caveat for small deltas', async () => {
    mockDeduplicatedFetch.mockResolvedValue(
      jsonResponse([
        { id: 'a1', delta: 8, competency: 'structure', createdAt: '2026-05-17T00:00:00Z' },
        { id: 'a2', delta: 5, competency: 'structure', createdAt: '2026-05-15T00:00:00Z' },
      ]),
    )

    render(<DeltaContextNote competency="structure" latestDelta={8} />)

    await waitFor(() => expect(screen.getByTestId('delta-context-note')).toBeTruthy())
    expect(screen.queryByTestId('delta-context-approx-caveat')).toBeNull()
  })

  it('renders nothing when the history fetch fails (best-effort, never blocks the drill)', async () => {
    mockDeduplicatedFetch.mockRejectedValue(new Error('network down'))

    const { container } = render(
      <DeltaContextNote competency="relevance" latestDelta={10} />,
    )

    await waitFor(() => expect(mockDeduplicatedFetch).toHaveBeenCalled())
    await waitFor(() => expect(container.firstChild).toBeNull())
  })

  it('passes the competency through the request URL', async () => {
    mockDeduplicatedFetch.mockResolvedValue(jsonResponse([]))

    render(<DeltaContextNote competency="ownership" latestDelta={3} />)

    await waitFor(() => expect(mockDeduplicatedFetch).toHaveBeenCalledTimes(1))
    const url = mockDeduplicatedFetch.mock.calls[0][0] as string
    expect(url).toContain('competency=ownership')
    expect(url).toContain('limit=11')
  })
})
