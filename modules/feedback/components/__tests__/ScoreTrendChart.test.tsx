import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import ScoreTrendChart from '../ScoreTrendChart'

function errorResponse(body: unknown, status = 401) {
  return {
    ok: false,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

describe('ScoreTrendChart account boundary', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('reports an exact account-unavailable response to its parent', async () => {
    const onAccountUnavailable = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(errorResponse({ code: 'ACCOUNT_UNAVAILABLE' })),
    )

    render(
      <ScoreTrendChart
        currentScore={75}
        sessionId="sess_current"
        onAccountUnavailable={onAccountUnavailable}
      />,
    )

    await waitFor(() => expect(onAccountUnavailable).toHaveBeenCalledOnce())
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not report a generic 401 as account deletion', async () => {
    const onAccountUnavailable = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(errorResponse({ error: 'Unauthorized' })),
    )

    render(
      <ScoreTrendChart
        currentScore={75}
        sessionId="sess_current"
        onAccountUnavailable={onAccountUnavailable}
      />,
    )

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(onAccountUnavailable).not.toHaveBeenCalled()
  })
})
