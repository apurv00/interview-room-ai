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
      track('cta_clicked', { cta: 'start', location: 'cms_home' })

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(gtag).not.toHaveBeenCalled()
    })

    it('skips GA dispatch on /workspace admin routes', async () => {
      window.history.pushState({}, '', '/workspace/applications/abc123')

      const { track } = await import('@shared/analytics/track')
      track('cta_clicked', { cta: 'view', location: 'hire_candidate' })

      expect(gtag).not.toHaveBeenCalled()
    })

    it('still fires GA on routes that merely contain admin prefix mid-path', async () => {
      // /workspaces-something is not /workspace — guard against startsWith
      // without trailing-slash discipline.
      window.history.pushState({}, '', '/workspaces-news')

      const { track } = await import('@shared/analytics/track')
      track('cta_clicked', { cta: 'start', location: 'news' })

      expect(gtag).toHaveBeenCalledTimes(1)
    })

    it('strips undefined props before sending to GA', async () => {
      const { track } = await import('@shared/analytics/track')
      // audio_worklet_loaded has optional error/stale — useful for
      // exercising the sanitize-undefined path.
      track('audio_worklet_loaded', {
        success: true,
        durationMs: 42,
        error: undefined,
        stale: true,
      })

      const props = gtag.mock.calls[0][2] as Record<string, unknown>
      expect(props).toEqual({ success: true, durationMs: 42, stale: true })
      expect(props).not.toHaveProperty('error')
    })

    it('truncates GA string props longer than 500 chars', async () => {
      const long = 'x'.repeat(600)
      const { track } = await import('@shared/analytics/track')
      track('audio_worklet_loaded', {
        success: false,
        durationMs: 99,
        error: long,
      })

      const props = gtag.mock.calls[0][2] as Record<string, string>
      expect(props.error).toHaveLength(500)
    })

    it('still dispatches to GA when PostHog key is unset', async () => {
      delete process.env.NEXT_PUBLIC_POSTHOG_KEY

      const { track } = await import('@shared/analytics/track')
      track('page_view', { pathname: '/' })

      expect(fetchMock).not.toHaveBeenCalled()
      expect(gtag).toHaveBeenCalledTimes(1)
    })

    it('does not throw if window.gtag itself throws', async () => {
      gtag.mockImplementation(() => {
        throw new Error('gtag boom')
      })

      const { track } = await import('@shared/analytics/track')
      expect(() => track('page_view', { pathname: '/' })).not.toThrow()
    })

    it('rejects unregistered event names at compile time', async () => {
      const { track } = await import('@shared/analytics/track')
      // @ts-expect-error - 'totally_made_up' is not in EVENT_NAMES; the
      // typed signature must reject it.
      track('totally_made_up', {})
      // No runtime assertion — the assertion is the @ts-expect-error
      // succeeding at typecheck. We still call track to keep the lint
      // happy (the variable is used).
    })

    it('rejects wrong-shape properties for a registered event', async () => {
      const { track } = await import('@shared/analytics/track')
      // @ts-expect-error - cta_clicked requires { cta, location }; missing
      // 'location' is a shape mismatch.
      track('cta_clicked', { cta: 'x' })
      // @ts-expect-error - 'pathname' is required for page_view.
      track('page_view', {})
    })
  })

  describe('identify()', () => {
    it('uses gtag set (not config) to avoid retriggering automatic pageviews', async () => {
      const { identify } = await import('@shared/analytics/track')
      identify('user_123', {})

      // Must use 'set' — calling 'config' a second time would refire
      // automatic pageviews even after the loader disabled them.
      expect(gtag).toHaveBeenCalledWith('set', { user_id: 'user_123' })
      const configCalls = gtag.mock.calls.filter((args) => args[0] === 'config')
      expect(configCalls).toHaveLength(0)
    })

    it('sets user properties from traits via gtag set/user_properties', async () => {
      const { identify } = await import('@shared/analytics/track')
      identify('user_123', {
        plan: 'pro',
        role: 'candidate',
      })

      expect(gtag).toHaveBeenCalledWith('set', { user_id: 'user_123' })
      expect(gtag).toHaveBeenCalledWith('set', 'user_properties', {
        plan: 'pro',
        role: 'candidate',
      })
    })

    it('rejects PII fields on the UserTraits type at compile time', async () => {
      const { identify } = await import('@shared/analytics/track')
      // @ts-expect-error - email is PII and must not be a UserTraits key.
      identify('user_123', { email: 'a@b.com' })
      // @ts-expect-error - name is PII.
      identify('user_123', { name: 'Alex Chen' })
    })

    it('skips the user_properties call when traits is empty', async () => {
      const { identify } = await import('@shared/analytics/track')
      identify('user_123', {})

      const userPropCalls = gtag.mock.calls.filter(
        (args) => args[0] === 'set' && args[1] === 'user_properties'
      )
      expect(userPropCalls).toHaveLength(0)
    })

    it('does not call gtag when window.gtag is undefined', async () => {
      delete (window as unknown as { gtag?: GtagMock }).gtag

      const { identify } = await import('@shared/analytics/track')
      expect(() => identify('user_123', {})).not.toThrow()
    })
  })

  describe('resetAnalyticsIdentity()', () => {
    it('drops the persisted PostHog identity and clears GA user context', async () => {
      window.localStorage.setItem('ipg_distinct_id', 'user_123')

      const { resetAnalyticsIdentity } = await import('@shared/analytics/track')
      resetAnalyticsIdentity()

      expect(window.localStorage.getItem('ipg_distinct_id')).toBeNull()
      expect(gtag).toHaveBeenCalledWith('set', { user_id: null })
      expect(gtag).toHaveBeenCalledWith('set', 'user_properties', {
        plan: null,
        role: null,
        organizationId: null,
      })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('still clears persisted identity when GA is unavailable', async () => {
      window.localStorage.setItem('ipg_distinct_id', 'user_123')
      delete (window as unknown as { gtag?: GtagMock }).gtag

      const { resetAnalyticsIdentity } = await import('@shared/analytics/track')

      expect(() => resetAnalyticsIdentity()).not.toThrow()
      expect(window.localStorage.getItem('ipg_distinct_id')).toBeNull()
    })
  })
})
