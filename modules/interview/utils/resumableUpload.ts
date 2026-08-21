'use client'

import {
  assertReplayUploadOperationActive,
  beginReplayUploadOperation,
  bindReplayUploadTransaction,
  currentReplayUploadPrivacyGeneration,
  finishReplayUploadOperation,
  isReplayUploadPrivacyCancellation,
  REPLAY_UPLOAD_DB_NAME,
  REPLAY_UPLOAD_DB_VERSION,
  REPLAY_UPLOAD_STORE_NAME,
  trackReplayUploadDatabase,
  __resetReplayUploadPrivacyForTests,
  type ReplayUploadOperation,
} from '@shared/services/replayUploadPrivacy'
import { clearAllInterviewStorage } from '@shared/storageKeys'

export type ReplayUploadKind = 'camera' | 'screen'
export type ReplayUploadStatus = 'uploaded' | 'queued' | 'dropped'
export type RequiredReplayUnavailableReason =
  | 'capture_failed'
  | 'durable_queue_failed'
  | 'upload_rejected'
  | 'retry_exhausted'
  | 'upload_expired'

export interface ReplayUploadResult {
  status: ReplayUploadStatus
}

export interface ReplayUploadIntent {
  readonly privacyGeneration: number
  readonly originUserId?: string
}

/**
 * Capture before recorder shutdown begins. If account cleanup occurs while
 * the recorder is still materializing its Blob, the eventual upload inherits
 * the old generation and is rejected instead of becoming fresh activity.
 */
export function captureReplayUploadIntent(originUserId?: string): ReplayUploadIntent {
  return {
    privacyGeneration: currentReplayUploadPrivacyGeneration(),
    ...(originUserId ? { originUserId } : {}),
  }
}

export interface DrainReplayUploadsResult {
  attempted: number
  uploaded: number
  queued: number
  dropped: number
  /** Records skipped because another tab/invocation holds an active lease. */
  skipped: number
}

export interface RequiredHireReplaySettlement {
  uploadedKinds: ReplayUploadKind[]
  pendingKinds: ReplayUploadKind[]
  acknowledgedUnavailableKinds: ReplayUploadKind[]
}

interface UploadedPart {
  partNumber: number
  etag: string
}

interface QueuedReplayUpload {
  id: string
  sessionId: string
  kind: ReplayUploadKind
  blob: Blob
  sizeBytes: number
  contentType: string
  /** Account that owned the browser session when recording stopped. */
  originUserId?: string
  // Recorder-truth span, persisted in IDB so a drain on a LATER page mount
  // (where the interview tab's own duration PATCH never ran) still delivers
  // it to the server at multipart 'complete'.
  durationSeconds?: number
  createdAt: number
  key?: string
  uploadId?: string
  partSizeBytes?: number
  parts: UploadedPart[]
  attempts: number
  lastError?: string
  // Layer 2 — IDB lease for cross-tab/process race protection. `leaseHolder` is
  // the PROCESS_ID of the tab currently uploading; other tabs skip when the
  // lease is held and unexpired. Leases naturally expire after LEASE_TTL_MS so
  // a crashed tab cannot block retries forever.
  leaseHolder?: string
  leaseExpiresAt?: number
  /** Missing means a legacy pending row written before this contract. */
  deliveryState?: 'pending' | 'unavailable'
  /** Required Hire evidence always uses the durable multipart path. */
  requiredDelivery?: boolean
  unavailableReason?: RequiredReplayUnavailableReason
}

interface MultipartCreateResponse {
  key: string
  uploadId: string
  contentType: string
  partSizeBytes: number
}

class PermanentMultipartUploadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermanentMultipartUploadError'
  }
}

class MultipartUploadGoneError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MultipartUploadGoneError'
  }
}

async function isTerminalAccountBoundary(response: Response): Promise<boolean> {
  if (response.status !== 401 && response.status !== 409 && response.status !== 410) {
    return false
  }
  const readable = typeof response.clone === 'function' ? response.clone() : response
  const body = await readable.json().catch(() => null) as { code?: unknown } | null
  return ((response.status === 401 || response.status === 410) &&
      body?.code === 'ACCOUNT_UNAVAILABLE') ||
    (response.status === 409 && body?.code === 'SESSION_CHANGED')
}

async function establishAccountUnavailableBoundary(): Promise<void> {
  // Cancellation/generation invalidation is synchronous inside this helper;
  // the returned promise only represents the bounded IndexedDB purge.
  await clearAllInterviewStorage().catch(() => {})
}

function isPermanentMultipartUploadError(err: unknown): err is PermanentMultipartUploadError {
  return err instanceof PermanentMultipartUploadError
}

function isMultipartUploadGoneError(err: unknown): err is MultipartUploadGoneError {
  return err instanceof MultipartUploadGoneError
}

const DEFAULT_PART_SIZE_BYTES = 8 * 1024 * 1024
const DIRECT_UPLOAD_LIMIT_BYTES = 20 * 1024 * 1024
const MAX_PART_RETRIES = 3
const MAX_CONCURRENT_PARTS = 3
const INDEXED_DB_OPEN_TIMEOUT_MS = 2_000
const INDEXED_DB_TRANSACTION_TIMEOUT_MS = 2_000

// Layer 2/3 — concurrency control + zombie cleanup constants.
//
// LEASE_TTL_MS: long enough that a typical 4-part upload (~10s end-to-end) can
// hold the lease across its full duration without renewal hiccups, short enough
// that a crashed tab does not block recovery for more than ~1 minute. The
// uploadMultipartRecord worker refreshes the lease on every part write, so
// active uploads keep extending it.
//
// MAX_DRAIN_ATTEMPTS: hard cap on retry storm. A record that consistently
// fails 5 drain attempts is permanently unrecoverable from this client; we
// drop it (and best-effort tell the server to release R2 multipart parts).
//
// MAX_RECORD_AGE_MS: absolute upper bound. R2 multipart uploads typically
// expire within 7 days, so any record older than that has a dead uploadId
// regardless of attempts. Drop on sight.
const LEASE_TTL_MS = 60_000
const MAX_DRAIN_ATTEMPTS = 5
const MAX_RECORD_AGE_MS = 7 * 24 * 60 * 60 * 1000

// PROCESS_ID — unique per tab, used as the `leaseHolder` value so a tab can
// recognise its own leases vs another tab's. randomUUID is available in all
// browsers we ship to; the Math.random fallback is for unusual test envs.
const PROCESS_ID: string = (() => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `proc-${Math.random().toString(36).slice(2)}-${Date.now()}`
})()

// Layer 1 — in-memory lock that deterministically prevents same-tab races
// between uploadReplayRecording and drainQueuedReplayUploads (the bug
// observed in production on 2026-05-14). Layer 2's IDB lease is the
// cross-tab fallback for cases this Set cannot see (separate tabs, hard
// reloads). The Set is module-scoped and persists across client-side
// navigation within the tab.
const inFlightRecordIds = new Set<string>()

/**
 * Test-only reset. Vitest's `beforeEach` should call this so module state
 * does not leak between tests. Not exported through the barrel.
 * @internal
 */
export function __resetForTests(): void {
  inFlightRecordIds.clear()
  __resetReplayUploadPrivacyForTests()
}

function uploadTypeFor(kind: ReplayUploadKind): 'recording' | 'screen-recording' {
  return kind === 'screen' ? 'screen-recording' : 'recording'
}

function isBrowserStorageAvailable(): boolean {
  return typeof window !== 'undefined' && typeof indexedDB !== 'undefined'
}

interface OpenReplayUploadDb {
  db: IDBDatabase
  untrack: () => void
}

function openDb(operation: ReplayUploadOperation): Promise<OpenReplayUploadDb | null> {
  assertReplayUploadOperationActive(operation)
  if (!isBrowserStorageAvailable()) return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest
    let settled = false
    let timeout: number | undefined
    const finish = (value: OpenReplayUploadDb | null, error?: unknown) => {
      if (settled) return
      settled = true
      if (timeout !== undefined) window.clearTimeout(timeout)
      operation.signal.removeEventListener('abort', onAbort)
      if (error !== undefined) reject(error)
      else resolve(value)
    }
    const onAbort = () => {
      try {
        assertReplayUploadOperationActive(operation)
        finish(null)
      } catch (error) {
        finish(null, error)
      }
    }
    timeout = window.setTimeout(
      () => finish(null),
      INDEXED_DB_OPEN_TIMEOUT_MS,
    )
    operation.signal.addEventListener('abort', onAbort, { once: true })
    try {
      request = indexedDB.open(REPLAY_UPLOAD_DB_NAME, REPLAY_UPLOAD_DB_VERSION)
    } catch {
      finish(null)
      return
    }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(REPLAY_UPLOAD_STORE_NAME)) {
        db.createObjectStore(REPLAY_UPLOAD_STORE_NAME, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => {
      const db = request.result
      if (settled) {
        db.close()
        return
      }
      try {
        assertReplayUploadOperationActive(operation)
        finish({ db, untrack: trackReplayUploadDatabase(db) })
      } catch (error) {
        db.close()
        finish(null, error)
      }
    }
    request.onerror = () => finish(null)
    request.onblocked = () => finish(null)
  })
}

async function withStore<T>(
  mode: IDBTransactionMode,
  callback: (store: IDBObjectStore) => IDBRequest<T>,
  operation: ReplayUploadOperation,
): Promise<T | null> {
  assertReplayUploadOperationActive(operation)
  const opened = await openDb(operation)
  if (!opened) return null
  const { db, untrack } = opened
  return new Promise((resolve, reject) => {
    let settled = false
    let timeout: number | undefined
    let requestResult: T | null = null
    let requestSucceeded = false
    let tx: IDBTransaction
    try {
      tx = db.transaction(REPLAY_UPLOAD_STORE_NAME, mode)
    } catch {
      untrack()
      db.close()
      resolve(null)
      return
    }
    const unbindAbort = bindReplayUploadTransaction(operation, tx)
    const cleanup = () => {
      if (timeout !== undefined) window.clearTimeout(timeout)
      operation.signal.removeEventListener('abort', finishCancelledOrNull)
      unbindAbort()
      untrack()
      db.close()
    }
    const finish = (result: T | null) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }
    const finishCancelledOrNull = () => {
      if (settled) return
      settled = true
      cleanup()
      try {
        assertReplayUploadOperationActive(operation)
        resolve(null)
      } catch (error) {
        reject(error)
      }
    }

    timeout = window.setTimeout(() => {
      try {
        tx.abort()
      } catch {
        // The transaction may already have settled at the deadline.
      }
      finishCancelledOrNull()
    }, INDEXED_DB_TRANSACTION_TIMEOUT_MS)
    operation.signal.addEventListener('abort', finishCancelledOrNull, { once: true })

    let request: IDBRequest<T>
    try {
      request = callback(tx.objectStore(REPLAY_UPLOAD_STORE_NAME))
    } catch {
      try {
        tx.abort()
      } catch {
        // Object-store access may fail after transaction construction.
      }
      finishCancelledOrNull()
      return
    }

    request.onsuccess = () => {
      requestSucceeded = true
      requestResult = request.result
    }
    request.onerror = () => {
      requestSucceeded = false
      requestResult = null
    }
    tx.oncomplete = () => {
      try {
        assertReplayUploadOperationActive(operation)
        finish(requestSucceeded ? requestResult : null)
      } catch (error) {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
    }
    tx.onerror = finishCancelledOrNull
    tx.onabort = finishCancelledOrNull
  })
}

async function putUpload(
  record: QueuedReplayUpload,
  operation: ReplayUploadOperation,
): Promise<boolean> {
  const result = await withStore('readwrite', (store) => store.put(record), operation)
  return result !== null
}

async function deleteUpload(id: string, operation: ReplayUploadOperation): Promise<void> {
  await withStore('readwrite', (store) => store.delete(id), operation)
}

async function getAllUploads(operation: ReplayUploadOperation): Promise<QueuedReplayUpload[]> {
  return (await withStore('readonly', (store) => store.getAll(), operation)) ?? []
}

function isUnavailableRecord(
  record: QueuedReplayUpload,
): record is QueuedReplayUpload & {
  deliveryState: 'unavailable'
  unavailableReason: RequiredReplayUnavailableReason
} {
  return (
    record.deliveryState === 'unavailable' &&
    record.unavailableReason !== undefined
  )
}

function unavailableRecord(
  record: QueuedReplayUpload,
  reason: RequiredReplayUnavailableReason,
): QueuedReplayUpload {
  return {
    ...record,
    blob: new Blob([], { type: record.contentType || 'video/webm' }),
    sizeBytes: 0,
    parts: [],
    attempts: 0,
    deliveryState: 'unavailable',
    requiredDelivery: true,
    unavailableReason: reason,
    leaseHolder: undefined,
    leaseExpiresAt: undefined,
  }
}

/**
 * Persist capture/queue failure before navigation. The marker contains no
 * media bytes and remains until the authenticated completion endpoint has
 * durably recorded the unavailable evidence kind.
 */
export async function recordRequiredReplayUnavailable(
  sessionId: string,
  kind: ReplayUploadKind,
  reason: RequiredReplayUnavailableReason,
  intent?: ReplayUploadIntent,
): Promise<boolean> {
  const operation = beginReplayUploadOperation(intent?.privacyGeneration)
  try {
    const record: QueuedReplayUpload = {
      id: `${sessionId}:${kind}:terminal-unavailable`,
      sessionId,
      kind,
      blob: new Blob([], { type: 'video/webm' }),
      sizeBytes: 0,
      contentType: 'video/webm',
      ...(intent?.originUserId ? { originUserId: intent.originUserId } : {}),
      createdAt: Date.now(),
      parts: [],
      attempts: 0,
      deliveryState: 'unavailable',
      requiredDelivery: true,
      unavailableReason: reason,
    }
    return await putUpload(record, operation)
  } catch (error) {
    if (isReplayUploadPrivacyCancellation(error, operation)) return false
    throw error
  } finally {
    finishReplayUploadOperation(operation)
  }
}

async function postMultipart<T>(
  body: Record<string, unknown>,
  operation: ReplayUploadOperation,
  originUserId?: string,
): Promise<T> {
  assertReplayUploadOperationActive(operation)
  const res = await fetch('/api/storage/multipart', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(originUserId ? { 'x-origin-user-id': originUserId } : {}),
    },
    body: JSON.stringify(body),
    signal: operation.signal,
  })
  assertReplayUploadOperationActive(operation)
  if (await isTerminalAccountBoundary(res)) {
    await establishAccountUnavailableBoundary()
    assertReplayUploadOperationActive(operation)
  }
  assertReplayUploadOperationActive(operation)
  if (!res.ok) {
    const responseText = await res.text().catch(() => '')
    assertReplayUploadOperationActive(operation)
    const message = `Multipart API failed: ${res.status}${responseText ? ` ${responseText.slice(0, 300)}` : ''}`
    // 410 means this multipart identity has expired. The Blob remains durable
    // and the next bounded attempt mints a fresh key/uploadId. 401/403 mean
    // the user is signed out: retrying with the same cookie will
    // never succeed; the record is unrecoverable from this client. Marking
    // them permanent prevents an infinite retry loop that would otherwise
    // pile up zombie records on every page mount.
    if (res.status === 410) {
      const responseBody = (() => {
        try {
          return JSON.parse(responseText) as { code?: unknown }
        } catch {
          return null
        }
      })()
      if (responseBody?.code === 'ACCOUNT_UNAVAILABLE') {
        await establishAccountUnavailableBoundary()
        assertReplayUploadOperationActive(operation)
      }
      if (
        responseBody?.code === 'MEDIA_TERMINAL' ||
        responseBody?.code === 'RUNTIME_WRITE_UNAVAILABLE'
      ) {
        throw new PermanentMultipartUploadError(message)
      }
      throw new MultipartUploadGoneError(message)
    }
    if (res.status === 401 || res.status === 403) {
      throw new PermanentMultipartUploadError(message)
    }
    throw new Error(message)
  }
  const result = await res.json() as T
  assertReplayUploadOperationActive(operation)
  return result
}

function resetGoneMultipart(
  record: QueuedReplayUpload,
  error: MultipartUploadGoneError,
): QueuedReplayUpload {
  return {
    ...record,
    key: undefined,
    uploadId: undefined,
    partSizeBytes: undefined,
    parts: [],
    attempts: record.attempts + 1,
    lastError: error.message,
    leaseHolder: undefined,
    leaseExpiresAt: undefined,
  }
}

function normaliseEtag(etag: string | null): string {
  if (!etag) throw new Error('R2 part upload did not return an ETag')
  return etag
}

function getPartCount(sizeBytes: number, partSizeBytes: number): number {
  return Math.max(1, Math.ceil(sizeBytes / partSizeBytes))
}

export function getPartRange(
  partNumber: number,
  sizeBytes: number,
  partSizeBytes = DEFAULT_PART_SIZE_BYTES
): { start: number; end: number } {
  const start = (partNumber - 1) * partSizeBytes
  return { start, end: Math.min(start + partSizeBytes, sizeBytes) }
}

async function uploadPartWithRetry(
  url: string,
  chunk: Blob,
  contentType: string,
  operation: ReplayUploadOperation,
): Promise<string> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_PART_RETRIES; attempt++) {
    try {
      assertReplayUploadOperationActive(operation)
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: chunk,
        signal: operation.signal,
      })
      assertReplayUploadOperationActive(operation)
      if (!res.ok) throw new Error(`Part upload failed: ${res.status}`)
      return normaliseEtag(res.headers.get('ETag'))
    } catch (err) {
      if (isReplayUploadPrivacyCancellation(err, operation)) throw err
      lastError = err
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          operation.signal.removeEventListener('abort', abortDelay)
          resolve()
        }, 400 * attempt)
        const abortDelay = () => {
          window.clearTimeout(timeout)
          reject(err)
        }
        operation.signal.addEventListener('abort', abortDelay, { once: true })
      })
      assertReplayUploadOperationActive(operation)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Part upload failed')
}

async function ensureMultipart(
  record: QueuedReplayUpload,
  operation: ReplayUploadOperation,
): Promise<QueuedReplayUpload> {
  if (record.key && record.uploadId && record.partSizeBytes) return record

  const created = await postMultipart<MultipartCreateResponse>({
    action: 'create',
    type: uploadTypeFor(record.kind),
    sessionId: record.sessionId,
  }, operation, record.originUserId)

  const next = {
    ...record,
    key: created.key,
    uploadId: created.uploadId,
    contentType: created.contentType,
    partSizeBytes: created.partSizeBytes,
  }
  await putUpload(next, operation)
  return next
}

async function completeMultipart(
  record: QueuedReplayUpload,
  operation: ReplayUploadOperation,
): Promise<string> {
  const result = await postMultipart<{ key: string }>({
    action: 'complete',
    type: uploadTypeFor(record.kind),
    sessionId: record.sessionId,
    key: record.key,
    uploadId: record.uploadId,
    parts: record.parts,
    sizeBytes: record.sizeBytes,
    ...(record.durationSeconds !== undefined ? { durationSeconds: record.durationSeconds } : {}),
  }, operation, record.originUserId)
  return result.key
}

// ── Layer 2/3 helpers ──────────────────────────────────────────────────────

function isLeaseHeldByOther(record: QueuedReplayUpload): boolean {
  if (!record.leaseExpiresAt || !record.leaseHolder) return false
  if (record.leaseExpiresAt <= Date.now()) return false
  return record.leaseHolder !== PROCESS_ID
}

function isExpiredRecord(record: QueuedReplayUpload): boolean {
  return Date.now() - record.createdAt > MAX_RECORD_AGE_MS
}

function isExhaustedRetries(record: QueuedReplayUpload): boolean {
  return record.attempts >= MAX_DRAIN_ATTEMPTS
}

/**
 * Acquire the lease on a record. Returns the leased record on success, or
 * null if another tab/process beat us to it.
 *
 * Layer 1 (same-tab) — the inFlightRecordIds Set check + add is performed
 * SYNCHRONOUSLY before any await. JS is single-threaded but each `await`
 * yields the event loop, so any check-then-await-then-add pattern can lose
 * a same-tab race (e.g., two concurrent drainQueuedReplayUploads calls
 * triggered by /interview and /feedback page mounts firing back-to-back).
 * The Vercel Agent caught exactly this on the first version of this fix —
 * the add now happens immediately after the has-check.
 *
 * Layer 2 (cross-tab) — the IDB write + re-read pattern is a poor-man's CAS
 * (IndexedDB has no native compare-and-swap). Two tabs that race the IDB
 * write could both think they have the lease, but the server's idempotent
 * complete path ([app/api/storage/multipart/route.ts:230-249]) absorbs the
 * second `complete` without corruption.
 */
async function tryAcquireLease(
  record: QueuedReplayUpload,
  operation: ReplayUploadOperation,
): Promise<QueuedReplayUpload | null> {
  assertReplayUploadOperationActive(operation)
  if (inFlightRecordIds.has(record.id)) return null
  if (isLeaseHeldByOther(record)) return null
  // CRITICAL: add to the in-memory Set BEFORE any await. This closes the
  // drain-vs-drain race that the original implementation had — the previous
  // version delayed the .add() until after the IDB write+verify, leaving a
  // window where two concurrent calls could both pass the .has() check.
  inFlightRecordIds.add(record.id)

  try {
    const leased: QueuedReplayUpload = {
      ...record,
      leaseHolder: PROCESS_ID,
      leaseExpiresAt: Date.now() + LEASE_TTL_MS,
    }
    const written = await putUpload(leased, operation)
    if (!written) {
      inFlightRecordIds.delete(record.id)
      return null
    }

    // Re-read to confirm our lease landed (a concurrent writer in another tab
    // would have stomped it). If the row is gone, another process completed
    // the upload and deleted it — back off.
    const verified = (await getAllUploads(operation)).find((r) => r.id === record.id)
    if (!verified || verified.leaseHolder !== PROCESS_ID) {
      inFlightRecordIds.delete(record.id)
      return null
    }

    return verified
  } catch (err) {
    inFlightRecordIds.delete(record.id)
    throw err
  }
}

function releaseLease(recordId: string): void {
  inFlightRecordIds.delete(recordId)
}

/**
 * Best-effort server-side abort to release R2 multipart parts when we drop
 * a record. Failures here are swallowed: the worst case is R2 holds the
 * orphaned parts until its own multipart TTL (typically 7 days) cleans them.
 * We do not block the user-facing drain on this call.
 */
async function serverAbort(
  record: QueuedReplayUpload,
  operation: ReplayUploadOperation,
): Promise<void> {
  if (!record.key || !record.uploadId) return
  try {
    await postMultipart<{ ok: boolean }>({
      action: 'abort',
      key: record.key,
      uploadId: record.uploadId,
    }, operation, record.originUserId)
  } catch (err) {
    if (isReplayUploadPrivacyCancellation(err, operation)) throw err
    console.warn('Replay multipart abort failed (non-fatal)', err)
  }
}

async function uploadMultipartRecord(
  record: QueuedReplayUpload,
  operation: ReplayUploadOperation,
): Promise<string> {
  assertReplayUploadOperationActive(operation)
  let current = await ensureMultipart(record, operation)
  const partSizeBytes = current.partSizeBytes ?? DEFAULT_PART_SIZE_BYTES
  const partCount = getPartCount(current.sizeBytes, partSizeBytes)
  const uploaded = new Map(current.parts.map((part) => [part.partNumber, part.etag]))
  let nextPart = 1

  async function worker() {
    for (;;) {
      const partNumber = nextPart++
      if (partNumber > partCount) return
      if (uploaded.has(partNumber)) continue

      const { start, end } = getPartRange(partNumber, current.sizeBytes, partSizeBytes)
      const { url } = await postMultipart<{ url: string }>({
        action: 'sign-part',
        type: uploadTypeFor(current.kind),
        sessionId: current.sessionId,
        key: current.key,
        uploadId: current.uploadId,
        partNumber,
      }, operation, current.originUserId)
      const etag = await uploadPartWithRetry(
        url,
        current.blob.slice(start, end, current.contentType),
        current.contentType,
        operation,
      )
      uploaded.set(partNumber, etag)
      // Refresh the lease on every successful part. While the upload is
      // making progress, other tabs see the lease as continuously held;
      // the moment progress stops (crash, hang, network loss), the lease
      // expires within LEASE_TTL_MS and another drain can recover.
      current = {
        ...current,
        parts: Array.from(uploaded.entries()).map(([n, tag]) => ({ partNumber: n, etag: tag })),
        leaseHolder: PROCESS_ID,
        leaseExpiresAt: Date.now() + LEASE_TTL_MS,
      }
      await putUpload(current, operation)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_PARTS, partCount) }, () => worker())
  )
  current.parts = Array.from(uploaded.entries())
    .map(([partNumber, etag]) => ({ partNumber, etag }))
    .sort((a, b) => a.partNumber - b.partNumber)
  const key = await completeMultipart(current, operation)
  await deleteUpload(current.id, operation)
  return key
}

async function uploadDirect(
  sessionId: string,
  kind: ReplayUploadKind,
  blob: Blob,
  contentType: string,
  operation: ReplayUploadOperation,
  durationSeconds?: number,
  originUserId?: string,
): Promise<boolean> {
  assertReplayUploadOperationActive(operation)
  const res = await fetch('/api/storage/presign', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(originUserId ? { 'x-origin-user-id': originUserId } : {}),
    },
    body: JSON.stringify({
      action: 'upload',
      type: uploadTypeFor(kind),
      sessionId,
    }),
    signal: operation.signal,
  })
  assertReplayUploadOperationActive(operation)
  if (await isTerminalAccountBoundary(res)) {
    await establishAccountUnavailableBoundary()
    assertReplayUploadOperationActive(operation)
  }
  assertReplayUploadOperationActive(operation)
  if (!res.ok) return false

  const { url, key, contentType: presignedContentType } = await res.json()
  assertReplayUploadOperationActive(operation)
  const uploadRes = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': presignedContentType || contentType },
    body: blob,
    signal: operation.signal,
  })
  assertReplayUploadOperationActive(operation)
  if (!uploadRes.ok) return false

  const finalizeRes = await fetch('/api/recordings/finalize', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(originUserId ? { 'x-origin-user-id': originUserId } : {}),
    },
    body: JSON.stringify({
      type: uploadTypeFor(kind),
      sessionId,
      key,
      sizeBytes: blob.size,
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    }),
    signal: operation.signal,
  })
  assertReplayUploadOperationActive(operation)
  if (await isTerminalAccountBoundary(finalizeRes)) {
    await establishAccountUnavailableBoundary()
    assertReplayUploadOperationActive(operation)
  }
  assertReplayUploadOperationActive(operation)
  return finalizeRes.ok
}

export async function uploadReplayRecording(
  sessionId: string,
  kind: ReplayUploadKind,
  blob: Blob,
  durationSeconds?: number,
  intent?: ReplayUploadIntent,
  options: { requiredDelivery?: boolean } = {},
): Promise<ReplayUploadResult> {
  const operation = beginReplayUploadOperation(intent?.privacyGeneration)
  const contentType = blob.type || 'video/webm'
  try {
    // Screen recordings are mandatory Hire evidence. Even a short/partial
    // recording must enter the durable IndexedDB-backed multipart queue so a
    // transient presign, upload, or finalize failure cannot silently drop it.
    // Camera keeps its established direct-upload fast path.
    if (
      options.requiredDelivery !== true &&
      kind !== 'screen' &&
      blob.size <= DIRECT_UPLOAD_LIMIT_BYTES
    ) {
      try {
        const uploaded = await uploadDirect(
          sessionId,
          kind,
          blob,
          contentType,
          operation,
          durationSeconds,
          intent?.originUserId,
        )
        return { status: uploaded ? 'uploaded' : 'dropped' }
      } catch (err) {
        if (!isReplayUploadPrivacyCancellation(err, operation)) {
          console.warn('Replay direct upload dropped', err)
        }
        return { status: 'dropped' }
      }
    }

    const record: QueuedReplayUpload = {
      id: `${sessionId}:${kind}:${Date.now()}:${blob.size}`,
      sessionId,
      kind,
      blob,
      sizeBytes: blob.size,
      contentType,
      ...(intent?.originUserId ? { originUserId: intent.originUserId } : {}),
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      createdAt: Date.now(),
      parts: [],
      attempts: 0,
      deliveryState: 'pending',
      ...(options.requiredDelivery ? { requiredDelivery: true } : {}),
      // Layer 2 — stamp our lease BEFORE putUpload so any drainQueuedReplayUploads
      // running concurrently in this same tab sees an active lease on the very
      // first read. Combined with the inFlightRecordIds Set acquired below, this
      // closes the bug where a /feedback page-mount drain raced this in-flight
      // upload and produced duplicate sign-part rounds → 500/404 cascade.
      leaseHolder: PROCESS_ID,
      leaseExpiresAt: Date.now() + LEASE_TTL_MS,
    }

    inFlightRecordIds.add(record.id)
    let wasQueued = false
    try {
      wasQueued = await putUpload(record, operation)
      await uploadMultipartRecord(record, operation)
      return { status: 'uploaded' }
    } catch (err) {
      if (isReplayUploadPrivacyCancellation(err, operation)) {
        return { status: 'dropped' }
      }
      if (isMultipartUploadGoneError(err)) {
        const latest = (await getAllUploads(operation)).find(
          (candidate) => candidate.id === record.id,
        ) ?? record
        const reset = resetGoneMultipart(latest, err)
        if (isExhaustedRetries(reset)) {
          if (options.requiredDelivery) {
            await putUpload(unavailableRecord(reset, 'upload_expired'), operation)
          } else {
            await deleteUpload(record.id, operation)
          }
          return { status: 'dropped' }
        }
        await putUpload(reset, operation)
        console.warn(
          'Replay multipart upload expired; queued with a fresh upload identity',
          err,
        )
        return { status: 'queued' }
      }
      if (isPermanentMultipartUploadError(err)) {
        if (options.requiredDelivery) {
          const latest = (await getAllUploads(operation)).find(
            (candidate) => candidate.id === record.id,
          )
          await putUpload(
            unavailableRecord(latest ?? record, 'upload_rejected'),
            operation,
          )
        } else {
          await deleteUpload(record.id, operation)
        }
        console.warn('Replay multipart upload permanently dropped', err)
        return { status: 'dropped' }
      }
      // Transient failure path: clear the lease so a future drainer can pick
      // this record up immediately rather than waiting for natural TTL expiry.
      // Read latest IDB state first so worker progress (parts uploaded so far)
      // is preserved across the retry — same invariant Codex P1 #339 enforced.
      const latest = (await getAllUploads(operation)).find((r) => r.id === record.id)
      if (latest) {
        await putUpload({
          ...latest,
          attempts: latest.attempts + 1,
          lastError: err instanceof Error ? err.message : String(err),
          leaseHolder: undefined,
          leaseExpiresAt: undefined,
        }, operation)
      } else if (options.requiredDelivery) {
        await putUpload(
          unavailableRecord(record, 'durable_queue_failed'),
          operation,
        )
      }
      if (wasQueued) {
        console.warn('Replay multipart upload queued for retry', err)
        return { status: 'queued' }
      }
      console.warn('Replay multipart upload failed before it could be queued', err)
      return { status: 'dropped' }
    } finally {
      releaseLease(record.id)
    }
  } finally {
    finishReplayUploadOperation(operation)
  }
}

/**
 * Does an un-dead queued upload exist for this session+kind? Used by the
 * feedback page to distinguish "upload plausibly in flight" (show an honest
 * "still uploading" state, keep watching) from "never coming" (show the
 * definitive no-video message immediately). Zombie records — past the R2
 * multipart TTL or out of retry budget — are excluded: they can never
 * complete, and counting them would keep the optimistic message lying for up
 * to 7 days of revisits.
 */
export async function hasQueuedReplayUpload(
  sessionId: string,
  kind: ReplayUploadKind = 'camera'
): Promise<boolean> {
  const operation = beginReplayUploadOperation()
  try {
    const records = await getAllUploads(operation)
    return records.some(
      (record) =>
        record.sessionId === sessionId &&
        record.kind === kind &&
        !isUnavailableRecord(record) &&
        !isExpiredRecord(record) &&
        !isExhaustedRetries(record)
    )
  } catch (error) {
    if (isReplayUploadPrivacyCancellation(error, operation)) return false
    throw error
  } finally {
    finishReplayUploadOperation(operation)
  }
}

export async function drainQueuedReplayUploads(): Promise<DrainReplayUploadsResult> {
  const operation = beginReplayUploadOperation()
  let records: QueuedReplayUpload[] = []
  let uploaded = 0
  let queued = 0
  let dropped = 0
  let skipped = 0

  try {
    records = await getAllUploads(operation)
    for (const record of records) {
      // Required Hire terminal markers are retained until the authenticated
      // completion contract records them server-side. Ordinary feedback-page
      // drains must never upload or discard these zero-byte markers.
      if (isUnavailableRecord(record)) {
        skipped++
        continue
      }
      // Layer 3 — backstop caps. A record that is older than the R2 multipart
      // TTL or that has burned through its retry budget cannot be recovered;
      // retain required Hire evidence as a terminal marker after best-effort
      // multipart cleanup. Non-required/legacy rows keep their historical
      // zombie cleanup behaviour.
      if (isExpiredRecord(record) || isExhaustedRetries(record)) {
        await serverAbort(record, operation)
        if (record.requiredDelivery) {
          await putUpload(
            unavailableRecord(
              record,
              isExpiredRecord(record) ? 'upload_expired' : 'retry_exhausted',
            ),
            operation,
          )
        } else {
          await deleteUpload(record.id, operation)
        }
        dropped++
        console.info('Replay upload dropped (zombie cleanup)', {
          id: record.id,
          attempts: record.attempts,
          ageMs: Date.now() - record.createdAt,
          reason: isExpiredRecord(record) ? 'age' : 'retries',
        })
        continue
      }

      // Layers 1 + 2 — lease check. Same-tab races resolve via the in-memory
      // Set inside tryAcquireLease; cross-tab races resolve via the IDB
      // leaseHolder/leaseExpiresAt fields. Both checks happen atomically with
      // respect to a single drain iteration.
      const leased = await tryAcquireLease(record, operation)
      if (!leased) {
        skipped++
        continue
      }

      try {
        await uploadMultipartRecord(leased, operation)
        uploaded++
      } catch (err) {
        if (isReplayUploadPrivacyCancellation(err, operation)) throw err
        if (isMultipartUploadGoneError(err)) {
          const latest = (await getAllUploads(operation)).find(
            (candidate) => candidate.id === leased.id,
          ) ?? leased
          const reset = resetGoneMultipart(latest, err)
          if (isExhaustedRetries(reset)) {
            if (leased.requiredDelivery) {
              await putUpload(unavailableRecord(reset, 'upload_expired'), operation)
            } else {
              await deleteUpload(leased.id, operation)
            }
            dropped++
          } else {
            await putUpload(reset, operation)
            queued++
          }
          console.warn('Queued replay multipart expired; reset for retry', err)
        } else if (isPermanentMultipartUploadError(err)) {
          if (leased.requiredDelivery) {
            await putUpload(
              unavailableRecord(leased, 'upload_rejected'),
              operation,
            )
          } else {
            await deleteUpload(leased.id, operation)
          }
          dropped++
          console.warn('Queued replay upload permanently dropped', err)
        } else {
          queued++
        // Codex P1 on PR #339: do NOT spread `...record` here — `record` is
        // the pre-attempt snapshot, but uploadMultipartRecord persists newer
        // state (parts, key, uploadId) to IndexedDB during the attempt via
        // its inner putUpload(current) calls. Spreading the stale snapshot
        // would clobber that progress, forcing every retry to re-upload
        // already-completed parts and orphan multipart sessions on R2.
        //
        // Read the latest persisted state. If the row is gone, another
        // process (the original uploadReplayRecording invocation) has
        // already completed the upload and called deleteUpload. Do NOT
        // resurrect it: that produced the zombie-record retry storm
        // observed in production. Just exit the catch without writing.
          const latestAll = await getAllUploads(operation)
          const latest = latestAll.find((r) => r.id === leased.id)
          if (latest) {
            await putUpload({
              ...latest,
              attempts: latest.attempts + 1,
              lastError: err instanceof Error ? err.message : String(err),
              leaseHolder: undefined,
              leaseExpiresAt: undefined,
            }, operation)
          }
          console.warn('Queued replay upload retry failed', err)
        }
      } finally {
        releaseLease(leased.id)
      }
    }
  } catch (error) {
    if (!isReplayUploadPrivacyCancellation(error, operation)) throw error
  } finally {
    finishReplayUploadOperation(operation)
  }
  return { attempted: records.length, uploaded, queued, dropped, skipped }
}

async function acknowledgeUnavailableRecord(
  record: QueuedReplayUpload & {
    deliveryState: 'unavailable'
    unavailableReason: RequiredReplayUnavailableReason
  },
  operation: ReplayUploadOperation,
): Promise<boolean> {
  assertReplayUploadOperationActive(operation)
  const response = await fetch('/api/hire-engine/completion-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
    body: JSON.stringify({
      action: 'mark-unavailable',
      sessionId: record.sessionId,
      kind: record.kind,
      reason: record.unavailableReason,
    }),
    signal: operation.signal,
  })
  assertReplayUploadOperationActive(operation)
  if (await isTerminalAccountBoundary(response)) {
    await establishAccountUnavailableBoundary()
    assertReplayUploadOperationActive(operation)
  }
  if (response.ok) return true
  if (response.status !== 409) return false
  const payload = await response.json().catch(() => null) as {
    code?: unknown
  } | null
  // A concurrent publisher won with stronger evidence. The local terminal
  // marker is obsolete and may be discarded without weakening truthfulness.
  return payload?.code === 'MEDIA_ALREADY_PUBLISHED'
}

/**
 * Perform one bounded, session-scoped settlement pass for required Hire
 * camera/display evidence. This is deliberately not a poller: callers show a
 * manual retry state when work is still in flight or the deadline expires.
 */
export async function settleRequiredHireReplayUploads(input: {
  sessionId: string
  kinds: ReplayUploadKind[]
  timeoutMs?: number
}): Promise<RequiredHireReplaySettlement> {
  const kinds = Array.from(new Set(input.kinds))
  const operation = beginReplayUploadOperation()
  const uploadedKinds = new Set<ReplayUploadKind>()
  const pendingKinds = new Set<ReplayUploadKind>()
  const acknowledgedUnavailableKinds = new Set<ReplayUploadKind>()
  const timeout = window.setTimeout(
    () => operation.controller.abort(),
    Math.max(1, input.timeoutMs ?? 8_000),
  )

  const settleUnavailable = async (record: QueuedReplayUpload) => {
    if (!isUnavailableRecord(record)) return false
    if (await acknowledgeUnavailableRecord(record, operation)) {
      await deleteUpload(record.id, operation)
      acknowledgedUnavailableKinds.add(record.kind)
      return true
    }
    pendingKinds.add(record.kind)
    return false
  }

  try {
    const storedRecords = await withStore(
      'readonly',
      (store) => store.getAll(),
      operation,
    )
    if (storedRecords === null) {
      if (!isBrowserStorageAvailable()) {
        // Some embedded/private browser contexts expose no IndexedDB at all.
        // There cannot be a recoverable durable row in that environment, so
        // ask the authenticated server to terminalize each required kind now.
        // Its capability/reservation/artifact CAS remains authoritative if an
        // in-memory upload is concurrently crossing the write fence.
        for (const kind of kinds) {
          const terminal = unavailableRecord(
            {
              id: `${input.sessionId}:${kind}:no-durable-store`,
              sessionId: input.sessionId,
              kind,
              blob: new Blob([], { type: 'video/webm' }),
              sizeBytes: 0,
              contentType: 'video/webm',
              createdAt: Date.now(),
              parts: [],
              attempts: 0,
              requiredDelivery: true,
            },
            'durable_queue_failed',
          )
          if (await acknowledgeUnavailableRecord(
            terminal as QueuedReplayUpload & {
              deliveryState: 'unavailable'
              unavailableReason: RequiredReplayUnavailableReason
            },
            operation,
          )) {
            acknowledgedUnavailableKinds.add(kind)
          } else {
            pendingKinds.add(kind)
          }
        }
        return {
          uploadedKinds: [],
          pendingKinds: Array.from(pendingKinds),
          acknowledgedUnavailableKinds: Array.from(
            acknowledgedUnavailableKinds,
          ),
        }
      }
      // A blocked/open/transaction timeout is not evidence that the Blob is
      // absent. Preserve the server's pending state and let an explicit retry
      // reopen the queue instead of fabricating terminal unavailability.
      kinds.forEach((kind) => pendingKinds.add(kind))
      return {
        uploadedKinds: [],
        pendingKinds: Array.from(pendingKinds),
        acknowledgedUnavailableKinds: [],
      }
    }
    const records = storedRecords.filter(
      (record) =>
        record.sessionId === input.sessionId && kinds.includes(record.kind),
    )
    const representedKinds = new Set(records.map((record) => record.kind))
    for (const kind of kinds) {
      if (representedKinds.has(kind)) continue
      // There is no recoverable browser payload for a server-required kind.
      // Persist a zero-byte retry marker where possible, then let the server
      // make the authoritative decision: it rejects this transition if an
      // object, multipart capability, or finalized artifact is still live.
      const terminal: QueuedReplayUpload = {
        id: `${input.sessionId}:${kind}:terminal-unavailable`,
        sessionId: input.sessionId,
        kind,
        blob: new Blob([], { type: 'video/webm' }),
        sizeBytes: 0,
        contentType: 'video/webm',
        createdAt: Date.now(),
        parts: [],
        attempts: 0,
        deliveryState: 'unavailable',
        requiredDelivery: true,
        unavailableReason: 'durable_queue_failed',
      }
      await putUpload(terminal, operation)
      await settleUnavailable(terminal)
    }
    for (const original of records) {
      if (isUnavailableRecord(original)) {
        await settleUnavailable(original)
        continue
      }

      if (isExpiredRecord(original) || isExhaustedRetries(original)) {
        await serverAbort(original, operation)
        const terminal = unavailableRecord(
          original,
          isExpiredRecord(original) ? 'upload_expired' : 'retry_exhausted',
        )
        await putUpload(terminal, operation)
        await settleUnavailable(terminal)
        continue
      }

      const leased = await tryAcquireLease(original, operation)
      if (!leased) {
        pendingKinds.add(original.kind)
        continue
      }
      try {
        await uploadMultipartRecord(leased, operation)
        uploadedKinds.add(leased.kind)
      } catch (error) {
        if (isReplayUploadPrivacyCancellation(error, operation)) throw error
        if (isMultipartUploadGoneError(error)) {
          const latest = (await getAllUploads(operation)).find(
            (record) => record.id === leased.id,
          ) ?? leased
          const reset = resetGoneMultipart(latest, error)
          if (isExhaustedRetries(reset)) {
            const terminal = unavailableRecord(reset, 'upload_expired')
            await putUpload(terminal, operation)
            await settleUnavailable(terminal)
          } else {
            await putUpload(reset, operation)
            pendingKinds.add(leased.kind)
          }
          continue
        }
        if (isPermanentMultipartUploadError(error)) {
          const terminal = unavailableRecord(leased, 'upload_rejected')
          await putUpload(terminal, operation)
          await settleUnavailable(terminal)
          continue
        }

        const latest = (await getAllUploads(operation)).find(
          (record) => record.id === leased.id,
        )
        if (!latest) {
          pendingKinds.add(leased.kind)
          continue
        }
        const attempts = latest.attempts + 1
        if (attempts >= MAX_DRAIN_ATTEMPTS) {
          await serverAbort(latest, operation)
          const terminal = unavailableRecord(latest, 'retry_exhausted')
          await putUpload(terminal, operation)
          await settleUnavailable(terminal)
        } else {
          await putUpload(
            {
              ...latest,
              attempts,
              lastError: error instanceof Error ? error.message : String(error),
              leaseHolder: undefined,
              leaseExpiresAt: undefined,
            },
            operation,
          )
          pendingKinds.add(leased.kind)
        }
      } finally {
        releaseLease(leased.id)
      }
    }
  } catch (error) {
    if (!isReplayUploadPrivacyCancellation(error, operation)) throw error
    kinds.forEach((kind) => pendingKinds.add(kind))
  } finally {
    window.clearTimeout(timeout)
    finishReplayUploadOperation(operation)
  }

  return {
    uploadedKinds: Array.from(uploadedKinds),
    pendingKinds: Array.from(pendingKinds),
    acknowledgedUnavailableKinds: Array.from(acknowledgedUnavailableKinds),
  }
}
