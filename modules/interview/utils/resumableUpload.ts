'use client'

export type ReplayUploadKind = 'camera' | 'screen'
export type ReplayUploadStatus = 'uploaded' | 'queued' | 'dropped'

export interface ReplayUploadResult {
  status: ReplayUploadStatus
}

export interface DrainReplayUploadsResult {
  attempted: number
  uploaded: number
  queued: number
  dropped: number
  /** Records skipped because another tab/invocation holds an active lease. */
  skipped: number
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

function isPermanentMultipartUploadError(err: unknown): err is PermanentMultipartUploadError {
  return err instanceof PermanentMultipartUploadError
}

const DB_NAME = 'interview-replay-uploads'
const STORE_NAME = 'uploads'
const DB_VERSION = 1
const DEFAULT_PART_SIZE_BYTES = 8 * 1024 * 1024
const DIRECT_UPLOAD_LIMIT_BYTES = 20 * 1024 * 1024
const MAX_PART_RETRIES = 3
const MAX_CONCURRENT_PARTS = 3

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
}

function uploadTypeFor(kind: ReplayUploadKind): 'recording' | 'screen-recording' {
  return kind === 'screen' ? 'screen-recording' : 'recording'
}

function isBrowserStorageAvailable(): boolean {
  return typeof window !== 'undefined' && typeof indexedDB !== 'undefined'
}

function openDb(): Promise<IDBDatabase | null> {
  if (!isBrowserStorageAvailable()) return Promise.resolve(null)
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
  })
}

async function withStore<T>(
  mode: IDBTransactionMode,
  callback: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, mode)
    const request = callback(tx.objectStore(STORE_NAME))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    tx.oncomplete = () => db.close()
    tx.onerror = () => db.close()
    tx.onabort = () => db.close()
  })
}

async function putUpload(record: QueuedReplayUpload): Promise<boolean> {
  const result = await withStore('readwrite', (store) => store.put(record))
  return result !== null
}

async function deleteUpload(id: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(id))
}

async function getAllUploads(): Promise<QueuedReplayUpload[]> {
  return (await withStore('readonly', (store) => store.getAll())) ?? []
}

async function postMultipart<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch('/api/storage/multipart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const responseText = await res.text().catch(() => '')
    const message = `Multipart API failed: ${res.status}${responseText ? ` ${responseText.slice(0, 300)}` : ''}`
    // 410 Gone (R2 multipart aborted/expired — handled by server route).
    // 401/403 mean the user is signed out: retrying with the same cookie will
    // never succeed; the record is unrecoverable from this client. Marking
    // them permanent prevents an infinite retry loop that would otherwise
    // pile up zombie records on every page mount.
    if (res.status === 410 || res.status === 401 || res.status === 403) {
      throw new PermanentMultipartUploadError(message)
    }
    throw new Error(message)
  }
  return res.json() as Promise<T>
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
  contentType: string
): Promise<string> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_PART_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: chunk,
      })
      if (!res.ok) throw new Error(`Part upload failed: ${res.status}`)
      return normaliseEtag(res.headers.get('ETag'))
    } catch (err) {
      lastError = err
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt))
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Part upload failed')
}

async function ensureMultipart(record: QueuedReplayUpload): Promise<QueuedReplayUpload> {
  if (record.key && record.uploadId && record.partSizeBytes) return record

  const created = await postMultipart<MultipartCreateResponse>({
    action: 'create',
    type: uploadTypeFor(record.kind),
    sessionId: record.sessionId,
  })

  const next = {
    ...record,
    key: created.key,
    uploadId: created.uploadId,
    contentType: created.contentType,
    partSizeBytes: created.partSizeBytes,
  }
  await putUpload(next)
  return next
}

async function completeMultipart(record: QueuedReplayUpload): Promise<string> {
  const result = await postMultipart<{ key: string }>({
    action: 'complete',
    type: uploadTypeFor(record.kind),
    sessionId: record.sessionId,
    key: record.key,
    uploadId: record.uploadId,
    parts: record.parts,
    sizeBytes: record.sizeBytes,
  })
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
 * The IDB write + re-read pattern is a poor-man's CAS — IndexedDB has no
 * native compare-and-swap. Two tabs that race exactly here could both think
 * they have the lease, but the in-memory Set in Layer 1 prevents this within
 * a single tab. Cross-tab races fall back to the server's idempotent complete
 * path ([app/api/storage/multipart/route.ts:230-249]) which absorbs the
 * second `complete` call without corruption.
 */
async function tryAcquireLease(
  record: QueuedReplayUpload
): Promise<QueuedReplayUpload | null> {
  if (inFlightRecordIds.has(record.id)) return null
  if (isLeaseHeldByOther(record)) return null

  const leased: QueuedReplayUpload = {
    ...record,
    leaseHolder: PROCESS_ID,
    leaseExpiresAt: Date.now() + LEASE_TTL_MS,
  }
  const written = await putUpload(leased)
  if (!written) return null

  // Re-read to confirm our lease landed (a concurrent writer in another tab
  // would have stomped it). If the row is gone, another process completed
  // the upload and deleted it — back off.
  const verified = (await getAllUploads()).find((r) => r.id === record.id)
  if (!verified || verified.leaseHolder !== PROCESS_ID) return null

  inFlightRecordIds.add(record.id)
  return verified
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
async function serverAbort(record: QueuedReplayUpload): Promise<void> {
  if (!record.key || !record.uploadId) return
  try {
    await postMultipart<{ ok: boolean }>({
      action: 'abort',
      key: record.key,
      uploadId: record.uploadId,
    })
  } catch (err) {
    console.warn('Replay multipart abort failed (non-fatal)', err)
  }
}

async function uploadMultipartRecord(record: QueuedReplayUpload): Promise<string> {
  let current = await ensureMultipart(record)
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
        key: current.key,
        uploadId: current.uploadId,
        partNumber,
      })
      const etag = await uploadPartWithRetry(
        url,
        current.blob.slice(start, end, current.contentType),
        current.contentType
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
      await putUpload(current)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_PARTS, partCount) }, () => worker())
  )
  current.parts = Array.from(uploaded.entries())
    .map(([partNumber, etag]) => ({ partNumber, etag }))
    .sort((a, b) => a.partNumber - b.partNumber)
  const key = await completeMultipart(current)
  await deleteUpload(current.id)
  return key
}

async function uploadDirect(
  sessionId: string,
  kind: ReplayUploadKind,
  blob: Blob,
  contentType: string
): Promise<boolean> {
  const res = await fetch('/api/storage/presign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'upload',
      type: uploadTypeFor(kind),
      sessionId,
    }),
  })
  if (!res.ok) return false

  const { url, key, contentType: presignedContentType } = await res.json()
  const uploadRes = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': presignedContentType || contentType },
    body: blob,
  })
  if (!uploadRes.ok) return false

  const patchBody = kind === 'screen'
    ? { screenRecordingR2Key: key, screenRecordingSizeBytes: blob.size }
    : { recordingR2Key: key, recordingSizeBytes: blob.size }
  const patchRes = await fetch(`/api/interviews/${sessionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patchBody),
  })
  return patchRes.ok
}

export async function uploadReplayRecording(
  sessionId: string,
  kind: ReplayUploadKind,
  blob: Blob
): Promise<ReplayUploadResult> {
  const contentType = blob.type || 'video/webm'
  if (blob.size <= DIRECT_UPLOAD_LIMIT_BYTES) {
    try {
      const uploaded = await uploadDirect(sessionId, kind, blob, contentType)
      return { status: uploaded ? 'uploaded' : 'dropped' }
    } catch (err) {
      console.warn('Replay direct upload dropped', err)
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
    createdAt: Date.now(),
    parts: [],
    attempts: 0,
    // Layer 2 — stamp our lease BEFORE putUpload so any drainQueuedReplayUploads
    // running concurrently in this same tab sees an active lease on the very
    // first read. Combined with the inFlightRecordIds Set acquired below, this
    // closes the bug where a /feedback page-mount drain raced this in-flight
    // upload and produced duplicate sign-part rounds → 500/404 cascade.
    leaseHolder: PROCESS_ID,
    leaseExpiresAt: Date.now() + LEASE_TTL_MS,
  }

  inFlightRecordIds.add(record.id)
  const queued = await putUpload(record)
  try {
    await uploadMultipartRecord(record)
    return { status: 'uploaded' }
  } catch (err) {
    if (isPermanentMultipartUploadError(err)) {
      await deleteUpload(record.id)
      console.warn('Replay multipart upload permanently dropped', err)
      return { status: 'dropped' }
    }
    // Transient failure path: clear the lease so a future drainer can pick
    // this record up immediately rather than waiting for natural TTL expiry.
    // Read latest IDB state first so worker progress (parts uploaded so far)
    // is preserved across the retry — same invariant Codex P1 #339 enforced.
    const latest = (await getAllUploads()).find((r) => r.id === record.id)
    if (latest) {
      await putUpload({
        ...latest,
        attempts: latest.attempts + 1,
        lastError: err instanceof Error ? err.message : String(err),
        leaseHolder: undefined,
        leaseExpiresAt: undefined,
      })
    }
    if (queued) {
      console.warn('Replay multipart upload queued for retry', err)
      return { status: 'queued' }
    }
    console.warn('Replay multipart upload failed before it could be queued', err)
    return { status: 'dropped' }
  } finally {
    releaseLease(record.id)
  }
}

export async function drainQueuedReplayUploads(): Promise<DrainReplayUploadsResult> {
  const records = await getAllUploads()
  let uploaded = 0
  let queued = 0
  let dropped = 0
  let skipped = 0

  for (const record of records) {
    // Layer 3 — backstop caps. A record that is older than the R2 multipart
    // TTL or that has burned through its retry budget cannot be recovered;
    // drop it (and best-effort tell the server to release R2 parts) instead
    // of looping forever on every page mount.
    if (isExpiredRecord(record) || isExhaustedRetries(record)) {
      await serverAbort(record)
      await deleteUpload(record.id)
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
    const leased = await tryAcquireLease(record)
    if (!leased) {
      skipped++
      continue
    }

    try {
      await uploadMultipartRecord(leased)
      uploaded++
    } catch (err) {
      if (isPermanentMultipartUploadError(err)) {
        await deleteUpload(leased.id)
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
        const latestAll = await getAllUploads()
        const latest = latestAll.find((r) => r.id === leased.id)
        if (latest) {
          await putUpload({
            ...latest,
            attempts: latest.attempts + 1,
            lastError: err instanceof Error ? err.message : String(err),
            leaseHolder: undefined,
            leaseExpiresAt: undefined,
          })
        }
        console.warn('Queued replay upload retry failed', err)
      }
    } finally {
      releaseLease(leased.id)
    }
  }
  return { attempted: records.length, uploaded, queued, dropped, skipped }
}
