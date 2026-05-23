import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { usePathwayNextAction } from '@learn/hooks/usePathwayNextAction'
import { _resetDeduplicatedFetchCache } from '@shared/cachedFetch'

const mockUseSession = vi.fn()
vi.mock('next-auth/react', () => ({
  useSession: () => mockUseSession(),
}))

// Codex P1 (PR #402): hook now requires session.user.id to discriminate
// the in-flight cache slot. Helper standardizes the authed payload.
function mockAuthedAs(userId: string) {
  mockUseSession.mockReturnValue({
    status: 'authenticated',
    data: { user: { id: userId } },
  })
}

describe('usePathwayNextAction', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    _resetDeduplicatedFetchCache()
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        state: 'active',
        nextAction: {
          title: 'Lesson 2: Quantify your impact',
          ctaLabel: 'Continue lesson',
          href: '/learn/pathway?lesson=L2',
        },
        pathway: { readinessScore: 62, readinessLevel: 'developing' },
      }),
    } as Response)
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('stays "loading" while NextAuth resolves', () => {
    mockUseSession.mockReturnValue({ status: 'loading' })
    const { result } = renderHook(() => usePathwayNextAction())
    expect(result.current.status).toBe('loading')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns "anonymous" without fetching when user is unauthenticated', async () => {
    mockUseSession.mockReturnValue({ status: 'unauthenticated' })
    const { result } = renderHook(() => usePathwayNextAction())
    await waitFor(() => expect(result.current.status).toBe('anonymous'))
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('hydrates pathway state from /api/learn/pathway when authenticated', async () => {
    mockAuthedAs('user-1')
    const { result } = renderHook(() => usePathwayNextAction())
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.state).toBe('active')
    expect(result.current.nextAction?.title).toContain('Lesson 2')
    expect(result.current.pathway?.readinessScore).toBe(62)
  })

  it('shares one network call between two concurrent same-user consumers (in-flight dedup)', async () => {
    mockAuthedAs('user-1')
    const a = renderHook(() => usePathwayNextAction())
    const b = renderHook(() => usePathwayNextAction())
    await waitFor(() => {
      expect(a.result.current.status).toBe('ready')
      expect(b.result.current.status).toBe('ready')
    })
    // Both hooks resolved; only ONE actual fetch fired (in-flight dedup
    // keyed by `${url}#${userId}`).
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('reports "error" when the fetch rejects', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('boom'))
    mockAuthedAs('user-1')
    const { result } = renderHook(() => usePathwayNextAction())
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.nextAction).toBeNull()
  })

  // ── Codex P1 (PR #402): cross-account guard ────────────────────────────
  // If A's pathway fetch is in-flight when the tab switches to B, B must
  // NOT see A's payload via the shared in-flight map.

  it('does NOT serve user A pathway to user B mid-flight (userId-scoped cache key)', async () => {
    // Slow fetch — gives us a window to flip the session.
    let resolveA: (r: Response) => void = () => {}
    fetchSpy.mockReturnValueOnce(new Promise<Response>((r) => { resolveA = r }))

    mockAuthedAs('user-A')
    const a = renderHook(() => usePathwayNextAction())

    // While A is mid-flight, account switches to B. B's hook fires —
    // it must NOT attach to A's pending promise.
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        state: 'empty',
        nextAction: { title: 'Start baseline', ctaLabel: 'Begin', href: '/interview/setup' },
        pathway: null,
        _user: 'B', // marker so we can prove which payload landed
      }),
    } as Response)
    mockAuthedAs('user-B')
    const b = renderHook(() => usePathwayNextAction())
    await waitFor(() => expect(b.result.current.status).toBe('ready'))

    // B got B's payload (not A's). Two distinct fetches fired.
    expect(b.result.current.nextAction?.title).toBe('Start baseline')
    expect(fetchSpy).toHaveBeenCalledTimes(2)

    // Resolve A so the suite doesn't leak.
    resolveA({
      ok: true,
      json: async () => ({ state: 'active', nextAction: null, pathway: null }),
    } as Response)
    await waitFor(() => expect(a.result.current.status).toBe('ready'))
  })

  it('stays in "loading" if authenticated but user id is not yet on the session', async () => {
    mockUseSession.mockReturnValue({ status: 'authenticated', data: { user: {} } })
    const { result } = renderHook(() => usePathwayNextAction())
    await new Promise((r) => setTimeout(r, 5))
    expect(result.current.status).toBe('loading')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  // ── PR #402 follow-up: clear stale nextAction on user switch ───────────
  // Without the reset, the homepage CTA / banner can briefly use user A's
  // nextAction.href while user B's fetch is still in flight. A fast click
  // during that window navigates the wrong account's user.

  it('clears nextAction immediately on userId change (no stale nav target during fetch)', async () => {
    mockAuthedAs('user-A')
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        state: 'active',
        nextAction: { title: 'A lesson', ctaLabel: 'A', href: '/learn/pathway?lesson=A' },
        pathway: { readinessScore: 50, readinessLevel: 'developing' },
      }),
    } as Response)
    const { result, rerender } = renderHook(() => usePathwayNextAction())
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.nextAction?.href).toBe('/learn/pathway?lesson=A')

    // Account switch: user A → user B. Hold B's fetch open so we can
    // observe the in-between state.
    let resolveB: (r: Response) => void = () => {}
    fetchSpy.mockReturnValueOnce(new Promise<Response>((r) => { resolveB = r }))
    mockAuthedAs('user-B')
    rerender()

    // The effect must reset the state to loading + null BEFORE the
    // new fetch resolves. A click during this window cannot pull
    // user A's nextAction.href.
    await waitFor(() => {
      expect(result.current.status).toBe('loading')
      expect(result.current.nextAction).toBeNull()
      expect(result.current.pathway).toBeNull()
    })

    // B's fetch lands; B's data populates state.
    resolveB({
      ok: true,
      json: async () => ({
        state: 'active',
        nextAction: { title: 'B lesson', ctaLabel: 'B', href: '/learn/pathway?lesson=B' },
        pathway: { readinessScore: 70, readinessLevel: 'developing' },
      }),
    } as Response)
    await waitFor(() => expect(result.current.nextAction?.href).toBe('/learn/pathway?lesson=B'))
  })
})
