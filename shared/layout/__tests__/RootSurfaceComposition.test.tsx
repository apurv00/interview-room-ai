import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import RootSurfaceComposition from '../../../app/_components/RootSurfaceComposition'

const navigation = vi.hoisted(() => ({ pathname: '/' }))

vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
}))
vi.mock('@vercel/speed-insights/next', () => ({
  SpeedInsights: () => <span data-testid="speed-insights" />,
}))
vi.mock('@shared/analytics/AnalyticsProvider', () => ({
  AnalyticsProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="analytics-provider">{children}</div>
  ),
}))
vi.mock('@shared/analytics/GoogleAnalyticsScripts', () => ({
  GoogleAnalyticsScripts: () => <span data-testid="ga-scripts" />,
}))
vi.mock('@shared/providers/AuthGateProvider', () => ({
  AuthGateProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="auth-gate-provider">{children}</div>
  ),
}))
vi.mock('@shared/providers/ThemeProvider', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('@shared/providers/SessionProvider', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="session-provider">{children}</div>
  ),
}))
vi.mock('@shared/providers/XpProvider', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="xp-provider">{children}</div>
  ),
}))
vi.mock('@shared/layout/AppShell', () => ({
  default: ({
    children,
    navAuthExtras,
    authedGlobalWidgets,
  }: {
    children: React.ReactNode
    navAuthExtras?: React.ReactNode
    authedGlobalWidgets?: React.ReactNode
  }) => (
    <div data-testid="app-shell">
      {navAuthExtras}
      {children}
      {authedGlobalWidgets}
    </div>
  ),
}))
vi.mock('@learn/components/XpBadge', () => ({
  default: () => <span data-testid="xp-badge" />,
}))
vi.mock('@learn/components/BadgeUnlockChecker', () => ({
  default: () => <span data-testid="badge-unlock-checker" />,
}))

afterEach(cleanup)

function renderComposition(deploymentSurface: 'b2c' | 'hire-control' | 'hire-runtime') {
  return render(
    <RootSurfaceComposition deploymentSurface={deploymentSurface} gaId="G-TEST" enableSpeedInsights>
      <main>surface-content</main>
    </RootSurfaceComposition>,
  )
}

function expectB2cCompositionAbsent() {
  expect(screen.queryByTestId('analytics-provider')).toBeNull()
  expect(screen.queryByTestId('app-shell')).toBeNull()
  expect(screen.queryByTestId('xp-provider')).toBeNull()
  expect(screen.queryByTestId('xp-badge')).toBeNull()
  expect(screen.queryByTestId('badge-unlock-checker')).toBeNull()
  expect(screen.queryByTestId('speed-insights')).toBeNull()
  expect(screen.queryByTestId('ga-scripts')).toBeNull()
}

describe('RootSurfaceComposition', () => {
  it('renders no B2C chrome, widgets, or analytics on a control-plane path', () => {
    navigation.pathname = '/workspace/jobs'
    renderComposition('b2c')

    expect(screen.getByText('surface-content')).toBeTruthy()
    expectB2cCompositionAbsent()
    expect(screen.getByTestId('session-provider')).toBeTruthy()
  })

  it.each([
    '/candidate/round-id',
    '/candidate/privacy/opaque',
    '/apply/token',
    '/interview-kit/kit-id',
    '/candidate-status/link-id',
  ])(
    'does not hydrate any B2C session on public Hire capability path %s',
    (pathname) => {
      navigation.pathname = pathname
      renderComposition('hire-control')

      expect(screen.getByText('surface-content')).toBeTruthy()
      expect(screen.queryByTestId('session-provider')).toBeNull()
      expect(screen.queryByTestId('auth-gate-provider')).toBeNull()
      expectB2cCompositionAbsent()
    },
  )

  it('renders no B2C chrome, widgets, or analytics anywhere on the runtime', () => {
    navigation.pathname = '/lobby'
    renderComposition('hire-runtime')

    expect(screen.getByText('surface-content')).toBeTruthy()
    expectB2cCompositionAbsent()
    expect(screen.getByTestId('session-provider')).toBeTruthy()
    expect(screen.getByTestId('auth-gate-provider')).toBeTruthy()
  })

  it('preserves the complete B2C composition on the consumer lobby', () => {
    navigation.pathname = '/lobby'
    renderComposition('b2c')

    expect(screen.getByTestId('analytics-provider')).toBeTruthy()
    expect(screen.getByTestId('app-shell')).toBeTruthy()
    expect(screen.getByTestId('xp-provider')).toBeTruthy()
    expect(screen.getByTestId('xp-badge')).toBeTruthy()
    expect(screen.getByTestId('badge-unlock-checker')).toBeTruthy()
    expect(screen.getByTestId('speed-insights')).toBeTruthy()
    expect(screen.getByTestId('ga-scripts')).toBeTruthy()
    expect(screen.getByTestId('session-provider')).toBeTruthy()
    expect(screen.getByTestId('auth-gate-provider')).toBeTruthy()
  })

  it('keeps the separate legacy B2C candidate thank-you session-backed', () => {
    navigation.pathname = '/candidate/thank-you'
    renderComposition('b2c')
    expect(screen.getByTestId('session-provider')).toBeTruthy()
  })
})
