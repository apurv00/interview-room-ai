import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import mongoose from 'mongoose'
import { z } from 'zod'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { aiLogger } from '@shared/logger'
import {
  isJobsAccountActive,
  JobsAccountInactiveError,
  JobsAccountTransactionsRequiredError,
} from '@shared/services/jobsAccountFence'
import {
  associateRecordingArtifact,
  cleanupSupersededRecordingArtifact,
  isSessionRecordingKey,
  parseRecordingArtifactKey,
  RecordingArtifactKeyRejectedError,
  RecordingArtifactSessionNotFoundError,
} from '@interview/services/core/recordingArtifactService'
import {
  abortMultipartUpload,
  audioRecordingKey,
  completeMultipartUpload,
  createMultipartUpload,
  deleteFromR2,
  getMultipartPartPresignedUrl,
  isR2Configured,
  objectExists,
  recordingKey,
  screenRecordingKey,
} from '@shared/storage/r2'

export const dynamic = 'force-dynamic'

const PART_SIZE_BYTES = 8 * 1024 * 1024
const PRIVATE_NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }

const MultipartSchema = z.object({
  action: z.enum(['create', 'sign-part', 'complete', 'abort']),
  type: z.enum(['recording', 'screen-recording', 'audio-recording']).optional(),
  sessionId: z.string().max(100).optional(),
  key: z.string().max(1000).optional(),
  uploadId: z.string().max(1000).optional(),
  partNumber: z.number().int().min(1).max(10_000).optional(),
  sizeBytes: z.number().int().min(0).optional(),
  // Recorder-truth span, persisted with the camera recording at 'complete' so
  // queued-drain uploads (finished on a later page, where the interview tab's
  // own duration PATCH may never have landed) still carry it.
  durationSeconds: z.number().min(1).max(14_400).optional(),
  parts: z.array(
    z.object({
      partNumber: z.number().int().min(1).max(10_000),
      etag: z.string().min(1).max(500),
    })
  ).max(10_000).optional(),
})

type RecordingType = 'recording' | 'screen-recording' | 'audio-recording'

interface MultipartLogContext {
  action?: string
  type?: string
  sessionId?: string
  keySuffix?: string
  partNumber?: number
  partCount?: number
  sizeBytes?: number
}

interface MultipartCleanupTarget {
  key: string
  uploadId: string
}

function privateJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: PRIVATE_NO_STORE_HEADERS,
  })
}

function accountUnavailableResponse() {
  return privateJson(
    { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
    401,
  )
}

function contentTypeFor(type: RecordingType): string {
  return type === 'audio-recording' ? 'audio/webm' : 'video/webm'
}

function keyFor(type: RecordingType, userId: string, sessionId: string): string {
  if (type === 'screen-recording') return screenRecordingKey(userId, sessionId)
  if (type === 'audio-recording') return audioRecordingKey(userId, sessionId)
  return recordingKey(userId, sessionId)
}

function persistedFieldNames(type: RecordingType) {
  if (type === 'screen-recording') {
    return { keyField: 'screenRecordingR2Key', sizeField: 'screenRecordingSizeBytes' }
  }
  if (type === 'audio-recording') {
    return { keyField: 'audioRecordingR2Key', sizeField: 'audioRecordingSizeBytes' }
  }
  return { keyField: 'recordingR2Key', sizeField: 'recordingSizeBytes' }
}

function isOwnedRecordingKey(key: string, userId: string): boolean {
  return parseRecordingArtifactKey(key, userId) !== null
}

// R2/S3 returns NoSuchUpload when CompleteMultipartUpload is called with an
// uploadId that has already been finalized, was aborted, or has expired.
// Only the first case is a recoverable retry — the other two mean the object
// does not exist at `key`. The caller MUST verify object existence before
// treating this as success. (Codex P1 on PR #332 + follow-up.)
function isNoSuchUploadError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: string; Code?: string }
  return e.name === 'NoSuchUpload' || e.Code === 'NoSuchUpload'
}

function safeErrorInfo(err: unknown): { name?: string; code?: string; message: string } {
  if (err instanceof Error) {
    const e = err as Error & { Code?: unknown; code?: unknown }
    const code = typeof e.Code === 'string'
      ? e.Code
      : typeof e.code === 'string'
      ? e.code
      : undefined
    return { name: err.name, code, message: err.message }
  }
  if (err && typeof err === 'object') {
    const e = err as { name?: unknown; Code?: unknown; code?: unknown; message?: unknown }
    return {
      name: typeof e.name === 'string' ? e.name : undefined,
      code: typeof e.Code === 'string' ? e.Code : typeof e.code === 'string' ? e.code : undefined,
      message: typeof e.message === 'string' ? e.message : String(err),
    }
  }
  return { message: String(err) }
}

async function bestEffortAbort(
  target: MultipartCleanupTarget,
  logContext: MultipartLogContext,
): Promise<void> {
  try {
    await abortMultipartUpload(target.key, target.uploadId)
  } catch (err) {
    aiLogger.warn(
      { ...logContext, error: safeErrorInfo(err) },
      'Multipart cleanup abort failed',
    )
  }
}

async function bestEffortDeleteObject(
  key: string,
  ownerUserId: string,
  logContext: MultipartLogContext,
): Promise<void> {
  try {
    const identity = parseRecordingArtifactKey(key, ownerUserId)
    if (!identity) {
      throw new RecordingArtifactKeyRejectedError()
    }
    await deleteFromR2(key, {
      ownerUserId,
      sessionId: identity.sessionId,
    })
  } catch (err) {
    aiLogger.warn(
      { ...logContext, error: safeErrorInfo(err) },
      'Multipart completed-object cleanup failed',
    )
  }
}

async function requireOwnedSession(sessionId: string | undefined, userId: string) {
  if (!sessionId || !mongoose.Types.ObjectId.isValid(sessionId)) {
    return null
  }
  await connectDB()
  return InterviewSession.exists({ _id: sessionId, userId })
}

async function sessionAlreadyReferencesRecording(
  type: RecordingType,
  sessionId: string,
  userId: string,
  key: string,
  sizeBytes: number,
): Promise<boolean> {
  const { keyField, sizeField } = persistedFieldNames(type)
  const existing = await InterviewSession.findOne({ _id: sessionId, userId })
    .select(`${keyField} ${sizeField}`)
    .lean() as Record<string, unknown> | null
  return existing?.[keyField] === key && Number(existing?.[sizeField]) === sizeBytes
}

/**
 * POST /api/storage/multipart
 * R2 multipart upload orchestration for large replay recordings.
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return privateJson({ error: 'Unauthorized' }, 401)
  }
  const userId = session.user.id
  const originUserId = req.headers.get('x-origin-user-id')
  if (originUserId !== null && originUserId !== userId) {
    return privateJson(
      { error: 'sign-in session changed', code: 'SESSION_CHANGED' },
      409,
    )
  }
  const logContext: MultipartLogContext = {}
  let cleanupTarget: MultipartCleanupTarget | undefined
  let completedObjectKey: string | undefined
  try {
    const parsed = MultipartSchema.safeParse(await req.json())
    if (!parsed.success) {
      return privateJson({ error: 'Invalid request' }, 400)
    }

    const { action, type, sessionId, key, uploadId, partNumber, parts, sizeBytes, durationSeconds } = parsed.data
    Object.assign(logContext, {
      action,
      type,
      sessionId,
      keySuffix: key ? key.slice(-120) : undefined,
      partNumber,
      partCount: parts?.length,
      sizeBytes,
    })

    // Capture cleanup authority before the admission check. Exact 401 makes
    // the browser purge its queued upload record, so this request is the last
    // reliable opportunity to abort parts or remove a lost-success object.
    if (key && uploadId && isOwnedRecordingKey(key, userId)) {
      cleanupTarget = { key, uploadId }
    }

    // Abort is cleanup-only and remains available after the durable account
    // deletion barrier has been raised. Every action that can mint new R2
    // authority or materialize an object is denied before that work begins.
    if (action !== 'abort') {
      await connectDB()
      if (!(await isJobsAccountActive(userId))) {
        if (cleanupTarget && action === 'complete') {
          await Promise.all([
            bestEffortDeleteObject(cleanupTarget.key, userId, logContext),
            bestEffortAbort(cleanupTarget, logContext),
          ])
        } else if (cleanupTarget && action === 'sign-part') {
          await bestEffortAbort(cleanupTarget, logContext)
        }
        return accountUnavailableResponse()
      }
    }
    if (!isR2Configured()) {
      return privateJson({ error: 'Storage not configured' }, 503)
    }

    if (action === 'create') {
      if (!type || !sessionId) {
        return privateJson({ error: 'type and sessionId required' }, 400)
      }
      const ownsSession = await requireOwnedSession(sessionId, userId)
      if (!ownsSession) {
        if (!(await isJobsAccountActive(userId))) {
          return accountUnavailableResponse()
        }
        return privateJson({ error: 'Forbidden' }, 403)
      }
      if (!(await isJobsAccountActive(userId))) {
        return accountUnavailableResponse()
      }

      const r2Key = keyFor(type, userId, sessionId)
      const contentType = contentTypeFor(type)
      const created = await createMultipartUpload(r2Key, contentType)
      cleanupTarget = { key: created.key, uploadId: created.uploadId }

      if (!(await requireOwnedSession(sessionId, userId))) {
        await bestEffortAbort(cleanupTarget, logContext)
        if (!(await isJobsAccountActive(userId))) {
          return accountUnavailableResponse()
        }
        return privateJson({ error: 'Forbidden' }, 403)
      }
      if (!(await isJobsAccountActive(userId))) {
        await bestEffortAbort(cleanupTarget, logContext)
        return accountUnavailableResponse()
      }

      return privateJson({
        key: created.key,
        uploadId: created.uploadId,
        contentType,
        partSizeBytes: PART_SIZE_BYTES,
      })
    }

    if (!key || !uploadId || !isOwnedRecordingKey(key, userId)) {
      return privateJson({ error: 'Forbidden' }, 403)
    }
    cleanupTarget = { key, uploadId }

    if (action === 'sign-part') {
      if (!partNumber) {
        return privateJson({ error: 'partNumber required' }, 400)
      }
      const keyIdentity = parseRecordingArtifactKey(key, userId)
      if (
        !keyIdentity ||
        (type !== undefined && type !== keyIdentity.type) ||
        (sessionId !== undefined && sessionId !== keyIdentity.sessionId) ||
        !(await requireOwnedSession(keyIdentity.sessionId, userId))
      ) {
        if (!(await isJobsAccountActive(userId))) {
          await bestEffortAbort(cleanupTarget, logContext)
          return accountUnavailableResponse()
        }
        return privateJson({ error: 'Forbidden' }, 403)
      }
      const url = await getMultipartPartPresignedUrl(key, uploadId, partNumber)
      const stillOwnsSession = await requireOwnedSession(keyIdentity.sessionId, userId)
      if (!(await isJobsAccountActive(userId))) {
        // The signed URL is withheld, and aborting invalidates this multipart
        // transaction as a best-effort compensation.
        await bestEffortAbort(cleanupTarget, logContext)
        return accountUnavailableResponse()
      }
      if (!stillOwnsSession) {
        await bestEffortAbort(cleanupTarget, logContext)
        return privateJson({ error: 'Forbidden' }, 403)
      }
      return privateJson({ url })
    }

    if (action === 'complete') {
      if (!type || !sessionId || !parts?.length || sizeBytes === undefined) {
        return privateJson({ error: 'type, sessionId, parts, and sizeBytes required' }, 400)
      }
      const ownsSession = await requireOwnedSession(sessionId, userId)
      if (!ownsSession || !isSessionRecordingKey(key, type, userId, sessionId)) {
        await bestEffortAbort(cleanupTarget, logContext)
        if (!(await isJobsAccountActive(userId))) {
          return accountUnavailableResponse()
        }
        return privateJson({ error: 'Forbidden' }, 403)
      }
      // This is deliberately a compensating fence, not durable R2 atomicity:
      // deletion can still interleave after this predicate and before R2
      // acknowledges completion, so the egress checks below remove the object.
      if (!(await isJobsAccountActive(userId))) {
        await bestEffortAbort(cleanupTarget, logContext)
        return accountUnavailableResponse()
      }

      try {
        await completeMultipartUpload(
          key,
          uploadId,
          parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag }))
        )
        completedObjectKey = key
      } catch (err) {
        if (!isNoSuchUploadError(err)) throw err
        // NoSuchUpload covers three cases: already-completed (object exists
        // at `key` from a prior call), aborted, and expired. Only the first
        // is a legitimate retry recovery — verify the object actually exists
        // before patching the session, otherwise we'd silently persist a
        // pointer to a non-existent replay. 410 Gone signals that the
        // upload is permanently unrecoverable (R2 has discarded the parts);
        // the queued client record can stop retrying.
        if (!(await objectExists(key))) {
          if (await sessionAlreadyReferencesRecording(type, sessionId, userId, key, sizeBytes)) {
            if (!(await isJobsAccountActive(userId))) {
              return accountUnavailableResponse()
            }
            aiLogger.warn(
              { ...logContext, status: 'already-persisted' },
              'Multipart complete retried after session was already patched',
            )
            return privateJson({ key })
          }
          if (!(await isJobsAccountActive(userId))) {
            return accountUnavailableResponse()
          }
          return privateJson({ error: 'Multipart upload no longer recoverable' }, 410)
        }
        completedObjectKey = key
      }

      if (!(await isJobsAccountActive(userId))) {
        await bestEffortDeleteObject(key, userId, logContext)
        return accountUnavailableResponse()
      }
      try {
        const associated = await associateRecordingArtifact({
          userId,
          sessionId,
          type,
          key,
          sizeBytes,
          durationSeconds,
        })
        if (!associated.accepted) {
          await bestEffortDeleteObject(key, userId, logContext)
          return privateJson({ key, superseded: true })
        }
        await cleanupSupersededRecordingArtifact(
          associated.previousKey,
          key,
          userId,
          sessionId,
        )
      } catch (associationError) {
        if (
          associationError instanceof RecordingArtifactSessionNotFoundError ||
          associationError instanceof RecordingArtifactKeyRejectedError
        ) {
          await bestEffortDeleteObject(key, userId, logContext)
          if (!(await isJobsAccountActive(userId))) {
            return accountUnavailableResponse()
          }
          return privateJson({ error: 'Forbidden' }, 403)
        }
        if (associationError instanceof JobsAccountInactiveError) {
          await bestEffortDeleteObject(key, userId, logContext)
          return accountUnavailableResponse()
        }
        if (associationError instanceof JobsAccountTransactionsRequiredError) {
          await bestEffortDeleteObject(key, userId, logContext)
          return privateJson(
            { error: 'Recording finalization requires MongoDB transactions', code: 'TRANSACTIONS_REQUIRED' },
            503,
          )
        }
        throw associationError
      }
      if (!(await isJobsAccountActive(userId))) {
        await bestEffortDeleteObject(key, userId, logContext)
        return accountUnavailableResponse()
      }
      return privateJson({ key })
    }

    await abortMultipartUpload(key, uploadId)
    await connectDB()
    if (!(await isJobsAccountActive(userId))) {
      return accountUnavailableResponse()
    }
    return privateJson({ ok: true })
  } catch (err) {
    let accountInactive = false
    try {
      await connectDB()
      accountInactive = !(await isJobsAccountActive(userId))
    } catch (recheckError) {
      aiLogger.warn(
        { ...logContext, error: safeErrorInfo(recheckError) },
        'Multipart account-state exception recheck failed',
      )
    }

    if (logContext.action === 'create' && cleanupTarget) {
      // A create response that fails before egress must not strand a newly
      // created multipart transaction, even if account state is still active.
      await bestEffortAbort(cleanupTarget, logContext)
    } else if (accountInactive && cleanupTarget && logContext.action !== 'complete') {
      await bestEffortAbort(cleanupTarget, logContext)
    }

    if (accountInactive && cleanupTarget && logContext.action === 'complete') {
      try {
        if (completedObjectKey || await objectExists(cleanupTarget.key)) {
          await bestEffortDeleteObject(cleanupTarget.key, userId, logContext)
        }
      } catch (cleanupProbeError) {
        aiLogger.warn(
          { ...logContext, error: safeErrorInfo(cleanupProbeError) },
          'Multipart completed-object cleanup probe failed',
        )
      }
    }

    aiLogger.error({
      ...logContext,
      error: safeErrorInfo(err),
    }, 'Multipart upload failed')
    if (accountInactive) return accountUnavailableResponse()
    return privateJson({ error: 'Multipart upload failed' }, 500)
  }
}
