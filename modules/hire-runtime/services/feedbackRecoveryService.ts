import { randomBytes } from 'node:crypto'
import { encode } from 'next-auth/jwt'
import { GenerateFeedbackSchema } from '@interview'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import {
  HireRuntimeBinding,
  type IHireRuntimeBinding,
} from '../models/HireRuntimeBinding'
import { connectHireRuntimeDB } from './runtimeBoundary'
import { runtimePrincipalEmail } from './runtimePrincipalService'
import { enumerateRuntimeWorkspaceIds } from './runtimeTenantScope'

const RECOVERY_LEASE_MS = 7 * 60 * 1_000
const RECOVERY_RETRY_BASE_MS = 30_000
const RECOVERY_RETRY_MAX_MS = 5 * 60 * 1_000

interface FeedbackRecoverySession {
  _id: { toString(): string }
  userId: { toString(): string }
  status: string
  config: Record<string, unknown>
  jobDescription?: string | null
  transcript?: unknown[] | null
  evaluations?: unknown[] | null
  speechMetrics?: unknown[] | null
  plannedQuestionCount?: number | null
  answeredCount?: number | null
  endReason?: string | null
  feedback?: unknown
}

function runtimeBaseUrl(): string {
  const raw = process.env.NEXTAUTH_URL
  if (!raw) throw new Error('Runtime feedback origin is not configured')
  const url = new URL(raw)
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error('Runtime feedback origin must use HTTPS')
  }
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url.toString()
}

function runtimeAuthSecret(): string {
  const secret = process.env.HIRE_RUNTIME_NEXTAUTH_SECRET
  if (
    !secret ||
    (process.env.NODE_ENV === 'production' && secret.length < 16)
  ) {
    throw new Error('Runtime feedback authentication is not configured')
  }
  return secret
}

function runtimeSessionCookieName(): string {
  return process.env.NODE_ENV === 'production'
    ? '__Secure-ipg-hire-runtime'
    : 'ipg-hire-runtime'
}

function feedbackPayload(session: FeedbackRecoverySession) {
  return GenerateFeedbackSchema.parse({
    config: {
      ...session.config,
      ...(session.jobDescription
        ? { jobDescription: session.jobDescription }
        : {}),
    },
    transcript: session.transcript ?? [],
    evaluations: session.evaluations ?? [],
    speechMetrics: session.speechMetrics ?? [],
    sessionId: session._id.toString(),
    ...(typeof session.plannedQuestionCount === 'number'
      ? { plannedQuestionCount: session.plannedQuestionCount }
      : {}),
    ...(typeof session.answeredCount === 'number'
      ? { answeredCount: session.answeredCount }
      : {}),
    ...([
      'normal',
      'time_up',
      'user_ended',
      'usage_limit',
      'abandoned',
    ].includes(String(session.endReason))
      ? { endReason: session.endReason }
      : {}),
  })
}

async function requestRuntimeFeedback(input: {
  binding: IHireRuntimeBinding
  session: FeedbackRecoverySession
}): Promise<'generated' | 'in-progress'> {
  const principalId = input.binding.principalId.toString()
  if (input.session.userId.toString() !== principalId) {
    throw new Error('Runtime feedback session crossed its binding')
  }
  const secret = runtimeAuthSecret()
  const token = await encode({
    secret,
    maxAge: 10 * 60,
    token: {
      sub: principalId,
      userId: principalId,
      organizationId: input.binding.workspaceId.toString(),
      email: runtimePrincipalEmail(input.binding.roundId.toString()),
      name: 'Interview candidate',
      role: 'candidate',
      plan: 'free',
    },
  })
  const target = new URL('/api/hire-engine/write-fence', runtimeBaseUrl())
  target.searchParams.set('__runtime_target', '/api/generate-feedback')
  const response = await fetch(target, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `${runtimeSessionCookieName()}=${token}`,
    },
    body: JSON.stringify(feedbackPayload(input.session)),
    cache: 'no-store',
    signal: AbortSignal.timeout(295_000),
  })
  if (response.status === 202) return 'in-progress'
  if (!response.ok) {
    throw new Error(`Runtime feedback recovery returned ${response.status}`)
  }
  return 'generated'
}

async function claimFeedbackRecovery(
  binding: IHireRuntimeBinding,
  now: Date,
): Promise<IHireRuntimeBinding | null> {
  const leaseToken = randomBytes(32).toString('hex')
  return HireRuntimeBinding.findOneAndUpdate(
    {
      _id: binding._id,
      workspaceId: binding.workspaceId,
      runtimeSessionId: binding.runtimeSessionId,
      purgePersonalData: { $ne: true },
      $or: [
        { feedbackRecoveryLeaseToken: { $exists: false } },
        { feedbackRecoveryLeaseExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: {
        feedbackRecoveryLeaseToken: leaseToken,
        feedbackRecoveryLeaseExpiresAt: new Date(
          now.getTime() + RECOVERY_LEASE_MS,
        ),
        feedbackRecoveryCheckedAt: now,
      },
    },
    { new: true },
  )
}

async function finishFeedbackRecovery(input: {
  workspaceId: string
  bindingId: string
  succeeded: boolean
  now: Date
  priorAttempts: number
}): Promise<void> {
  if (input.succeeded) {
    const finished = await HireRuntimeBinding.updateOne(
      {
        _id: input.bindingId,
        workspaceId: input.workspaceId,
        purgePersonalData: { $ne: true },
      },
      {
        $set: {
          feedbackRecoveryAttemptCount: 0,
          feedbackRecoveryCheckedAt: input.now,
        },
        $unset: {
          feedbackRecoveryLeaseToken: 1,
          feedbackRecoveryLeaseExpiresAt: 1,
          feedbackRecoveryRetryAt: 1,
          feedbackRecoveryFailureCode: 1,
        },
      },
    )
    if (finished.matchedCount !== 1) {
      await HireRuntimeBinding.updateOne(
        {
          _id: input.bindingId,
          workspaceId: input.workspaceId,
          purgePersonalData: true,
        },
        {
          $unset: {
            feedbackRecoveryLeaseToken: 1,
            feedbackRecoveryLeaseExpiresAt: 1,
          },
        },
      )
    }
    return
  }
  const attemptCount = Math.min(input.priorAttempts + 1, 20)
  const retryMs = Math.min(
    RECOVERY_RETRY_MAX_MS,
    RECOVERY_RETRY_BASE_MS * 2 ** Math.min(attemptCount - 1, 8),
  )
  const finished = await HireRuntimeBinding.updateOne(
    {
      _id: input.bindingId,
      workspaceId: input.workspaceId,
      purgePersonalData: { $ne: true },
    },
    {
      $set: {
        feedbackRecoveryAttemptCount: attemptCount,
        feedbackRecoveryCheckedAt: input.now,
        feedbackRecoveryRetryAt: new Date(input.now.getTime() + retryMs),
        feedbackRecoveryFailureCode: 'RUNTIME_FEEDBACK_RECOVERY_FAILED',
      },
      $unset: {
        feedbackRecoveryLeaseToken: 1,
        feedbackRecoveryLeaseExpiresAt: 1,
      },
    },
  )
  if (finished.matchedCount !== 1) {
    await HireRuntimeBinding.updateOne(
      {
        _id: input.bindingId,
        workspaceId: input.workspaceId,
        purgePersonalData: true,
      },
      {
        $unset: {
          feedbackRecoveryLeaseToken: 1,
          feedbackRecoveryLeaseExpiresAt: 1,
        },
      },
    )
  }
}

export async function recoverMissingRuntimeFeedback(
  limit = 3,
  now = new Date(),
): Promise<{
  scanned: number
  recovered: number
  skipped: number
  failed: number
}> {
  await connectHireRuntimeDB()
  const batchLimit = Math.min(Math.max(limit, 1), 10)
  const workspaceIds = await enumerateRuntimeWorkspaceIds()
  const perWorkspaceLimit = Math.max(
    1,
    Math.ceil(batchLimit / Math.max(workspaceIds.length, 1)),
  )
  const candidates: IHireRuntimeBinding[] = []
  for (const workspaceId of workspaceIds) {
    const scoped = await HireRuntimeBinding.find({
      workspaceId,
      runtimeSessionId: { $exists: true },
      // Ordinary revocation is still a request-path kill switch. Recovery only
      // acts while the binding remains active; completed bindings already have
      // an acknowledged immutable result.
      status: 'active',
      purgePersonalData: { $ne: true },
      $or: [
        { feedbackRecoveryRetryAt: { $exists: false } },
        { feedbackRecoveryRetryAt: { $lte: now } },
      ],
    })
      .sort({ feedbackRecoveryCheckedAt: 1, updatedAt: 1 })
      .limit(perWorkspaceLimit)
    candidates.push(...scoped)
  }
  const bindings = candidates
    .sort((left, right) => {
      const leftDate = left.feedbackRecoveryCheckedAt ?? left.updatedAt
      const rightDate = right.feedbackRecoveryCheckedAt ?? right.updatedAt
      const leftTime = leftDate instanceof Date ? leftDate.getTime() : 0
      const rightTime = rightDate instanceof Date ? rightDate.getTime() : 0
      return leftTime - rightTime
    })
    .slice(0, batchLimit)

  let recovered = 0
  let skipped = 0
  let failed = 0
  for (const candidate of bindings) {
    const binding = await claimFeedbackRecovery(candidate, now)
    if (!binding) {
      skipped += 1
      continue
    }
    try {
      const session = (await InterviewSession.findOne({
        _id: binding.runtimeSessionId,
        userId: binding.principalId,
        organizationId: binding.workspaceId,
        status: 'completed',
      })
        .select(
          '_id userId status config jobDescription transcript evaluations speechMetrics plannedQuestionCount answeredCount endReason feedback',
        )
        .lean()) as FeedbackRecoverySession | null
      if (!session || session.feedback) {
        await finishFeedbackRecovery({
          workspaceId: binding.workspaceId.toString(),
          bindingId: binding._id.toString(),
          succeeded: true,
          now,
          priorAttempts: binding.feedbackRecoveryAttemptCount ?? 0,
        })
        skipped += 1
        continue
      }
      const outcome = await requestRuntimeFeedback({ binding, session })
      const persisted = await InterviewSession.exists({
        _id: session._id,
        userId: binding.principalId,
        organizationId: binding.workspaceId,
        feedback: { $exists: true },
      })
      const succeeded = outcome === 'generated' && Boolean(persisted)
      await finishFeedbackRecovery({
        workspaceId: binding.workspaceId.toString(),
        bindingId: binding._id.toString(),
        succeeded,
        now,
        priorAttempts: binding.feedbackRecoveryAttemptCount ?? 0,
      })
      if (succeeded) recovered += 1
      else failed += 1
    } catch {
      await finishFeedbackRecovery({
        workspaceId: binding.workspaceId.toString(),
        bindingId: binding._id.toString(),
        succeeded: false,
        now,
        priorAttempts: binding.feedbackRecoveryAttemptCount ?? 0,
      }).catch(() => undefined)
      failed += 1
    }
  }
  return { scanned: bindings.length, recovered, skipped, failed }
}

export const __feedbackRecovery = {
  RECOVERY_LEASE_MS,
  feedbackPayload,
  requestRuntimeFeedback,
}
