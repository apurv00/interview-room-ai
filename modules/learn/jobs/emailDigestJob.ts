import { inngest } from '@shared/services/inngest'
import { logger } from '@shared/logger'

/**
 * Daily email digest — cron registered at 9 AM UTC, HARD-DISABLED in code.
 *
 * Previously scheduled via vercel.json + /api/cron/email-digest. Migrated to
 * Inngest so it shares retry + observability infrastructure with the rest of
 * our background jobs.
 *
 * Why hard-disabled — and deliberately NOT an env var or feature flag
 * (founder ruling 2026-07-11: guards against known-unsafe behavior must not
 * be flip keys): this cron has been FIRING daily in prod for a while
 * (Inngest app verified live-synced 2026-07-11), with every send silently
 * no-oping because RESEND_API_KEY was unset. That credential was added on
 * 2026-07-11 (for the B2B invite-OTP flow), which would turn the next 9AM
 * UTC run into real sends — and `processEmailBatch`
 * (modules/learn/services/emailTriggerService.ts) has no per-user send
 * dedupe, no pagination past the first 50 users per query, and never reads
 * `emailPreferences.frequency` (daily cron, "weekly recap" copy, users
 * opted in by default): a permanent daily ≤100-email loop to the same
 * first-50 users.
 *
 * The ONLY way to re-enable is the PR that fixes those defects: that diff
 * deletes this early return and re-wires processEmailBatch, with its own
 * tests. Until then the cron runs as a visible no-op ({ skipped: true } in
 * the Inngest dashboard) so enablement verification can confirm the guard
 * is active.
 */

interface EmailDigestStepRunner {
  run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T>
}

export async function runEmailDigestHandler(_ctx: { step: EmailDigestStepRunner }) {
  logger.info('email digest is hard-disabled pending dedupe/frequency fixes — skipping batch')
  return { sent: 0, errors: 0, skipped: true }
}

export const emailDigestJob = inngest.createFunction(
  {
    id: 'email-digest-daily',
    name: 'Send daily engagement email digest',
    retries: 1,
    triggers: [{ cron: '0 9 * * *' }],
  },
  runEmailDigestHandler
)
