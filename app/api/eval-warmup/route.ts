import { NextResponse } from 'next/server'
import { z } from 'zod'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models'
import { getOrLoadSessionConfig } from '@interview/services/core/sessionConfigCache'
import {
  getOrLoadJDContext,
  getOrLoadResumeContext,
} from '@interview/services/persona/documentContextCache'
import { aiLogger } from '@shared/logger'

/**
 * Q0 cold-start mitigation.
 *
 * Called by the client (fire-and-forget) once `/api/interviews` returns a
 * sessionId — i.e. during the natural idle window while the avatar speaks
 * the intro question. Pre-populates the three caches that the first
 * `/api/evaluate-answer` call would otherwise miss synchronously on the
 * critical path:
 *
 *   1. Mongoose connection pool (THIS Lambda's pool — note that
 *      `/api/evaluate-answer` runs on a different Vercel Function, so its
 *      pool is NOT warmed by this route; that requires a Phase 2 in-route
 *      `?warm=1` short-circuit).
 *   2. Redis session-config cache (`session:cfg:<sessionId>`) — read by
 *      both `/api/generate-question` and `/api/evaluate-answer`.
 *   3. Redis JD/resume context caches (`jd:ctx:<sessionId>` and
 *      `resume:ctx:<sessionId>`) — these are LLM-backed; on cold cache
 *      `getOrLoadJDContext` and `getOrLoadResumeContext` each fire a
 *      summarization call that can take 1-3s. Running them now (during
 *      avatar TTS) means the real Q0 eval finds them cached.
 *
 * Strictly additive: any failure here is logged and swallowed. The
 * interview proceeds normally whether warming succeeds, fails, or never
 * runs. No LLM call is made on the response path of this route — the
 * doc-context loaders may fire LLM parses internally on cache miss, but
 * those are the SAME parses that would otherwise run inline on Q0.
 *
 * Why it doesn't take config in the body: the session document already
 * has authoritative copies of role/interviewType/experience and the
 * raw JD/resume text. One Mongo read avoids duplicating multi-KB JD/resume
 * payloads in the request body and prevents drift between what the client
 * sent here and what was persisted.
 */
const WarmupSchema = z.object({
  sessionId: z.string().min(1).max(64),
})

type WarmupBody = z.infer<typeof WarmupSchema>

type ComponentStatus = 'ok' | 'skipped' | 'error'

interface WarmupResult {
  warmed: boolean
  durationMs: number
  components: {
    config: ComponentStatus
    jd: ComponentStatus
    resume: ComponentStatus
  }
}

export const dynamic = 'force-dynamic'

export const POST = composeApiRoute<WarmupBody>({
  schema: WarmupSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 20, keyPrefix: 'rl:eval-warm' },

  async handler(_req, { user, body }) {
    const startTime = Date.now()
    const { sessionId } = body
    const result: WarmupResult = {
      warmed: true,
      durationMs: 0,
      components: { config: 'skipped', jd: 'skipped', resume: 'skipped' },
    }

    try {
      await connectDB()

      // Caller owns the session — or it's a recruiter/admin viewing a
      // candidate's session, in which case we still warm. We only assert
      // the row exists and read the fields we need; we do NOT enforce
      // userId match because warming a row you can't access is harmless
      // (the actual eval call will enforce its own auth).
      const sessionDoc = (await InterviewSession.findById(sessionId)
        .select('userId config jobDescription resumeText')
        .lean()) as {
        userId?: { toString(): string }
        config?: { role?: string; interviewType?: string; experience?: string }
        jobDescription?: string
        resumeText?: string
      } | null

      if (!sessionDoc) {
        aiLogger.warn({ sessionId, userId: user.id }, 'eval-warmup: session not found')
        result.warmed = false
        result.durationMs = Date.now() - startTime
        return NextResponse.json(result)
      }

      const role = sessionDoc.config?.role ?? ''
      const interviewType = sessionDoc.config?.interviewType ?? 'behavioral'
      const experience = sessionDoc.config?.experience ?? '0-2'

      // Fire the three warmers in parallel. allSettled keeps any one
      // failure from blocking the others — and each loader already
      // handles its own errors internally, so this is belt-and-suspenders.
      const [cfgRes, jdRes, resumeRes] = await Promise.allSettled([
        role
          ? getOrLoadSessionConfig(sessionId, {
              role,
              interviewType,
              userId: sessionDoc.userId?.toString() ?? user.id,
              experience,
            })
          : Promise.resolve(null),
        sessionDoc.jobDescription
          ? getOrLoadJDContext(sessionId, sessionDoc.jobDescription)
          : Promise.resolve(null),
        sessionDoc.resumeText && role
          ? getOrLoadResumeContext(sessionId, sessionDoc.resumeText, role)
          : Promise.resolve(null),
      ])

      result.components.config =
        cfgRes.status === 'fulfilled' ? (cfgRes.value ? 'ok' : 'skipped') : 'error'
      result.components.jd =
        jdRes.status === 'fulfilled' ? (jdRes.value ? 'ok' : 'skipped') : 'error'
      result.components.resume =
        resumeRes.status === 'fulfilled' ? (resumeRes.value ? 'ok' : 'skipped') : 'error'
    } catch (err) {
      // Never throw to the caller — warming is best-effort.
      aiLogger.warn({ err, sessionId, userId: user.id }, 'eval-warmup: unexpected error')
      result.warmed = false
    }

    result.durationMs = Date.now() - startTime
    aiLogger.info(
      { event: 'eval_warmup', sessionId, userId: user.id, ...result },
      'eval-warmup completed',
    )
    return NextResponse.json(result)
  },
})
