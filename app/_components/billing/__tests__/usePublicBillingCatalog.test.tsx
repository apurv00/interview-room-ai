import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONSUMER_CATALOG_V1 } from '@shared/services/planConfig'
import {
  BILLING_REQUEST_TIMEOUT_MS,
} from '../billingRequestTimeout'
import {
  HOMEPAGE_CATALOG_CACHE_TTL_MS,
  _resetPublicBillingCatalogCache,
  usePublicBillingCatalog,
  type PublicBillingCatalogOptions,
} from '../usePublicBillingCatalog'

const catalogV1 = {
  ...CONSUMER_CATALOG_V1,
  catalogVersion: 'catalog-cache-v1',
  effectiveAt: '2026-08-22T00:00:00.000Z',
  customerBillingUiReady: true,
  checkoutRequiresAuthentication: true,
}

const catalogV2 = {
  ...catalogV1,
  catalogVersion: 'catalog-cache-v2',
}

const catalogV3 = {
  ...catalogV1,
  catalogVersion: 'catalog-cache-v3',
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function CatalogState({
  cachePolicy,
}: PublicBillingCatalogOptions = {}) {
  const { catalog, error, loading, reload } = usePublicBillingCatalog({
    cachePolicy,
  })
  return (
    <>
      <output data-testid="catalog-state">
        {loading
          ? 'loading'
          : error ?? catalog?.catalogVersion ?? 'missing'}
      </output>
      <button type="button" onClick={reload}>reload</button>
    </>
  )
}

afterEach(() => {
  cleanup()
  _resetPublicBillingCatalogCache()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
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

    const view = render(<CatalogState cachePolicy="homepage-memory" />)
    expect(requestSignal?.aborted).toBe(false)

    view.unmount()

    expect(requestSignal?.aborted).toBe(true)
  })

  it('reuses one parsed homepage catalog within the hard TTL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(catalogV1))
    vi.stubGlobal('fetch', fetchMock)

    const first = render(
      <CatalogState cachePolicy="homepage-memory" />,
    )
    expect(await screen.findByText('catalog-cache-v1')).toBeInTheDocument()
    first.unmount()

    render(<CatalogState cachePolicy="homepage-memory" />)

    expect(screen.getByTestId('catalog-state')).toHaveTextContent(
      'catalog-cache-v1',
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not render an expired cached catalog while refreshing', async () => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(catalogV1))
      .mockResolvedValueOnce(response(catalogV2))
    vi.stubGlobal('fetch', fetchMock)

    const first = render(
      <CatalogState cachePolicy="homepage-memory" />,
    )
    expect(await screen.findByText('catalog-cache-v1')).toBeInTheDocument()
    first.unmount()
    now += HOMEPAGE_CATALOG_CACHE_TTL_MS + 1

    render(<CatalogState cachePolicy="homepage-memory" />)

    expect(screen.getByTestId('catalog-state')).toHaveTextContent('loading')
    expect(await screen.findByText('catalog-cache-v2')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('foreground-refreshes a mounted catalog across consecutive TTLs', async () => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(catalogV1))
      .mockResolvedValueOnce(response(catalogV2))
      .mockResolvedValueOnce(response(catalogV3))
    vi.stubGlobal('fetch', fetchMock)

    render(<CatalogState cachePolicy="homepage-memory" />)
    expect(await screen.findByText('catalog-cache-v1')).toBeInTheDocument()

    now += HOMEPAGE_CATALOG_CACHE_TTL_MS + 1
    act(() => {
      fireEvent(window, new Event('pageshow'))
    })

    expect(screen.getByTestId('catalog-state')).toHaveTextContent('loading')
    expect(await screen.findByText('catalog-cache-v2')).toBeInTheDocument()

    now += HOMEPAGE_CATALOG_CACHE_TTL_MS + 1
    act(() => {
      fireEvent(window, new Event('pageshow'))
    })

    expect(screen.getByTestId('catalog-state')).toHaveTextContent('loading')
    expect(await screen.findByText('catalog-cache-v3')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('never caches failed or malformed catalog responses', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ error: 'unavailable' }, 503))
      .mockResolvedValueOnce(response({ catalogVersion: 'malformed' }))
      .mockResolvedValueOnce(response(catalogV1))
    vi.stubGlobal('fetch', fetchMock)

    const unavailable = render(
      <CatalogState cachePolicy="homepage-memory" />,
    )
    expect(await screen.findByText('unavailable')).toBeInTheDocument()
    unavailable.unmount()

    const malformed = render(
      <CatalogState cachePolicy="homepage-memory" />,
    )
    expect(await screen.findByText(
      'Billing returned an unexpected response. Please try again.',
    )).toBeInTheDocument()
    malformed.unmount()

    render(<CatalogState cachePolicy="homepage-memory" />)
    expect(await screen.findByText('catalog-cache-v1')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('evicts the homepage cache on explicit reload', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(catalogV1))
      .mockResolvedValueOnce(response(catalogV2))
    vi.stubGlobal('fetch', fetchMock)

    render(<CatalogState cachePolicy="homepage-memory" />)
    expect(await screen.findByText('catalog-cache-v1')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'reload' }))

    expect(screen.getByTestId('catalog-state')).toHaveTextContent('loading')
    expect(await screen.findByText('catalog-cache-v2')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps the Pricing page network-authoritative despite a warm homepage cache', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(catalogV1))
      .mockResolvedValueOnce(response(catalogV2))
    vi.stubGlobal('fetch', fetchMock)

    const homepage = render(
      <CatalogState cachePolicy="homepage-memory" />,
    )
    expect(await screen.findByText('catalog-cache-v1')).toBeInTheDocument()
    homepage.unmount()

    render(<CatalogState />)

    expect(screen.getByTestId('catalog-state')).toHaveTextContent('loading')
    expect(await screen.findByText('catalog-cache-v2')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('prevents an older delayed body from overwriting a forced refresh', async () => {
    let resolveOldBody: ((body: unknown) => void) | undefined
    const oldResponse = {
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: vi.fn(() => new Promise<unknown>((resolve) => {
        resolveOldBody = resolve
      })),
    } as unknown as Response
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(oldResponse)
      .mockResolvedValueOnce(response(catalogV2))
    vi.stubGlobal('fetch', fetchMock)

    const view = render(
      <CatalogState cachePolicy="homepage-memory" />,
    )
    await waitFor(() => {
      expect(resolveOldBody).toBeTypeOf('function')
    })

    fireEvent.click(screen.getByRole('button', { name: 'reload' }))
    expect(await screen.findByText('catalog-cache-v2')).toBeInTheDocument()

    await act(async () => {
      resolveOldBody?.(catalogV1)
      await Promise.resolve()
    })
    expect(screen.getByTestId('catalog-state')).toHaveTextContent(
      'catalog-cache-v2',
    )
    view.unmount()

    render(<CatalogState cachePolicy="homepage-memory" />)
    expect(screen.getByTestId('catalog-state')).toHaveTextContent(
      'catalog-cache-v2',
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
