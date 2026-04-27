import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const POSTHOG_HOST = 'https://us.i.posthog.com'

type GtagMock = ReturnType<typeof vi.fn>
type FetchMock = ReturnType<typeof vi.fn>

describe('shared/analytics/track', () => {
  const originalEnv = process.env
  let gtag: GtagMock
  let fetchMock: FetchMock

  beforeEach(() => {
    vi.resetModules()
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_POSTHOG_KEY: 'phc_test',
      NEXT_PUBLIC_GA_MEASUREMENT_ID: 'G-TEST',
    }

    gtag = vi.fn()
    ;(window as unknown as { gtag: GtagMock }).gtag = gtag

    fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    window.localStorage.clear()
    window.history.pushState({}, '', '/')
  })

  afterEach(() => {
    process.env = originalEnv
    delete (window as unknown as { gtag?: GtagMock }).gtag
    vi.unstubAllGlobals()
  })

  describe('track()', () => {
    it('fans out to BOTH PostHog and GA when both are configured', async () => {
      const { track } = await import('@shared/analytics/track')
      track('cta_clicked', { cta: 'start_interview', location: 'home' })

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls[0][0]).toBe(`${POSTHOG_HOST}/capture/`)

      expect(gtag).toHaveBeenCalledTimes(1)
      expect(gtag).toHaveBeenCalledWith(
        'event',
        'cta_clicked',
        expect.objectContaining({ cta: 'start_interview', location: 'home' })
      )
    })

    it('does not call gtag when window.gtag is undefined (PostHog still fires)', async () => {
      delete (window as unknown as { gtag?: GtagMock }).gtag

      const { track } = await import('@shared/analytics/track')
      expect(() => track('cta_clicked', {})).not.toThrow()
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('skips GA dispatch on /cms admin routes (PostHog still fires)', async () => {
      window.history.pushState({}, '', '/cms/domains')

      const { track } = await import('@shared/analytics/track')
      track('admin_action', { from: 'domain_editor' })

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(gtag).not.toHaveBeenCalled()
    })

    it('skips GA dispatch on /hire admin routes', async () => {
      window.history.pushState({}, '', '/hire/candidates/abc123')

      const { track } = await import('@shared/analytics/track')
      track('candidate_viewed', {})

      expect(gtag).not.toHaveBeenCalled()
    })

    it('still fires GA on routes that merely contain admin prefix mid-path', async () => {
      // /hires-something is not /hire — guard against startsWith without
      // trailing-slash discipline.
      window.history.pushState({}, '', '/hireling-news')

      const { track } = await import('@shared/analytics/track')
      track('candidate_viewed', {})

      expect(gtag).toHaveBeenCalledTimes(1)
    })

    it('strips undefined props before sending to GA', async () => {
      const { track } = await import('@shared/analytics/track')
      track('event_name', { a: 1, b: undefined, c: 'kept' })

      const props = gtag.mock.calls[0][2] as Record<string, unknown>
      expect(props).toEqual({ a: 1, c: 'kept' })
    })

    it('truncates GA string props longer than 500 chars', async () => {
      const long = 'x'.repeat(600)
      const { track } = await import('@shared/analytics/track')
      track('event_name', { long })

      const props = gtag.mock.calls[0][2] as Record<string, string>
      expect(props.long).toHaveLength(500)
    })

    it('still dispatches to GA when PostHog key is unset', async () => {
      delete process.env.NEXT_PUBLIC_POSTHOG_KEY

      const { track } = await import('@shared/analytics/track')
      track('event_name', {})

      expect(fetchMock).not.toHaveBeenCalled()
      expect(gtag).toHaveBeenCalledTimes(1)
    })

    it('does not throw if window.gtag itself throws', async () => {
      gtag.mockImplementation(() => {
        throw new Error('gtag boom')
      })

      const { track } = await import('@shared/analytics/track')
      expect(() => track('event_name', {})).not.toThrow()
    })
  })

  describe('identify()', () => {
    it('calls gtag config with user_id when both GA id and gtag are present', async () => {
      const { identify } = await import('@shared/analytics/track')
      identify('user_123', { plan: 'pro' })

      expect(gtag).toHaveBeenCalledWith('config', 'G-TEST', { user_id: 'user_123' })
    })

    it('does not call gtag when GA measurement id is unset', async () => {
      delete process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID

      const { identify } = await import('@shared/analytics/track')
      identify('user_123', {})

      expect(gtag).not.toHaveBeenCalled()
    })

    it('does not call gtag when window.gtag is undefined', async () => {
      delete (window as unknown as { gtag?: GtagMock }).gtag

      const { identify } = await import('@shared/analytics/track')
      expect(() => identify('user_123', {})).not.toThrow()
    })
  })
})
