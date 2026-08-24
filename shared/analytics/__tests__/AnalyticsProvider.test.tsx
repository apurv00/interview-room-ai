import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { AnalyticsProvider } from '@shared/analytics/AnalyticsProvider'

const trackMock = vi.fn()
const identifyMock = vi.fn()
vi.mock('@shared/analytics/track', async (importOriginal) => ({
  // Real redaction, mocked emitters: the provider must be exercised with
  // the ACTUAL redactor so a regression that leaks a tokenized path fails
  // here rather than in production analytics.
  ...(await importOriginal<typeof import('@shared/analytics/track')>()),
  track: (...args: unknown[]) => trackMock(...args),
  identify: (...args: unknown[]) => identifyMock(...args),
}))

let mockPathname = '/'
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}))

interface MockSession {
  user?: {
    id: string
    plan?: string
    role?: string
    organizationId?: string
    email?: string
    name?: string
    image?: string
  } | null
}
let mockStatus: 'loading' | 'unauthenticated' | 'authenticated' = 'unauthenticated'
let mockSessionData: MockSession = { user: null }
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: mockSessionData, status: mockStatus }),
}))

describe('AnalyticsProvider', () => {
  beforeEach(() => {
    trackMock.mockReset()
    identifyMock.mockReset()
    mockPathname = '/'
    mockStatus = 'unauthenticated'
    mockSessionData = { user: null }
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fires page_view on initial render with the current pathname', () => {
    mockPathname = '/lobby'
    render(<AnalyticsProvider><div /></AnalyticsProvider>)

    expect(trackMock).toHaveBeenCalledWith('page_view', { pathname: '/lobby' })
  })

  it('fires page_view again when pathname changes (App Router navigation)', () => {
    mockPathname = '/'
    const { rerender } = render(
      <AnalyticsProvider><div /></AnalyticsProvider>
    )
    expect(trackMock).toHaveBeenCalledWith('page_view', { pathname: '/' })

    mockPathname = '/feedback/abc'
    rerender(<AnalyticsProvider><div /></AnalyticsProvider>)

    expect(trackMock).toHaveBeenCalledWith('page_view', {
      pathname: '/feedback/abc',
    })
  })

  it('calls identify() once when an authenticated session lands, with non-PII traits only', () => {
    mockStatus = 'authenticated'
    mockSessionData = {
      user: {
        id: 'user_42',
        plan: 'pro',
        role: 'candidate',
        organizationId: 'org_x',
        // PII fields included on the session — must NOT be forwarded:
        email: 'leaked@example.com',
        name: 'Leak Name',
        image: 'https://example.com/avatar.png',
      },
    }

    render(<AnalyticsProvider><div /></AnalyticsProvider>)

    expect(identifyMock).toHaveBeenCalledTimes(1)
    const [userId, traits] = identifyMock.mock.calls[0]
    expect(userId).toBe('user_42')
    expect(traits).toEqual({
      plan: 'pro',
      role: 'candidate',
      organizationId: 'org_x',
    })
    expect(traits).not.toHaveProperty('email')
    expect(traits).not.toHaveProperty('name')
    expect(traits).not.toHaveProperty('image')
  })

  it.each(['recruiter', 'org_admin', 'unknown_role'])(
    'does not identify retired or unknown %s roles as persistent traits',
    (role) => {
      mockStatus = 'authenticated'
      mockSessionData = {
        user: {
          id: `user_${role}`,
          plan: 'free',
          role,
        },
      }

      render(<AnalyticsProvider><div /></AnalyticsProvider>)

      expect(identifyMock).toHaveBeenCalledTimes(1)
      expect(identifyMock.mock.calls[0][1]).toEqual({
        plan: 'free',
        organizationId: undefined,
      })
    },
  )

  it('does NOT fire signin_succeeded on a page reload of an already-authed session', () => {
    // Provider mounts with status === 'authenticated' on first render —
    // there's no unauth → auth transition, so only identify() fires.
    mockStatus = 'authenticated'
    mockSessionData = { user: { id: 'user_42', plan: 'free' } }

    render(<AnalyticsProvider><div /></AnalyticsProvider>)

    expect(identifyMock).toHaveBeenCalledTimes(1)
    const signinCalls = trackMock.mock.calls.filter(
      ([event]) => event === 'signin_succeeded'
    )
    expect(signinCalls).toHaveLength(0)
  })

  it('fires signin_succeeded exactly once on the unauth → auth transition', () => {
    mockStatus = 'unauthenticated'
    mockSessionData = { user: null }
    const { rerender } = render(<AnalyticsProvider><div /></AnalyticsProvider>)

    expect(identifyMock).not.toHaveBeenCalled()

    mockStatus = 'authenticated'
    mockSessionData = { user: { id: 'user_99', plan: 'free' } }
    rerender(<AnalyticsProvider><div /></AnalyticsProvider>)

    expect(identifyMock).toHaveBeenCalledTimes(1)
    const signinCalls = trackMock.mock.calls.filter(
      ([event]) => event === 'signin_succeeded'
    )
    expect(signinCalls).toHaveLength(1)
    expect(signinCalls[0][1]).toEqual({ had_prior_session: false })
  })

  it('marks had_prior_session: true when localStorage already holds a non-anon distinct_id', () => {
    // Simulate a returning user: previously identified, signed out, signing in again.
    window.localStorage.setItem('ipg_distinct_id', 'user_99')

    mockStatus = 'unauthenticated'
    mockSessionData = { user: null }
    const { rerender } = render(<AnalyticsProvider><div /></AnalyticsProvider>)

    mockStatus = 'authenticated'
    mockSessionData = { user: { id: 'user_99', plan: 'free' } }
    rerender(<AnalyticsProvider><div /></AnalyticsProvider>)

    const signinCalls = trackMock.mock.calls.filter(
      ([event]) => event === 'signin_succeeded'
    )
    expect(signinCalls).toHaveLength(1)
    expect(signinCalls[0][1]).toEqual({ had_prior_session: true })
  })

  it('does not re-identify when re-rendered with the same user.id', () => {
    mockStatus = 'authenticated'
    mockSessionData = { user: { id: 'user_42' } }
    const { rerender } = render(<AnalyticsProvider><div /></AnalyticsProvider>)

    expect(identifyMock).toHaveBeenCalledTimes(1)

    // Re-render with the same session reference — identify must not refire.
    rerender(<AnalyticsProvider><div /></AnalyticsProvider>)
    expect(identifyMock).toHaveBeenCalledTimes(1)
  })

  it('re-identifies the same user after a confirmed sign-out and tracks the new sign-in', () => {
    window.localStorage.setItem('ipg_distinct_id', 'user_42')
    mockStatus = 'authenticated'
    mockSessionData = { user: { id: 'user_42', plan: 'free' } }
    const { rerender } = render(<AnalyticsProvider><div /></AnalyticsProvider>)

    expect(identifyMock).toHaveBeenCalledTimes(1)
    expect(
      trackMock.mock.calls.filter(([event]) => event === 'signin_succeeded')
    ).toHaveLength(0)

    mockStatus = 'unauthenticated'
    mockSessionData = { user: null }
    rerender(<AnalyticsProvider><div /></AnalyticsProvider>)

    mockStatus = 'authenticated'
    mockSessionData = { user: { id: 'user_42', plan: 'free' } }
    rerender(<AnalyticsProvider><div /></AnalyticsProvider>)

    expect(identifyMock).toHaveBeenCalledTimes(2)
    const signinCalls = trackMock.mock.calls.filter(
      ([event]) => event === 'signin_succeeded'
    )
    expect(signinCalls).toHaveLength(1)
    expect(signinCalls[0][1]).toEqual({ had_prior_session: true })
  })

  it('renders children unchanged', () => {
    const { getByText } = render(
      <AnalyticsProvider>
        <span>child-content</span>
      </AnalyticsProvider>
    )
    expect(getByText('child-content')).toBeTruthy()
  })
})


describe('tokenized routes never reach analytics in cleartext', () => {
  it('emits a redacted pathname for /apply/<token>', async () => {
    mockPathname = `/apply/${'a'.repeat(64)}`
    render(<AnalyticsProvider>{null}</AnalyticsProvider>)
    const pageViews = trackMock.mock.calls.filter((c) => c[0] === 'page_view')
    const props = pageViews[pageViews.length - 1]?.[1] as { pathname: string }
    expect(props.pathname).toBe('/apply/[redacted]')
    expect(props.pathname).not.toContain('aaaa')
  })
})
