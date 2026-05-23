import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import PathwayStatusBanner from '@learn/components/PathwayStatusBanner'
import { _resetDeduplicatedFetchCache } from '@shared/cachedFetch'

const mockUseSession = vi.fn()
vi.mock('next-auth/react', () => ({
  useSession: () => mockUseSession(),
}))

function mockAuthedAs(userId: string) {
  mockUseSession.mockReturnValue({
    status: 'authenticated',
    data: { user: { id: userId } },
  })
}

describe('PathwayStatusBanner', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    _resetDeduplicatedFetchCache()
    fetchSpy = vi.spyOn(global, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('renders nothing for anonymous visitors', async () => {
    mockUseSession.mockReturnValue({ status: 'unauthenticated' })
    const { container } = render(<PathwayStatusBanner />)
    await waitFor(() => {
      // Anonymous resolves immediately; container stays empty.
      expect(container).toBeEmptyDOMElement()
    })
  })

  it('renders the active "Your pathway" banner when pathway is ready', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        state: 'active',
        nextAction: { title: 'Lesson 2: Quantify', ctaLabel: 'Continue', href: '/learn/pathway' },
        pathway: { readinessScore: 62, readinessLevel: 'developing' },
      }),
    } as Response)
    mockAuthedAs('user-1')

    render(<PathwayStatusBanner />)
    await waitFor(() => {
      expect(screen.getByText(/Your pathway/i)).toBeInTheDocument()
    })
    expect(screen.getByText(/Lesson 2: Quantify/i)).toBeInTheDocument()
  })

  // ── Codex P2 (PR #402): error-state regression guard ──────────────────
  // Pre-Wave-3 banner rendered the baseline "Start your pathway" affordance
  // whenever the fetch failed (`!pathway` matched the empty branch). The
  // Wave 3 hook migration short-circuited every non-ready status to null,
  // silently removing the recovery CTA on degraded networks. The fix
  // treats 'error' the same as 'empty' — render the baseline.

  it('falls back to the baseline "Start your pathway" affordance when the fetch fails', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('network down'))
    mockAuthedAs('user-1')

    render(<PathwayStatusBanner />)
    await waitFor(() => {
      expect(screen.getByText(/Start your pathway/i)).toBeInTheDocument()
    })
    // Recovery CTA copy from the baseline branch must be present.
    expect(
      screen.getByText(/Run a baseline interview to generate your first plan/i),
    ).toBeInTheDocument()
  })

  it('falls back to baseline when the API returns a non-OK response', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) } as Response)
    mockAuthedAs('user-1')

    render(<PathwayStatusBanner />)
    await waitFor(() => {
      expect(screen.getByText(/Start your pathway/i)).toBeInTheDocument()
    })
  })
})
