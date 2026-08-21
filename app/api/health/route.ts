import { NextRequest, NextResponse } from 'next/server'
import {
  currentDeploymentSurface,
  hireDeploymentConfigurationIssues,
} from '@shared/surfaces/hireDeploymentReadiness'
import { HIRE_MEDIA_OBJECT_PROTOCOL } from '@shared/contracts/hireMediaObjectProtocol'
import { deploymentCommitOf } from './deploymentIdentity'

export const dynamic = 'force-dynamic'
const HIRE_MULTIMODAL_BUILD_ENABLED =
  process.env.HIRE_MULTIMODAL_BUILD_ENABLED === 'true'

// NOTE: Heavy deps (`mongoose`, `@shared/db/connection`, `@shared/redis`) are
// dynamic-imported inside each handler on purpose. If we imported them at
// module scope and one failed to load (e.g. REDIS_URL missing at build time,
// mongoose deprecation throwing during init), the entire route module would
// fail to register and Vercel would return 503 to BOTH methods — which is
// exactly the pattern the lobby warm-up was observing. Keeping the top of
// this file cheap means the route is always reachable.

/**
 * HEAD — dependency-aware readiness probe used by Docker/Coolify, lobby
 * warm-up, and external monitors. MongoDB and Redis are both required runtime
 * dependencies, so a failure in either must keep a new container out of
 * service.
 */
export async function HEAD() {
  try {
    const surface = currentDeploymentSurface()
    if (
      hireDeploymentConfigurationIssues().length > 0 ||
      (surface === 'hire-engine' && !HIRE_MULTIMODAL_BUILD_ENABLED)
    ) {
      return new NextResponse(null, { status: 503 })
    }
    const { connectDB } = await import('@shared/db/connection')
    const mongoose = (await import('mongoose')).default
    await connectDB()
    if (mongoose.connection.readyState !== 1) {
      return new NextResponse(null, { status: 503 })
    }
    const { redis } = await import('@shared/redis')
    await redis.ping()
    return new NextResponse(null, { status: 200 })
  } catch {
    return new NextResponse(null, { status: 503 })
  }
}

/**
 * GET — full infrastructure health check (used by Docker / monitoring).
 * Requires a HEALTH_CHECK_TOKEN to prevent unauthenticated infrastructure
 * probing. Returns 503 if MongoDB or Redis is unavailable.
 */
export async function GET(req: NextRequest) {
  // Require a monitoring token to access detailed health info.
  // If HEALTH_CHECK_TOKEN is not set, the detailed check is disabled for
  // public access.
  const token = process.env.HEALTH_CHECK_TOKEN
  const provided =
    req.headers.get('authorization')?.replace('Bearer ', '') ||
    req.nextUrl.searchParams.get('token')
  const releaseGateAuthenticated = !!token && provided === token
  const configurationIssues = hireDeploymentConfigurationIssues()
  const surface = currentDeploymentSurface()
  const browserBuildReady =
    surface !== 'hire-engine' || HIRE_MULTIMODAL_BUILD_ENABLED
  if (!releaseGateAuthenticated) {
    const configured = configurationIssues.length === 0 && browserBuildReady
    return NextResponse.json(
      { status: configured ? 'ok' : 'degraded' },
      { status: configured ? 200 : 503 },
    )
  }
  const checks: Record<string, 'ok' | 'error'> = {}
  checks.configuration = configurationIssues.length === 0 ? 'ok' : 'error'
  if (surface === 'hire-engine') {
    checks.hireBrowserBuild = HIRE_MULTIMODAL_BUILD_ENABLED ? 'ok' : 'error'
  }
  if (configurationIssues.length > 0 || !browserBuildReady) {
    const response = NextResponse.json(
      {
        status: 'degraded',
        checks,
        surface,
        configurationIssues,
        hireInterviewBuild: surface === 'hire-engine'
          ? { multimodal: HIRE_MULTIMODAL_BUILD_ENABLED }
          : null,
        releaseGateAuthenticated,
        deploymentCommit: deploymentCommitOf(),
        hireMediaObjectProtocol:
          surface === 'hire-control'
            ? HIRE_MEDIA_OBJECT_PROTOCOL
            : 'not-applicable',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      },
      { status: 503 },
    )
    response.headers.set('Cache-Control', 'private, no-store')
    return response
  }

  try {
    const { connectDB } = await import('@shared/db/connection')
    const mongoose = (await import('mongoose')).default
    await connectDB()
    checks.mongodb = mongoose.connection.readyState === 1 ? 'ok' : 'error'
  } catch {
    checks.mongodb = 'error'
  }

  try {
    const { redis } = await import('@shared/redis')
    await redis.ping()
    checks.redis = 'ok'
  } catch {
    checks.redis = 'error'
  }

  const allOk = Object.values(checks).every((v) => v === 'ok')

  const response = NextResponse.json(
    {
      status: allOk ? 'healthy' : 'degraded',
      checks,
      surface,
      configurationIssues,
      hireInterviewBuild: releaseGateAuthenticated && surface === 'hire-engine'
        ? { multimodal: HIRE_MULTIMODAL_BUILD_ENABLED }
        : null,
      releaseGateAuthenticated,
      deploymentCommit: releaseGateAuthenticated ? deploymentCommitOf() : null,
      hireMediaObjectProtocol:
        surface === 'hire-control'
          ? HIRE_MEDIA_OBJECT_PROTOCOL
          : 'not-applicable',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    },
    { status: allOk ? 200 : 503 }
  )
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}
