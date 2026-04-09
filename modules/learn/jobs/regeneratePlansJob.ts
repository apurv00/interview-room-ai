import { inngest } from '@shared/services/inngest'
import { logger } from '@shared/logger'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models'
import { autoRegeneratePlan } from '../services/dailyPlanService'

/**
 * Monthly pathway plan regeneration — runs on the 1st of each month at
 * midnight UTC. Regenerates 30-day pathway plans for all Pro/Enterprise
 * users so they never get stuck on a stale plan.
 *
 * Previously lived in /api/cron/regenerate-plans but was NOT scheduled in
 * vercel.json — the route was effectively dead code invoked manually. As
 * part of the Inngest migration we both move it onto a real schedule and
 * wire each user's regeneration into its own retryable step so one user's
 * failure doesn't abort the whole batch.
 */
export const regeneratePlansJob = inngest.createFunction(
  {
    id: 'regenerate-plans-monthly',
    name: 'Regenerate monthly pathway plans',
    retries: 1,
    triggers: [{ cron: '0 0 1 * *' }],
  },
  async ({ step }) => {
    const eligibleUsers = await step.run('fetch-eligible-users', async () => {
      await connectDB()
      return User.find({ plan: { $in: ['pro', 'enterprise'] } })
        .select('_id plan')
        .lean()
    })

    let regenerated = 0
    let errors = 0

    for (const user of eligibleUsers) {
      try {
        const plan = await step.run(`regenerate-user-${user._id.toString()}`, () =>
          autoRegeneratePlan(user._id.toString())
        )
        if (plan) regenerated++
      } catch (err) {
        errors++
        logger.error(
          { err, userId: user._id.toString() },
          'Monthly plan regeneration failed for user'
        )
      }
    }

    const result = { regenerated, errors, total: eligibleUsers.length }
    logger.info(result, 'Monthly plan regeneration batch completed')
    return result
  }
)
