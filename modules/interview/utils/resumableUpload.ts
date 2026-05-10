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
    if (res.status === 410) {
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
      current = {
        ...current,
        parts: Array.from(uploaded.entries()).map(([n, tag]) => ({ partNumber: n, etag: tag })),
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
  }

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
    if (queued) {
      console.warn('Replay multipart upload queued for retry', err)
      return { status: 'queued' }
    }
    console.warn('Replay multipart upload failed before it could be queued', err)
    return { status: 'dropped' }
  }
}

export async function drainQueuedReplayUploads(): Promise<DrainReplayUploadsResult> {
  const records = await getAllUploads()
  let uploaded = 0
  let queued = 0
  let dropped = 0
  for (const record of records) {
    try {
      await uploadMultipartRecord(record)
      uploaded++
    } catch (err) {
      if (isPermanentMultipartUploadError(err)) {
        await deleteUpload(record.id)
        dropped++
        console.warn('Queued replay upload permanently dropped', err)
      } else {
        queued++
        await putUpload({
          ...record,
          attempts: record.attempts + 1,
          lastError: err instanceof Error ? err.message : String(err),
        })
        console.warn('Queued replay upload retry failed', err)
      }
    }
  }
  return { attempted: records.length, uploaded, queued, dropped }
}
