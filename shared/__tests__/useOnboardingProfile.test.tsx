import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useOnboardingProfile, _resetOnboardingProfileCache } from '@shared/hooks/useOnboardingProfile'

const mockUseSession = vi.fn()
vi.mock('next-auth/react', () => ({
  useSession: () => mockUseSession(),
}))

// Codex P1 (PR #402): cache is now keyed by session.user.id. Helpers
// below make it easy to flip the mocked session between users.
function mockAuthedAs(userId: string) {
  mockUseSession.mockReturnValue({
    status: 'authenticated',
    data: { user: { id: userId } },
  })
}

describe('useOnboardingProfile', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    _resetOnboardingProfileCache()
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ targetRole: 'pm', experienceLevel: '3-6' }),
    } as Response)
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('returns "loading" while NextAuth is still resolving', () => {
    mockUseSession.mockReturnValue({ status: 'loading' })
    const { result } = renderHook(() => useOnboardingProfile())
    expect(result.current.status).toBe('loading')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns "anonymous" with no fetch when user is unauthenticated', async () => {
    mockUseSession.mockReturnValue({ status: 'unauthenticated' })
    const { result } = renderHook(() => useOnboardingProfile())
    await waitFor(() => expect(result.current.status).toBe('anonymous'))
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fetches /api/onboarding on authentication and returns the profile', async () => {
    mockAuthedAs('u1')
    const { result } = renderHook(() => useOnboardingProfile())
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.profile).toMatchObject({ targetRole: 'pm', experienceLevel: '3-6' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('serves a second hook consumer (same user) from the TTL cache (no second fetch)', async () => {
    mockAuthedAs('u1')

    // First consumer triggers the fetch.
    const first = renderHook(() => useOnboardingProfile())
    await waitFor(() => expect(first.result.current.status).toBe('ready'))
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // Second consumer mounts later in the same TTL window — should be
    // ready immediately from cache, no extra fetch.
    const second = renderHook(() => useOnboardingProfile())
    expect(second.result.current.status).toBe('ready')
    expect(second.result.current.profile).toMatchObject({ targetRole: 'pm' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('reports "error" when the network call rejects', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('network down'))
    mockAuthedAs('u1')
    const { result } = renderHook(() => useOnboardingProfile())
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.profile).toBeNull()
  })

  it('returns ready with null profile when /api/onboarding 401s', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) } as Response)
    mockAuthedAs('u1')
    const { result } = renderHook(() => useOnboardingProfile())
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.profile).toBeNull()
  })

  // ── Codex P1: per-user cache scoping ───────────────────────────────────
  // A sign-out + sign-in inside the 30 s TTL must never serve the prior
  // user's data. The previous module-scoped cache leaked across users.

  it('does NOT serve user A profile to user B when B signs in within TTL', async () => {
    // User A loads and primes the cache.
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ targetRole: 'pm', _user: 'A' }),
    } as Response)
    mockAuthedAs('user-A')
    const a = renderHook(() => useOnboardingProfile())
    await waitFor(() => expect(a.result.current.status).toBe('ready'))
    expect(a.result.current.profile).toMatchObject({ _user: 'A' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // User A signs out, user B signs in — same browser tab, same hook
    // module. The hook MUST re-fetch (cache key differs) and MUST NOT
    // serve user A's profile.
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ targetRole: 'swe', _user: 'B' }),
    } as Response)
    mockAuthedAs('user-B')
    const b = renderHook(() => useOnboardingProfile())
    await waitFor(() => expect(b.result.current.status).toBe('ready'))
    expect(b.result.current.profile).toMatchObject({ _user: 'B' })
    expect(b.result.current.profile).not.toMatchObject({ _user: 'A' })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('serves user A profile from cache when A signs back in within TTL', async () => {
    mockAuthedAs('user-A')
    const first = renderHook(() => useOnboardingProfile())
    await waitFor(() => expect(first.result.current.status).toBe('ready'))
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // Auth flips to unauthenticated (sign-out), then back to user A.
    mockUseSession.mockReturnValue({ status: 'unauthenticated' })
    const signedOut = renderHook(() => useOnboardingProfile())
    await waitFor(() => expect(signedOut.result.current.status).toBe('anonymous'))

    // A signs back in — same userId — cache hit, no extra fetch.
    mockAuthedAs('user-A')
    const second = renderHook(() => useOnboardingProfile())
    expect(second.result.current.status).toBe('ready')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('stays in "loading" if authenticated but user id is not yet on the session', async () => {
    // Defensive case — should never happen with the app's authOptions,
    // but the hook must not fetch (and potentially cache cross-user
    // results) without a stable user id.
    mockUseSession.mockReturnValue({ status: 'authenticated', data: { user: {} } })
    const { result } = renderHook(() => useOnboardingProfile())
    // Small wait so any effect would have run.
    await new Promise((r) => setTimeout(r, 5))
    expect(result.current.status).toBe('loading')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
