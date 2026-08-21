import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BILLING_REQUEST_TIMEOUT_MS,
} from '../billingRequestTimeout'
import { usePublicBillingCatalog } from '../usePublicBillingCatalog'

function CatalogState() {
  const { catalog, error, loading } = usePublicBillingCatalog()
  return (
    <output data-testid="catalog-state">
      {loading
        ? 'loading'
        : error ?? catalog?.catalogVersion ?? 'missing'}
    </output>
  )
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('usePublicBillingCatalog request lifecycle', () => {
  it('uses the standard billing timeout and preserves the pricing error message', async () => {
    vi.useFakeTimers()
    let requestSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      requestSignal = init?.signal ?? undefined
      return new Promise<Response>(() => {})
    }))

    render(<CatalogState />)
    expect(screen.getByTestId('catalog-state')).toHaveTextContent('loading')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BILLING_REQUEST_TIMEOUT_MS)
    })

    expect(requestSignal?.aborted).toBe(true)
    expect(screen.getByTestId('catalog-state')).toHaveTextContent(
      'Pricing is temporarily unavailable.',
    )
  })

  it('cancels the timed request when the catalog consumer unmounts', () => {
    let requestSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      requestSignal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        }, { once: true })
      })
    }))

    const view = render(<CatalogState />)
    expect(requestSignal?.aborted).toBe(false)

    view.unmount()

    expect(requestSignal?.aborted).toBe(true)
  })
})
