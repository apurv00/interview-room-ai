import { NextRequest, NextResponse } from 'next/server'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models'
import { autoRegeneratePlan } from '@learn/services/dailyPlanService'
import { logger } from '@shared/logger'

export const dynamic = 'force-dynamic'

/**
 * GET /api/cron/regenerate-plans
 *
 * Monthly cron job that auto-regenerates plans for Pro/Enterprise users.
 * Run on the 1st of each month via Vercel Cron or external scheduler.
 * Protected by CRON_SECRET header.
 */
export async function GET(req: NextRequest) {
  // Verify cron secret
  const cronSecret = req.headers.get('authorization')?.replace('Bearer ', '')
  if (cronSecret !== process.env.CRON_SECRET && process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    await connectDB()

    // Find Pro/Enterprise users who should get new plans
    const eligibleUsers = await User.find({
      plan: { $in: ['pro', 'enterprise'] },
    }).select('_id plan').lean()

    let regenerated = 0
    let errors = 0

    for (const user of eligibleUsers) {
      try {
        const plan = await autoRegeneratePlan(user._id.toString())
        if (plan) regenerated++
      } catch {
        errors++
      }
    }

    logger.info({ regenerated, errors, total: eligibleUsers.length }, 'Monthly plan regeneration completed')

    return NextResponse.json({
      success: true,
      regenerated,
      errors,
      total: eligibleUsers.length,
    })
  } catch (err) {
    logger.error({ err }, 'Monthly plan regeneration failed')
    return NextResponse.json({ error: 'Regeneration failed' }, { status: 500 })
  }
}
