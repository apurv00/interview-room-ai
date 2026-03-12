import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { connectDB } from '@/lib/db/connection'
import { User } from '@/lib/db/models'
import { logger } from '@/lib/logger'
import { redis } from '@/lib/redis'
import { PLANS } from '@/lib/services/stripe'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const RegisterSchema = z.object({
  name: z.string().min(1).max(200).trim(),
  email: z.string().email().max(320).toLowerCase(),
  password: z.string().min(8).max(128),
})

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

    const body = await req.json()
    const parsed = RegisterSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Name, email, and password are required' }, { status: 400 })
    }
    const { name, email, password } = parsed.data

    await connectDB()

    const existing = await User.findOne({ email })
    if (existing) {
      // Return the same response shape as success to prevent email enumeration.
      // Do NOT reveal whether the email is already registered.
      return NextResponse.json({ message: 'If this email is not already registered, your account has been created.' }, { status: 201 })
    }

    const hashedPassword = await bcrypt.hash(password, 12)
    const freePlan = PLANS.free

    await User.create({
      email,
      name,
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
