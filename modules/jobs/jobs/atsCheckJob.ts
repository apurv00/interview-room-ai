import { gunzipSync } from 'zlib'
import { inngest } from '@shared/services/inngest'
import { connectDB } from '@shared/db/connection'
import { JobApplication, JobPosting, UsageRecord, ProductEvent } from '@shared/db/models'
import { logger } from '@shared/logger'
import { checkATS } from '@resume'
import { getBaseResume } from '../services/baseResumeService'
import { getResume } from '@resume'
import { xrayHashOf } from '../services/xrayService'

/**
 * Save-gated per-job ATS check (Wave 3.3, founder decision Q3). The ~35s
 * Sonnet `resume.ats-check` slot NEVER runs inline — the route queues this
 * job and the detail page polls the application summary. checkATS carries
 * its own content-keyed Redis cache, so a re-check of the same
 * (resume, JD) pair is a <100ms cache hit, not a second LLM spend.
 *
 * One-shot semantics: a stored atsResult for the CURRENT jdHash is final —
 * re-clicks return it without re-running (the JD changing on a merge
 * changes the hash, which legitimately re-opens the check).
 *
 * Quota seam (§2): every real run writes a UsageRecord{type:'ats_check'} —
 * recorded from launch, gated by nothing until P-1 resolves.
 */

interface StepRunner {
  run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T>
}

export async function runAtsCheckHandler(
  event: { data: { userId: string; jobPostingId: string; claimedAt?: string } },
  step: StepRunner
): Promise<{ skipped: string } | { done: true; score: number; cached: boolean }> {
  await connectDB()
  const { userId, jobPostingId } = event.data
  const claimedAt = event.data.claimedAt ? new Date(event.data.claimedAt) : null

  const outcome = await step.run('check', async () => {
    const app = await JobApplication.findOne({ userId, jobPostingId })
    // Save-gated server-side too: no tracker row = nothing to attach to.
    if (!app) return { skipped: 'no-application' as const }

    // A run may only clear the claim IT owns (Codex on #521): a superseded
    // slow run finishing after a fresh reclaim must not unset the newer
    // run's marker and re-enable duplicate clicks mid-flight.
    const clearOwnClaim = () =>
      JobApplication.updateOne(
        claimedAt ? { _id: app._id, atsRequestedAt: claimedAt } : { _id: app._id },
        { $unset: { atsRequestedAt: 1 } }
      )

    const posting = await JobPosting.findById(jobPostingId).select('jdCompressed').lean()
    const buf = posting?.jdCompressed as Buffer | undefined
    let jd = ''
    try {
      jd = buf?.length ? gunzipSync(Buffer.isBuffer(buf) ? buf : Buffer.from((buf as { buffer: ArrayBufferLike }).buffer as ArrayBuffer)).toString('utf8') : ''
    } catch { /* corrupt gzip → no JD */ }
    if (!jd) {
      await clearOwnClaim()
      return { skipped: 'no-jd' as const }
    }

    // Resume loads BEFORE the short-circuit: the result identifies a
    // (resume x JD) PAIR — reusing a score because only the JD matched
    // served stale numbers after every resume edit (Codex on #521).
    const base = await getBaseResume(userId)
    const full = base ? await getResume(userId, base.id) : null
    const resumeText = (full as { fullText?: string } | null)?.fullText ?? ''
    if (!resumeText) {
      await clearOwnClaim()
      return { skipped: 'no-resume' as const }
    }

    const jdHash = xrayHashOf(jd)
    const resumeHash = xrayHashOf(resumeText)
    if (app.atsResult && app.atsResult.jdHash === jdHash && app.atsResult.resumeHash === resumeHash) {
      await clearOwnClaim()
      return { done: true as const, score: app.atsResult.score, cached: true }
    }

    try {
      const result = await checkATS({ resumeText, jobDescription: jd })
      const score = (result as { score?: number })?.score ?? 0
      const missing = ((result as { keywords?: { missing?: string[] } })?.keywords?.missing ?? []).slice(0, 20)
      // Result write is unconditional (last computation wins — both runs saw
      // live DB state); the marker clear stays claim-scoped.
      await JobApplication.updateOne(
        { _id: app._id },
        { $set: { atsResult: { score, missingKeywords: missing, jdHash, resumeHash, checkedAt: new Date() } } }
      )
      await clearOwnClaim()
      try {
        await UsageRecord.create({ userId, type: 'ats_check' })
        await ProductEvent.create({ name: 'jobs.ats_score_landed', userId, jobPostingId, props: { score }, ts: new Date() })
      } catch (err) {
        logger.warn({ err }, 'ats-check bookkeeping write failed') // never fails the result
      }
      return { done: true as const, score, cached: false }
    } catch (err) {
      // Clear (our own) pending marker so the button re-enables — a transient
      // LLM failure must not wedge the check forever.
      await clearOwnClaim()
      logger.warn({ err, jobPostingId }, 'jobs ats-check failed')
      return { skipped: 'check-failed' as const }
    }
  })

  if ('skipped' in outcome) return { skipped: String(outcome.skipped) }
  return outcome
}

export const jobsAtsCheckJob = inngest.createFunction(
  {
    id: 'jobs-ats-check',
    name: 'Jobs: per-job ATS check',
    retries: 1,
    concurrency: [{ limit: 2 }],
    triggers: [{ event: 'jobs/ats.requested' }],
  },
  async ({ event, step }) =>
    runAtsCheckHandler(event as unknown as { data: { userId: string; jobPostingId: string; claimedAt?: string } }, step as StepRunner)
)
