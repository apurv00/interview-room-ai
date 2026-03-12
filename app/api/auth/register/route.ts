import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { connectDB } from '@/lib/db/connection'
import { User } from '@/lib/db/models'
import { logger } from '@/lib/logger'
import { redis } from '@/lib/redis'
import { PLANS } from '@/lib/services/stripe'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    // Rate limit: 5 registrations per IP per hour
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
    try {
      const key = `rl:register:${ip}`
      const current = await redis.incr(key)
      if (current === 1) await redis.pexpire(key, 3600_000)
      if (current > 5) {
        return NextResponse.json({ error: 'Too many registration attempts. Try again later.' }, { status: 429 })
      }
    } catch { /* allow if Redis is unavailable */ }

    const { name, email, password } = await req.json()

    if (!name || !email || !password) {
      return NextResponse.json({ error: 'Name, email, and password are required' }, { status: 400 })
    }

    if (password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 })
    }

    await connectDB()

    const existing = await User.findOne({ email: email.toLowerCase() })
    if (existing) {
      // Return the same response shape as success to prevent email enumeration.
      // Do NOT reveal whether the email is already registered.
      return NextResponse.json({ message: 'If this email is not already registered, your account has been created.' }, { status: 201 })
    }

    const hashedPassword = await bcrypt.hash(password, 12)
    const freePlan = PLANS.free

    await User.create({
      email: email.toLowerCase(),
      name: name.trim(),
      hashedPassword,
      role: 'candidate',
      plan: 'free',
      monthlyInterviewLimit: freePlan.monthlyInterviewLimit,
      onboardingCompleted: false,
    })

    return NextResponse.json({ message: 'If this email is not already registered, your account has been created.' }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'Registration error')
    return NextResponse.json({ error: 'Registration failed' }, { status: 500 })
  }
}
