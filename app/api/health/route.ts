import { NextRequest, NextResponse } from 'next/server'
import { connectDB } from '@/lib/db/connection'
import { redis } from '@/lib/redis'
import mongoose from 'mongoose'

export const dynamic = 'force-dynamic'

/**
 * HEAD — lightweight connectivity check (used by lobby page).
 * Always returns 200 to confirm the API is reachable.
 */
export async function HEAD() {
  return new NextResponse(null, { status: 200 })
}

/**
 * GET — full infrastructure health check (used by Docker / monitoring).
 * Requires a HEALTH_CHECK_TOKEN to prevent unauthenticated infrastructure probing.
 * Returns 503 if MongoDB or Redis is unavailable.
 */
export async function GET(req: NextRequest) {
  // Require a monitoring token to access detailed health info.
  // If HEALTH_CHECK_TOKEN is not set, the detailed check is disabled for public access.
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
    await connectDB()
    checks.mongodb = mongoose.connection.readyState === 1 ? 'ok' : 'error'
  } catch {
    checks.mongodb = 'error'
  }

  try {
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
