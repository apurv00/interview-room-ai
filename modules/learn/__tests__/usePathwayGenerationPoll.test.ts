import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { usePathwayGenerationPoll } from '../hooks/usePathwayGenerationPoll'

const SESSION_ID = '507f1f77bcf86cd799439011'

function pendingPollResponse() {
  return {
    state: 'pending',
    pathwayUpdate: { poll: true, reason: 'pathway_in_flight' },
    pathway: { generatedFromSessionId: null },
  }
}

describe('usePathwayGenerationPoll', () => {
  beforeEach(() => {
    let dateNowCalls = 0
    vi.spyOn(Date, 'now').mockImplementation(() => {
      dateNowCalls++
      if (dateNowCalls === 1) return 1000
      return 1000 + 121_000
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => pendingPollResponse(),
      }),
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('restarts polling when pollEpoch bumps after exhaustion', async () => {
    const onRefresh = vi.fn()
    const { result, rerender } = renderHook(
      ({ pollEpoch }) =>
        usePathwayGenerationPoll({
          sessionId: SESSION_ID,
          enabled: true,
          onRefresh,
          pollEpoch,
        }),
      { initialProps: { pollEpoch: 0 } },
    )

    await waitFor(() => expect(result.current.pollExhausted).toBe(true))

    rerender({ pollEpoch: 1 })

    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.pollExhausted).toBe(false)
    expect(result.current.phase).toBe('polling')
  })

  it('enters done phase when pathway generation completes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          state: 'success',
          pathwayUpdate: { poll: false, reason: 'pathway_succeeded' },
          pathway: { generatedFromSessionId: SESSION_ID },
        }),
      }),
    )

    const { result } = renderHook(() =>
      usePathwayGenerationPoll({
        sessionId: SESSION_ID,
        enabled: true,
        onRefresh: vi.fn(),
      }),
    )

    await waitFor(() => expect(result.current.phase).toBe('done'))
  })

  it('reports exact account deletion and stops polling immediately', async () => {
    const onAccountUnavailable = vi.fn()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ code: 'ACCOUNT_UNAVAILABLE' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() =>
      usePathwayGenerationPoll({
        sessionId: SESSION_ID,
        enabled: true,
        onRefresh: vi.fn(),
        onAccountUnavailable,
      }),
    )

    await waitFor(() => expect(result.current.phase).toBe('done'))
    expect(onAccountUnavailable).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  // The three cases below pin the budget fix: before it, the 120s check only
  // ran on ok-and-pending responses, so persistent non-OK responses and thrown
  // fetches polled every 3s for the tab's lifetime (~28,800 requests/night on
  // an expired-auth tab left open).

  it('exhausts within the budget on persistent non-OK responses (was: infinite loop)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }),
    )

    const { result } = renderHook(() =>
      usePathwayGenerationPoll({
        sessionId: SESSION_ID,
        enabled: true,
        onRefresh: vi.fn(),
      }),
    )

    await waitFor(() => expect(result.current.pollExhausted).toBe(true))
  })

  it('exhausts within the budget when fetch rejects (offline tab)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))

    const { result } = renderHook(() =>
      usePathwayGenerationPoll({
        sessionId: SESSION_ID,
        enabled: true,
        onRefresh: vi.fn(),
      }),
    )

    await waitFor(() => expect(result.current.pollExhausted).toBe(true))
  })

  it('a success landing past the budget still resolves done, not exhausted', async () => {
    // Date.now is already mocked past the 120s budget after the first call;
    // the success classification must win because it runs before the budget check.
    const onRefresh = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          state: 'success',
          pathwayUpdate: { poll: false, reason: 'pathway_succeeded' },
          pathway: { generatedFromSessionId: SESSION_ID },
        }),
      }),
    )

    const { result } = renderHook(() =>
      usePathwayGenerationPoll({
        sessionId: SESSION_ID,
        enabled: true,
        onRefresh,
      }),
    )

    await waitFor(() => expect(result.current.phase).toBe('done'))
    expect(onRefresh).toHaveBeenCalled()
  })
})
