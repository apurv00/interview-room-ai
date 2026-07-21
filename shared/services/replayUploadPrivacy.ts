'use client'

export const REPLAY_UPLOAD_DB_NAME = 'interview-replay-uploads'
export const REPLAY_UPLOAD_STORE_NAME = 'uploads'
export const REPLAY_UPLOAD_DB_VERSION = 1

const CANCELLATION_CHANNEL_NAME = 'interview-replay-upload-privacy-v1'
const CANCELLATION_MESSAGE = 'cancel-and-purge'
const PURGE_TIMEOUT_MS = 2_000

export interface ReplayUploadOperation {
  readonly generation: number
  readonly signal: AbortSignal
  readonly controller: AbortController
}

export class ReplayUploadPrivacyBoundaryError extends Error {
  constructor() {
    super('Replay upload cancelled by an account privacy boundary')
    this.name = 'ReplayUploadPrivacyBoundaryError'
  }
}

let privacyGeneration = 0
const activeControllers = new Set<AbortController>()
const activeDatabases = new Set<IDBDatabase>()
let cancellationChannel: BroadcastChannel | null | undefined

function isBrowserIndexedDbAvailable(): boolean {
  return typeof window !== 'undefined' && typeof indexedDB !== 'undefined'
}

function applyCancellationBoundary(): void {
  privacyGeneration += 1
  activeControllers.forEach((controller) => controller.abort())
  activeControllers.clear()

  // close() prevents a new transaction from being created on these handles.
  // An active transaction is separately aborted by its operation signal.
  activeDatabases.forEach((db) => db.close())
  activeDatabases.clear()
}

function getCancellationChannel(): BroadcastChannel | null {
  if (cancellationChannel !== undefined) return cancellationChannel
  if (typeof BroadcastChannel === 'undefined') {
    cancellationChannel = null
    return null
  }

  try {
    const channel = new BroadcastChannel(CANCELLATION_CHANNEL_NAME)
    channel.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (event.data !== CANCELLATION_MESSAGE) return
      applyCancellationBoundary()
      void purgeReplayUploadDatabase()
    })
    cancellationChannel = channel
  } catch {
    cancellationChannel = null
  }
  return cancellationChannel
}

/**
 * Capture the current privacy generation for one upload/drain invocation.
 * A later account cleanup aborts the controller and invalidates this snapshot;
 * a genuinely new interview invocation captures the new generation and is
 * allowed to upload normally.
 */
export function currentReplayUploadPrivacyGeneration(): number {
  getCancellationChannel()
  return privacyGeneration
}

export function beginReplayUploadOperation(
  expectedGeneration = privacyGeneration,
): ReplayUploadOperation {
  getCancellationChannel()
  const controller = new AbortController()
  activeControllers.add(controller)
  return { generation: expectedGeneration, signal: controller.signal, controller }
}

export function finishReplayUploadOperation(operation: ReplayUploadOperation): void {
  activeControllers.delete(operation.controller)
}

export function assertReplayUploadOperationActive(operation: ReplayUploadOperation): void {
  if (operation.signal.aborted || operation.generation !== privacyGeneration) {
    throw new ReplayUploadPrivacyBoundaryError()
  }
}

export function isReplayUploadPrivacyCancellation(
  error: unknown,
  operation: ReplayUploadOperation,
): boolean {
  return (
    error instanceof ReplayUploadPrivacyBoundaryError ||
    operation.signal.aborted ||
    operation.generation !== privacyGeneration
  )
}

/** Track handles so a same-tab privacy boundary closes them synchronously. */
export function trackReplayUploadDatabase(db: IDBDatabase): () => void {
  activeDatabases.add(db)
  const closeForVersionChange = () => {
    activeDatabases.delete(db)
    db.close()
  }
  db.addEventListener?.('versionchange', closeForVersionChange)

  return () => {
    activeDatabases.delete(db)
    db.removeEventListener?.('versionchange', closeForVersionChange)
  }
}

/**
 * Abort an IndexedDB transaction when the owning network operation crosses a
 * privacy boundary. This closes the window where a request that was already
 * queued could commit a Blob after account cleanup began.
 */
export function bindReplayUploadTransaction(
  operation: ReplayUploadOperation,
  transaction: IDBTransaction,
): () => void {
  const abort = () => {
    try {
      transaction.abort()
    } catch {
      // The transaction may already be complete/aborted.
    }
  }
  operation.signal.addEventListener('abort', abort, { once: true })
  return () => operation.signal.removeEventListener('abort', abort)
}

function purgeReplayUploadDatabase(): Promise<void> {
  if (!isBrowserIndexedDbAvailable()) return Promise.resolve()

  return new Promise((resolve) => {
    let settled = false
    let database: IDBDatabase | undefined
    let transaction: IDBTransaction | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (settled) return
      settled = true
      if (timeout !== undefined) clearTimeout(timeout)
      resolve()
    }

    const retireTimedOutHandles = () => {
      if (settled) return
      try {
        transaction?.abort()
      } catch {
        // It may have completed between the deadline and abort attempt.
      }
      database?.close()
      finish()
    }

    // Cancellation is synchronous. The physical IndexedDB purge is
    // best-effort and must not keep sign-out/account deletion waiting forever
    // if a browser leaves an open request blocked indefinitely.
    timeout = setTimeout(retireTimedOutHandles, PURGE_TIMEOUT_MS)

    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(REPLAY_UPLOAD_DB_NAME, REPLAY_UPLOAD_DB_VERSION)
    } catch {
      finish()
      return
    }

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(REPLAY_UPLOAD_STORE_NAME)) {
        db.createObjectStore(REPLAY_UPLOAD_STORE_NAME, { keyPath: 'id' })
      }
    }
    request.onerror = finish
    request.onsuccess = () => {
      const db = request.result
      if (settled) {
        // The deadline may have released sign-out while open() was blocked.
        // Never let that late handle clear a subsequently signed-in account's
        // replay queue.
        db.close()
        return
      }
      database = db
      try {
        const clearTransaction = db.transaction(REPLAY_UPLOAD_STORE_NAME, 'readwrite')
        transaction = clearTransaction
        clearTransaction.objectStore(REPLAY_UPLOAD_STORE_NAME).clear()
        clearTransaction.oncomplete = () => {
          db.close()
          finish()
        }
        clearTransaction.onerror = () => {
          db.close()
          finish()
        }
        clearTransaction.onabort = () => {
          db.close()
          finish()
        }
      } catch {
        db.close()
        finish()
      }
    }
  })
}

/**
 * Establish the cancellation boundary synchronously, then remove every queued
 * replay record and its Blob from IndexedDB. BroadcastChannel extends the
 * abort signal to active uploads in other same-origin tabs where supported.
 */
export function cancelAndPurgeReplayUploads(): Promise<void> {
  applyCancellationBoundary()
  try {
    getCancellationChannel()?.postMessage(CANCELLATION_MESSAGE)
  } catch {
    // Same-tab cancellation and purge still apply.
  }
  return purgeReplayUploadDatabase()
}

/** @internal Test-only reset for module-scoped cancellation state. */
export function __resetReplayUploadPrivacyForTests(): void {
  activeControllers.forEach((controller) => controller.abort())
  activeControllers.clear()
  activeDatabases.forEach((db) => db.close())
  activeDatabases.clear()
  privacyGeneration = 0
  cancellationChannel?.close()
  cancellationChannel = undefined
}
