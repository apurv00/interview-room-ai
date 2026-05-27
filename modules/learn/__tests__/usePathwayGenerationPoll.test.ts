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
})
