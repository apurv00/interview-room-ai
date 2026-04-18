import { inngest } from '@shared/services/inngest'
import { logger } from '@shared/logger'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models'

/**
 * Keep the MongoDB Atlas cluster warm by issuing a trivial query every 5
 * minutes. Prevents the shared-tier idle-sleep that produces the 5–15s
 * cold wake-up observed on `/api/auth/session`, `/api/interviews`, and
 * `/api/generate-question` during the 25-second interview-start delay
 * documented in PR #289.
 *
 * Why 5 minutes: Atlas M0/M2 shared tiers idle after ~10 minutes of no
 * traffic. A 5-minute ping is well inside that window, leaving slack for
 * Inngest scheduling jitter.
 *
 * Why `User.findOne().lean()`: covers the two properties that matter for
 * warming — (1) TCP round-trip to the cluster, (2) collection open +
 * cursor allocation on `users`, which is the hottest collection the app
 * reads from during interview setup. `.lean()` skips Mongoose hydration
 * so there's no JS overhead.
 *
 * Why not just `db.adminCommand({ ping: 1 })`: the admin ping wakes the
 * cluster's control plane but a first query on a specific collection can
 * still eat a few hundred ms. Querying `users` directly warms both.
 *
 * Cost: one read op per 5 min = 288/day. Well under Atlas M0 free-tier
 * op budgets.
 *
 * To disable: remove this function from the `functions` array in
 * `app/api/inngest/route.ts`.
 */
export const keepMongoWarmJob = inngest.createFunction(
  {
    id: 'keep-mongo-warm',
    name: 'Keep Mongo cluster warm (prevent idle sleep)',
    retries: 0, // No retries: if one ping fails the next one in 5 min will try
    triggers: [{ cron: '*/5 * * * *' }],
  },
  async ({ step }) => {
    return step.run('ping-users', async () => {
      const start = Date.now()
      try {
        await connectDB()
        await User.findOne().select('_id').lean()
        const durationMs = Date.now() - start
        if (durationMs > 3000) {
          // Warn if ping itself took long — indicates cluster was cold and
          // the next real request might also see latency. Not an error
          // because the ping completed; this is signal, not failure.
          logger.warn({ durationMs }, 'Mongo warm-ping slow (cluster likely cold-woken)')
        }
        return { status: 'warm', durationMs }
      } catch (err) {
        // Non-fatal: missing a single ping doesn't break anything. If Mongo
        // is actually down, real user requests will fail louder than this.
        logger.warn({ err }, 'Mongo warm-ping failed (cluster unreachable?)')
        return { status: 'error', durationMs: Date.now() - start }
      }
    })
  }
)
