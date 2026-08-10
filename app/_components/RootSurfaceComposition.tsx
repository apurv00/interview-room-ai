'use client'

import type { ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { SpeedInsights } from '@vercel/speed-insights/next'
import { AnalyticsProvider } from '@shared/analytics/AnalyticsProvider'
import { GoogleAnalyticsScripts } from '@shared/analytics/GoogleAnalyticsScripts'
import { AuthGateProvider } from '@shared/providers/AuthGateProvider'
import { ThemeProvider } from '@shared/providers/ThemeProvider'
import SessionProvider from '@shared/providers/SessionProvider'
import XpProvider from '@shared/providers/XpProvider'
import AppShell from '@shared/layout/AppShell'
import XpBadge from '@learn/components/XpBadge'
import BadgeUnlockChecker from '@learn/components/BadgeUnlockChecker'
import {
  isHireIsolatedSurface,
  isHirePublicSessionlessPath,
  resolveDeploymentSurface,
  type DeploymentSurface,
} from '@shared/surfaces/hireSurfaceIsolation'

interface RootSurfaceCompositionProps {
  children: ReactNode
  deploymentSurface: DeploymentSurface
  gaId?: string
  enableSpeedInsights: boolean
}

function RequiredRuntimeProviders({ children }: { children: ReactNode }) {
  return (
    <AuthGateProvider>
      <ThemeProvider>{children}</ThemeProvider>
    </AuthGateProvider>
  )
}

/**
 * The root layout is shared by the B2C product and both Hire deployments.
 * Keep the providers that the unchanged interview client needs everywhere,
 * but instantiate B2C chrome, XP pollers/widgets, and telemetry only for an
 * actual B2C location.
 */
export default function RootSurfaceComposition({
  children,
  deploymentSurface,
  gaId,
  enableSpeedInsights,
}: RootSurfaceCompositionProps) {
  const pathname = usePathname() || '/'
  const resolvedSurface = resolveDeploymentSurface({
    configuredSurface: deploymentSurface,
    hostname: typeof window === 'undefined' ? undefined : window.location.hostname,
  })
  const isIsolated = isHireIsolatedSurface({
    deploymentSurface: resolvedSurface,
    pathname,
  })
  const sessionless = isHirePublicSessionlessPath(pathname)

  if (isIsolated) {
    const content = <RequiredRuntimeProviders>{children}</RequiredRuntimeProviders>
    return sessionless ? content : <SessionProvider>{content}</SessionProvider>
  }

  const content = (
    <>
      <AnalyticsProvider>
        <RequiredRuntimeProviders>
          <XpProvider>
            <AppShell navAuthExtras={<XpBadge />} authedGlobalWidgets={<BadgeUnlockChecker />}>
              {children}
            </AppShell>
          </XpProvider>
        </RequiredRuntimeProviders>
      </AnalyticsProvider>
      {enableSpeedInsights ? <SpeedInsights /> : null}
      {gaId ? <GoogleAnalyticsScripts gaId={gaId} /> : null}
    </>
  )
  return sessionless ? content : <SessionProvider>{content}</SessionProvider>
}
