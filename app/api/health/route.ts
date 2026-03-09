import { NextResponse } from 'next/server'
import { connectDB } from '@/lib/db/connection'
import { redis } from '@/lib/redis'
import mongoose from 'mongoose'

export const dynamic = 'force-dynamic'

export async function GET() {
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
