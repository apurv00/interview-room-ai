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
  event: { data: { userId: string; jobPostingId: string } },
  step: StepRunner
): Promise<{ skipped: string } | { done: true; score: number; cached: boolean }> {
  await connectDB()
  const { userId, jobPostingId } = event.data

  const outcome = await step.run('check', async () => {
    const app = await JobApplication.findOne({ userId, jobPostingId })
    // Save-gated server-side too: no tracker row = nothing to attach to.
    if (!app) return { skipped: 'no-application' as const }

    const posting = await JobPosting.findById(jobPostingId).select('jdCompressed').lean()
    const buf = posting?.jdCompressed as Buffer | undefined
    let jd = ''
    try {
      jd = buf?.length ? gunzipSync(Buffer.isBuffer(buf) ? buf : Buffer.from((buf as { buffer: ArrayBufferLike }).buffer as ArrayBuffer)).toString('utf8') : ''
    } catch { /* corrupt gzip → no JD */ }
    if (!jd) {
      await JobApplication.updateOne({ _id: app._id }, { $unset: { atsRequestedAt: 1 } })
      return { skipped: 'no-jd' as const }
    }

    const jdHash = xrayHashOf(jd)
    if (app.atsResult && app.atsResult.jdHash === jdHash) {
      await JobApplication.updateOne({ _id: app._id }, { $unset: { atsRequestedAt: 1 } })
      return { done: true as const, score: app.atsResult.score, cached: true }
    }

    const base = await getBaseResume(userId)
    const full = base ? await getResume(userId, base.id) : null
    const resumeText = (full as { fullText?: string } | null)?.fullText ?? ''
    if (!resumeText) {
      await JobApplication.updateOne({ _id: app._id }, { $unset: { atsRequestedAt: 1 } })
      return { skipped: 'no-resume' as const }
    }

    try {
      const result = await checkATS({ resumeText, jobDescription: jd })
      const score = (result as { score?: number })?.score ?? 0
      const missing = ((result as { keywords?: { missing?: string[] } })?.keywords?.missing ?? []).slice(0, 20)
      await JobApplication.updateOne(
        { _id: app._id },
        {
          $set: { atsResult: { score, missingKeywords: missing, jdHash, checkedAt: new Date() } },
          $unset: { atsRequestedAt: 1 },
        }
      )
      try {
        await UsageRecord.create({ userId, type: 'ats_check' })
        await ProductEvent.create({ name: 'jobs.ats_score_landed', userId, jobPostingId, props: { score }, ts: new Date() })
      } catch (err) {
        logger.warn({ err }, 'ats-check bookkeeping write failed') // never fails the result
      }
      return { done: true as const, score, cached: false }
    } catch (err) {
      // Clear the pending marker so the button re-enables — a transient LLM
      // failure must not wedge the check forever.
      await JobApplication.updateOne({ _id: app._id }, { $unset: { atsRequestedAt: 1 } })
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
    runAtsCheckHandler(event as unknown as { data: { userId: string; jobPostingId: string } }, step as StepRunner)
)
