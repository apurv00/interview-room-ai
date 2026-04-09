import { inngest } from '@shared/services/inngest'
import { logger } from '@shared/logger'
import { processEmailBatch } from '../services/emailTriggerService'

/**
 * Daily email digest — runs at 9 AM UTC every day.
 *
 * Previously scheduled via vercel.json + /api/cron/email-digest. Migrated to
 * Inngest so it shares retry + observability infrastructure with the rest of
 * our background jobs.
 */
export const emailDigestJob = inngest.createFunction(
  {
    id: 'email-digest-daily',
    name: 'Send daily engagement email digest',
    retries: 1,
    triggers: [{ cron: '0 9 * * *' }],
  },
  async ({ step }) => {
    const result = await step.run('process-batch', () => processEmailBatch())
    logger.info({ ...result }, 'Daily email digest batch completed')
    return result
  }
)
