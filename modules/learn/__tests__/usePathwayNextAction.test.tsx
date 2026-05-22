import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { usePathwayNextAction } from '@learn/hooks/usePathwayNextAction'

const mockUseSession = vi.fn()
vi.mock('next-auth/react', () => ({
  useSession: () => mockUseSession(),
}))

describe('usePathwayNextAction', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
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
    mockUseSession.mockReturnValue({ status: 'authenticated' })
    const { result } = renderHook(() => usePathwayNextAction())
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.state).toBe('active')
    expect(result.current.nextAction?.title).toContain('Lesson 2')
    expect(result.current.pathway?.readinessScore).toBe(62)
  })

  it('shares one network call between two concurrent consumers (deduplicatedFetch)', async () => {
    mockUseSession.mockReturnValue({ status: 'authenticated' })
    const a = renderHook(() => usePathwayNextAction())
    const b = renderHook(() => usePathwayNextAction())
    await waitFor(() => {
      expect(a.result.current.status).toBe('ready')
      expect(b.result.current.status).toBe('ready')
    })
    // Both hooks resolved; only ONE actual fetch fired (in-flight dedup).
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('reports "error" when the fetch rejects', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('boom'))
    mockUseSession.mockReturnValue({ status: 'authenticated' })
    const { result } = renderHook(() => usePathwayNextAction())
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.nextAction).toBeNull()
  })
})
