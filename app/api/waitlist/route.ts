import { NextResponse } from 'next/server'
import { z } from 'zod'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { connectDB } from '@shared/db/connection'
import { WaitlistEntry } from '@shared/db/models'
import { aiLogger } from '@shared/logger'

export const dynamic = 'force-dynamic'

const WaitlistSchema = z.object({
  email: z.string().email().max(254),
  source: z.string().min(1).max(64),
})

export const POST = composeApiRoute({
  schema: WaitlistSchema,
  authOptional: true,
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 5,
    keyPrefix: 'waitlist',
    anonDailyLimit: 20,
  },
  handler: async (_req, { body }) => {
    await connectDB()
    const email = body.email.toLowerCase().trim()

    try {
      await WaitlistEntry.updateOne(
        { email },
        { $setOnInsert: { email, source: body.source } },
        { upsert: true }
      )
    } catch (err) {
      aiLogger.error({ err, email }, 'Failed to persist waitlist entry')
      return NextResponse.json({ error: 'Failed to save' }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  },
})
