import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useOnboardingProfile, _resetOnboardingProfileCache } from '@shared/hooks/useOnboardingProfile'

const mockUseSession = vi.fn()
vi.mock('next-auth/react', () => ({
  useSession: () => mockUseSession(),
}))

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
    mockUseSession.mockReturnValue({ status: 'authenticated' })
    const { result } = renderHook(() => useOnboardingProfile())
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.profile).toMatchObject({ targetRole: 'pm', experienceLevel: '3-6' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('serves a second hook consumer from the TTL cache (no second fetch)', async () => {
    mockUseSession.mockReturnValue({ status: 'authenticated' })

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
    mockUseSession.mockReturnValue({ status: 'authenticated' })
    const { result } = renderHook(() => useOnboardingProfile())
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.profile).toBeNull()
  })

  it('returns ready with null profile when /api/onboarding 401s', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) } as Response)
    mockUseSession.mockReturnValue({ status: 'authenticated' })
    const { result } = renderHook(() => useOnboardingProfile())
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.profile).toBeNull()
  })
})
