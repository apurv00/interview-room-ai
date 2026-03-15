import { NextResponse } from 'next/server'
import { processEmailBatch } from '@learn/services/emailTriggerService'
import { logger } from '@shared/logger'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    // Verify cron secret (Vercel Cron sends this header)
    const authHeader = req.headers.get('authorization')
    if (
      process.env.CRON_SECRET &&
      authHeader !== `Bearer ${process.env.CRON_SECRET}`
    ) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const result = await processEmailBatch()
    logger.info(result, 'Email digest cron completed')

    return NextResponse.json({
      success: true,
      ...result,
    })
  } catch (err) {
    logger.error({ err }, 'Email digest cron failed')
    return NextResponse.json({ error: 'Cron job failed' }, { status: 500 })
  }
}
