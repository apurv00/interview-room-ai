import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// NOTE: Heavy deps (`mongoose`, `@shared/db/connection`, `@shared/redis`) are
// dynamic-imported inside each handler on purpose. If we imported them at
// module scope and one failed to load (e.g. REDIS_URL missing at build time,
// mongoose deprecation throwing during init), the entire route module would
// fail to register and Vercel would return 503 to BOTH methods — which is
// exactly the pattern the lobby warm-up was observing. Keeping the top of
// this file cheap means the route is always reachable.

/**
 * HEAD — lightweight MongoDB readiness probe (used by lobby warm-up and
 * external monitors). Returns 200 only when Mongoose reports an established
 * connection; 503 otherwise. This replaces the old dummy implementation
 * that returned 200 unconditionally and gave infrastructure monitoring no
 * signal about real DB health.
 */
export async function HEAD() {
  try {
    const { connectDB } = await import('@shared/db/connection')
    const mongoose = (await import('mongoose')).default
    await connectDB()
    return new NextResponse(null, {
      status: mongoose.connection.readyState === 1 ? 200 : 503,
    })
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
  if (token) {
    const provided =
      req.headers.get('authorization')?.replace('Bearer ', '') ||
      req.nextUrl.searchParams.get('token')
    if (provided !== token) {
      return NextResponse.json({ status: 'ok' }, { status: 200 })
    }
  }
  const checks: Record<string, 'ok' | 'error'> = {}

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

  return NextResponse.json(
    {
      status: allOk ? 'healthy' : 'degraded',
      checks,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    },
    { status: allOk ? 200 : 503 }
  )
}
