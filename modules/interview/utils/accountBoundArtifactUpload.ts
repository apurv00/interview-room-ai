'use client'

import {
  assertReplayUploadOperationActive,
  beginReplayUploadOperation,
  finishReplayUploadOperation,
  isReplayUploadPrivacyCancellation,
} from '@shared/services/replayUploadPrivacy'
import { clearAllInterviewStorage } from '@shared/storageKeys'
import type { ReplayUploadIntent } from './resumableUpload'

type RecordingArtifactKind = 'camera' | 'audio'

interface AccountBoundJsonRequestOptions {
  keepalive?: boolean
  method?: 'POST' | 'PATCH'
  /**
   * Bound one network attempt without weakening the replay privacy fence.
   * Omit this for existing callers that intentionally retain their current
   * request lifetime.
   */
  timeoutMs?: number
}

async function isTerminalAccountBoundary(response: Response): Promise<boolean> {
  if (response.status !== 401 && response.status !== 409) return false
  const readable = typeof response.clone === 'function' ? response.clone() : response
  const body = await readable.json().catch(() => null) as { code?: unknown } | null
  return (response.status === 401 && body?.code === 'ACCOUNT_UNAVAILABLE') ||
    (response.status === 409 && body?.code === 'SESSION_CHANGED')
}

async function establishAccountUnavailableBoundary(): Promise<void> {
  // clearAllInterviewStorage establishes the replay-upload cancellation
  // generation synchronously before its best-effort IndexedDB purge awaits.
  await clearAllInterviewStorage().catch(() => {})
}

/**
 * Upload the small audio/camera artifact through presign -> R2 -> session
 * association while sharing the recorder's privacy generation.
 *
 * This is a browser cancellation/egress fence, not durable R2 atomicity: an
 * already-issued presigned PUT cannot be revoked after Cloudflare receives it.
 */
export async function uploadRecordingArtifact(
  blob: Blob,
  sessionId: string,
  kind: RecordingArtifactKind,
  intent: ReplayUploadIntent,
  originUserId: string,
): Promise<boolean> {
  const operation = beginReplayUploadOperation(intent.privacyGeneration)
  try {
    assertReplayUploadOperationActive(operation)
    const presignType = kind === 'audio' ? 'audio-recording' : 'recording'
    const presignRes = await fetch('/api/storage/presign', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-origin-user-id': originUserId,
      },
      body: JSON.stringify({
        action: 'upload',
        type: presignType,
        sessionId,
      }),
      signal: operation.signal,
    })
    assertReplayUploadOperationActive(operation)
    if (await isTerminalAccountBoundary(presignRes)) {
      await establishAccountUnavailableBoundary()
      return false
    }
    if (!presignRes.ok) {
      console.error('Presign request failed:', presignRes.status)
      return false
    }

    const { url, key, contentType } = await presignRes.json()
    assertReplayUploadOperationActive(operation)
    const uploadContentType =
      contentType ||
      blob.type ||
      (kind === 'audio' ? 'audio/webm' : 'video/webm')

    const uploadRes = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': uploadContentType },
      body: blob,
      signal: operation.signal,
    })
    assertReplayUploadOperationActive(operation)
    if (!uploadRes.ok) {
      console.error('R2 upload failed:', uploadRes.status)
      return false
    }

    const finalizeRes = await fetch('/api/recordings/finalize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-origin-user-id': originUserId,
      },
      body: JSON.stringify({
        type: presignType,
        sessionId,
        key,
        sizeBytes: blob.size,
      }),
      signal: operation.signal,
    })
    assertReplayUploadOperationActive(operation)
    if (await isTerminalAccountBoundary(finalizeRes)) {
      await establishAccountUnavailableBoundary()
      return false
    }
    if (!finalizeRes.ok) {
      console.error('Failed to finalize recording artifact:', finalizeRes.status)
      return false
    }
    return true
  } catch (error) {
    if (!isReplayUploadPrivacyCancellation(error, operation)) {
      console.error('Recording upload error:', error)
    }
    return false
  } finally {
    finishReplayUploadOperation(operation)
  }
}

/** Execute one small account-bound JSON request under a replay privacy intent. */
export async function requestAccountBoundJson(
  url: string,
  body: unknown,
  intent: ReplayUploadIntent,
  originUserId: string,
  options: AccountBoundJsonRequestOptions = {},
): Promise<Response | null> {
  const operation = beginReplayUploadOperation(intent.privacyGeneration)
  const requestController = options.timeoutMs && options.timeoutMs > 0
    ? new AbortController()
    : null
  const abortRequest = () => requestController?.abort()
  const timeout = requestController
    ? setTimeout(abortRequest, options.timeoutMs)
    : undefined
  if (requestController) {
    operation.signal.addEventListener('abort', abortRequest, { once: true })
    if (operation.signal.aborted) abortRequest()
  }
  try {
    assertReplayUploadOperationActive(operation)
    const response = await fetch(url, {
      method: options.method ?? 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-origin-user-id': originUserId,
      },
      body: JSON.stringify(body),
      signal: requestController?.signal ?? operation.signal,
      keepalive: options.keepalive,
    })
    assertReplayUploadOperationActive(operation)
    if (await isTerminalAccountBoundary(response)) {
      await establishAccountUnavailableBoundary()
      return null
    }
    return response
  } catch (error) {
    if (!isReplayUploadPrivacyCancellation(error, operation)) throw error
    return null
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    if (requestController) {
      operation.signal.removeEventListener('abort', abortRequest)
    }
    finishReplayUploadOperation(operation)
  }
}
