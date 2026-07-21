import {
  __resetForTests,
  captureReplayUploadIntent,
  drainQueuedReplayUploads,
  getPartRange,
  uploadReplayRecording,
} from '@interview/utils/resumableUpload'
import { cancelAndPurgeReplayUploads } from '@shared/services/replayUploadPrivacy'

const USER_ID = '507f1f77bcf86cd799439010'
const SESSION_ID = '507f1f77bcf86cd799439011'
const RECORDING_KEY = `recordings/${USER_ID}/${SESSION_ID}-1700000000000.webm`

function installFakeIndexedDb() {
  const stores = new Map<string, Map<string, unknown>>()
  const db = {
    objectStoreNames: {
      contains: (name: string) => stores.has(name),
    },
    createObjectStore: (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map())
    },
    transaction: (name: string) => {
      let aborted = false
      const transaction = {
        objectStore: () => {
          function request<T>(work: () => T): IDBRequest<T> {
            const pending = {} as IDBRequest<T>
            setTimeout(() => {
              if (aborted) return
              Object.defineProperty(pending, 'result', { value: work(), configurable: true })
              pending.onsuccess?.(new Event('success'))
              setTimeout(() => {
                if (!aborted) transaction.oncomplete?.(new Event('complete'))
              }, 0)
            }, 0)
            return pending
          }

          return {
            put: (record: { id: string }) => request(() => {
              stores.get(name)?.set(record.id, record)
              return record.id
            }),
            delete: (id: string) => request(() => {
              stores.get(name)?.delete(id)
              return undefined
            }),
            clear: () => request(() => {
              stores.get(name)?.clear()
              return undefined
            }),
            getAll: () => request(() => Array.from(stores.get(name)?.values() ?? [])),
          }
        },
        abort: () => {
          if (aborted) return
          aborted = true
          setTimeout(() => transaction.onabort?.(new Event('abort')), 0)
        },
        oncomplete: null as ((event: Event) => void) | null,
        onerror: null as ((event: Event) => void) | null,
        onabort: null as ((event: Event) => void) | null,
      }
      return transaction
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    close: vi.fn(),
  }
  const indexedDB = {
    open: () => {
      const request = { result: db } as IDBOpenDBRequest
      setTimeout(() => {
        request.onupgradeneeded?.(new Event('upgradeneeded') as IDBVersionChangeEvent)
        request.onsuccess?.(new Event('success'))
      }, 0)
      return request
    },
  }

  vi.stubGlobal('indexedDB', indexedDB)
  return stores
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function largeReplayBlob(): Blob {
  return new Blob([new Uint8Array(20 * 1024 * 1024 + 1)], { type: 'video/webm' })
}

function installMultipartFetch(completeStatuses: { current: number[] }) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url === '/api/storage/multipart') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string; partNumber?: number }
      if (body.action === 'create') {
        return jsonResponse({
          key: RECORDING_KEY,
          uploadId: 'upload-123',
          contentType: 'video/webm',
          partSizeBytes: 64 * 1024 * 1024,
        })
      }
      if (body.action === 'sign-part') {
        return jsonResponse({ url: `https://r2.example/part-${body.partNumber ?? 1}` })
      }
      if (body.action === 'complete') {
        const status = completeStatuses.current.shift() ?? 200
        if (status === 200) return jsonResponse({ key: RECORDING_KEY })
        return jsonResponse({ error: 'complete failed' }, status)
      }
    }
    if (url.startsWith('https://r2.example/part-')) {
      return new Response('', { status: 200, headers: { ETag: '"etag-1"' } })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
}

describe('resumable replay upload helpers', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    installFakeIndexedDb()
    // The inFlightRecordIds Set is module-scoped and persists across test
    // runs. Without resetting it, a test that leaves an id in the Set would
    // cause subsequent tests' lease acquisitions to fail.
    __resetForTests()
  })

  it('splits multipart upload ranges without exceeding the blob size', () => {
    const partSize = 8 * 1024 * 1024
    const size = partSize * 2 + 123

    expect(getPartRange(1, size, partSize)).toEqual({ start: 0, end: partSize })
    expect(getPartRange(2, size, partSize)).toEqual({ start: partSize, end: partSize * 2 })
    expect(getPartRange(3, size, partSize)).toEqual({ start: partSize * 2, end: size })
  })

  it('cancels a held drain and purges queued replay Blobs without reviving the row', async () => {
    const stores = installFakeIndexedDb()
    await drainQueuedReplayUploads()

    const record = {
      id: 'privacy-boundary:camera:0',
      sessionId: '507f1f77bcf86cd799439011',
      kind: 'camera' as const,
      blob: new Blob([new Uint8Array(8 * 1024 * 1024)], { type: 'video/webm' }),
      sizeBytes: 8 * 1024 * 1024,
      contentType: 'video/webm',
      createdAt: Date.now(),
      parts: [] as Array<{ partNumber: number; etag: string }>,
      attempts: 0,
      key: 'recordings/user/session-camera.webm',
      uploadId: 'upload-privacy-boundary',
      partSizeBytes: 8 * 1024 * 1024,
    }
    stores.get('uploads')!.set(record.id, record)

    let markSignPartStarted: (() => void) | undefined
    const signPartStarted = new Promise<void>((resolve) => { markSignPartStarted = resolve })
    const actions: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url !== '/api/storage/multipart') throw new Error(`Unexpected fetch: ${url}`)
      const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string }
      actions.push(String(body.action))
      if (body.action !== 'sign-part') throw new Error(`Unexpected multipart action: ${body.action}`)
      markSignPartStarted?.()
      await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        }, { once: true })
      })
    }))

    const drain = drainQueuedReplayUploads()
    await signPartStarted

    await cancelAndPurgeReplayUploads()
    await expect(drain).resolves.toEqual({
      attempted: 1,
      uploaded: 0,
      queued: 0,
      dropped: 0,
      skipped: 0,
    })

    expect(stores.get('uploads')).toBeDefined()
    expect(stores.get('uploads')?.size).toBe(0)
    expect(actions).toEqual(['sign-part'])
  })

  it('aborts a held direct replay upload before it can patch the interview', async () => {
    let markPutStarted: (() => void) | undefined
    const putStarted = new Promise<void>((resolve) => { markPutStarted = resolve })
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      urls.push(url)
      if (url === '/api/storage/presign') {
        return jsonResponse({
          url: 'https://r2.example/direct',
          key: 'recordings/user/direct.webm',
          contentType: 'video/webm',
        })
      }
      if (url === 'https://r2.example/direct') {
        markPutStarted?.()
        await new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'))
          }, { once: true })
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }))

    const upload = uploadReplayRecording(
      '507f1f77bcf86cd799439011',
      'camera',
      new Blob(['small replay'], { type: 'video/webm' }),
    )
    await putStarted

    await cancelAndPurgeReplayUploads()
    await expect(upload).resolves.toEqual({ status: 'dropped' })
    expect(urls).toEqual(['/api/storage/presign', 'https://r2.example/direct'])
  })

  it('turns exact account-unavailable at direct presign into a terminal privacy boundary', async () => {
    const intent = captureReplayUploadIntent()
    const fetchMock = vi.fn(async () => jsonResponse({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    }, 401))
    vi.stubGlobal('fetch', fetchMock)

    await expect(uploadReplayRecording(
      '507f1f77bcf86cd799439011',
      'camera',
      new Blob(['small replay'], { type: 'video/webm' }),
      undefined,
      intent,
    )).resolves.toEqual({ status: 'dropped' })

    await expect(uploadReplayRecording(
      '507f1f77bcf86cd799439011',
      'camera',
      new Blob(['must stay cancelled'], { type: 'video/webm' }),
      undefined,
      intent,
    )).resolves.toEqual({ status: 'dropped' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('allows a new replay upload operation after a completed privacy purge', async () => {
    await cancelAndPurgeReplayUploads()
    const calls: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, init })
      if (url === '/api/storage/presign') {
        return jsonResponse({
          url: 'https://r2.example/new-account-direct',
          key: RECORDING_KEY,
          contentType: 'video/webm',
        })
      }
      if (url === 'https://r2.example/new-account-direct') return new Response('', { status: 200 })
      if (url === '/api/recordings/finalize') return jsonResponse({ success: true })
      throw new Error(`Unexpected fetch: ${url}`)
    }))
    const intent = captureReplayUploadIntent(USER_ID)

    await expect(uploadReplayRecording(
      SESSION_ID,
      'camera',
      new Blob(['new account replay'], { type: 'video/webm' }),
      undefined,
      intent,
    )).resolves.toEqual({ status: 'uploaded' })
    expect(calls.map((call) => call.url)).toEqual([
      '/api/storage/presign',
      'https://r2.example/new-account-direct',
      '/api/recordings/finalize',
    ])
    expect(calls[0].init?.headers).toMatchObject({ 'x-origin-user-id': USER_ID })
    expect(calls[2].init?.headers).toMatchObject({ 'x-origin-user-id': USER_ID })
  })

  it('purges queued replay data when direct finalization returns exact session-changed', async () => {
    const stores = installFakeIndexedDb()
    await drainQueuedReplayUploads()
    stores.get('uploads')!.set('stale-account:camera:0', {
      id: 'stale-account:camera:0',
      sessionId: SESSION_ID,
      kind: 'camera',
      blob: new Blob(['queued replay'], { type: 'video/webm' }),
      sizeBytes: 13,
      contentType: 'video/webm',
      createdAt: Date.now(),
      parts: [],
      attempts: 0,
    })

    const intent = captureReplayUploadIntent(USER_ID)
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push(url)
      if (url === '/api/storage/presign') {
        return jsonResponse({
          url: 'https://r2.example/direct',
          key: RECORDING_KEY,
          contentType: 'video/webm',
        })
      }
      if (url === 'https://r2.example/direct') return new Response('', { status: 200 })
      if (url === '/api/recordings/finalize') {
        return jsonResponse({
          error: 'sign-in session changed',
          code: 'SESSION_CHANGED',
        }, 409)
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }))

    await expect(uploadReplayRecording(
      SESSION_ID,
      'camera',
      new Blob(['stale tab'], { type: 'video/webm' }),
      undefined,
      intent,
    )).resolves.toEqual({ status: 'dropped' })
    expect(stores.get('uploads')?.size).toBe(0)

    await expect(uploadReplayRecording(
      SESSION_ID,
      'camera',
      new Blob(['must remain cancelled'], { type: 'video/webm' }),
      undefined,
      intent,
    )).resolves.toEqual({ status: 'dropped' })
    expect(calls).toEqual([
      '/api/storage/presign',
      'https://r2.example/direct',
      '/api/recordings/finalize',
    ])
  })

  it('rejects an upload whose intent predates account cleanup', async () => {
    const intent = captureReplayUploadIntent()
    await cancelAndPurgeReplayUploads()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(uploadReplayRecording(
      '507f1f77bcf86cd799439011',
      'camera',
      new Blob(['materialized after cleanup'], { type: 'video/webm' }),
      undefined,
      intent,
    )).resolves.toEqual({ status: 'dropped' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('bounds a blocked IndexedDB purge so privacy cleanup cannot hang sign-out', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal('indexedDB', {
        open: () => ({} as IDBOpenDBRequest),
      })

      let completed = false
      const purge = cancelAndPurgeReplayUploads().then(() => { completed = true })
      await vi.advanceTimersByTimeAsync(1_999)
      expect(completed).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      await expect(purge).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes a late IndexedDB open without clearing a new account queue', async () => {
    vi.useFakeTimers()
    try {
      const close = vi.fn()
      const transaction = vi.fn()
      const request = {} as IDBOpenDBRequest
      Object.defineProperty(request, 'result', {
        value: { close, transaction },
        configurable: true,
      })
      vi.stubGlobal('indexedDB', { open: () => request })

      const purge = cancelAndPurgeReplayUploads()
      await vi.advanceTimersByTimeAsync(2_000)
      await expect(purge).resolves.toBeUndefined()

      request.onsuccess?.(new Event('success'))
      expect(close).toHaveBeenCalledOnce()
      expect(transaction).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts and closes a stalled IndexedDB clear transaction at the deadline', async () => {
    vi.useFakeTimers()
    try {
      const abort = vi.fn()
      const close = vi.fn()
      const clear = vi.fn()
      const clearTransaction = {
        objectStore: () => ({ clear }),
        abort,
        oncomplete: null,
        onerror: null,
        onabort: null,
      } as unknown as IDBTransaction
      const db = {
        close,
        transaction: vi.fn(() => clearTransaction),
      }
      const request = {} as IDBOpenDBRequest
      Object.defineProperty(request, 'result', { value: db, configurable: true })
      vi.stubGlobal('indexedDB', { open: () => request })

      const purge = cancelAndPurgeReplayUploads()
      request.onsuccess?.(new Event('success'))
      expect(clear).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(2_000)
      await expect(purge).resolves.toBeUndefined()
      expect(abort).toHaveBeenCalledOnce()
      expect(close).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops queued multipart uploads permanently on 410 responses', async () => {
    const completeStatuses = { current: [410] }
    vi.stubGlobal('fetch', installMultipartFetch(completeStatuses))

    const result = await uploadReplayRecording('507f1f77bcf86cd799439011', 'camera', largeReplayBlob())
    const drain = await drainQueuedReplayUploads()

    expect(result).toEqual({ status: 'dropped' })
    expect(drain).toEqual({ attempted: 0, uploaded: 0, queued: 0, dropped: 0, skipped: 0 })
  })

  it('preserves intra-attempt progress when a queued retry fails (Codex P1 #339)', async () => {
    // Pre-seed IDB with a 2-part queued record. During retry, the workers
    // upload both parts (each putUpload-ing the new state into IDB), but
    // `complete` fails with 500. Without the fix, the catch wrote
    // `{...record, attempts: +1}` from the iteration-start closure — clobbering
    // the part progress that the workers had just persisted. With the fix, the
    // catch reads the latest IDB state first and merges only attempts/lastError.
    const stores = installFakeIndexedDb()
    // Trigger one drain to initialize the IDB store (createObjectStore fires
    // during onupgradeneeded on first open). After this, stores.get('uploads')
    // returns a real Map we can pre-seed.
    await drainQueuedReplayUploads()

    const record = {
      id: 'preseeded:camera:0',
      sessionId: '507f1f77bcf86cd799439011',
      kind: 'camera',
      blob: new Blob([new Uint8Array(16 * 1024 * 1024)], { type: 'video/webm' }),
      sizeBytes: 16 * 1024 * 1024,
      contentType: 'video/webm',
      createdAt: Date.now(),
      parts: [] as Array<{ partNumber: number; etag: string }>,
      attempts: 0,
      key: 'recordings/user/session-camera.webm',
      uploadId: 'upload-123',
      partSizeBytes: 8 * 1024 * 1024, // 8MB → 16MB+1 splits into 2 parts
    }
    stores.get('uploads')!.set(record.id, record)

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === '/api/storage/multipart') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string; partNumber?: number }
        if (body.action === 'sign-part') return jsonResponse({ url: `https://r2.example/part-${body.partNumber ?? 1}` })
        if (body.action === 'complete') return jsonResponse({ error: 'complete failed' }, 500)
      }
      if (url.startsWith('https://r2.example/part-')) {
        return new Response('', { status: 200, headers: { ETag: `"etag-${Date.now()}"` } })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }))

    await drainQueuedReplayUploads()

    const after = Array.from(stores.get('uploads')!.values())[0] as { parts: unknown[]; attempts: number }
    // Without the fix: after.parts would be [] (clobbered from closure-captured
    // pre-attempt record). With the fix: both parts uploaded by workers are
    // preserved so the next retry can resume from there.
    expect(after.parts).toHaveLength(2)
    expect(after.attempts).toBe(1)
  })

  it('keeps 500 failures queued and clears the IndexedDB record after retry success', async () => {
    const completeStatuses = { current: [500] }
    vi.stubGlobal('fetch', installMultipartFetch(completeStatuses))

    const result = await uploadReplayRecording('507f1f77bcf86cd799439011', 'camera', largeReplayBlob())
    expect(result).toEqual({ status: 'queued' })

    completeStatuses.current = [200]
    const retry = await drainQueuedReplayUploads()
    expect(retry).toEqual({ attempted: 1, uploaded: 1, queued: 0, dropped: 0, skipped: 0 })

    const empty = await drainQueuedReplayUploads()
    expect(empty).toEqual({ attempted: 0, uploaded: 0, queued: 0, dropped: 0, skipped: 0 })
  })

  // ── Layer 1: same-tab race protection ───────────────────────────────────
  it('blocks concurrent drain from racing an in-flight uploadReplayRecording (Layer 1)', async () => {
    // Reproduces the 2026-05-14 production bug: /interview's
    // uploadReplayRecording starts the multipart upload, user navigates to
    // /feedback, feedback page's drainQueuedReplayUploads fires while the
    // upload is mid-flight. Both would race on the same uploadId, causing
    // duplicate sign-part rounds and 500/404 errors at R2.
    //
    // The in-memory inFlightRecordIds Set should make this impossible: as
    // soon as uploadReplayRecording stamps the record, any same-tab drain
    // sees it as "owned by us" via tryAcquireLease and returns null,
    // counting the record as `skipped` rather than racing it.
    let resolveComplete: ((value: unknown) => void) | null = null
    const completeBarrier = new Promise<unknown>((r) => { resolveComplete = r })

    const completeCalls: number[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === '/api/storage/multipart') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string; partNumber?: number }
        if (body.action === 'create') {
          return jsonResponse({
            key: 'recordings/user/session-camera.webm',
            uploadId: 'upload-race',
            contentType: 'video/webm',
            partSizeBytes: 64 * 1024 * 1024,
          })
        }
        if (body.action === 'sign-part') return jsonResponse({ url: `https://r2.example/part-${body.partNumber ?? 1}` })
        if (body.action === 'complete') {
          completeCalls.push(Date.now())
          await completeBarrier // hold the upload mid-finalize so drain can race
          return jsonResponse({ key: 'recordings/user/session-camera.webm' })
        }
      }
      if (url.startsWith('https://r2.example/part-')) {
        return new Response('', { status: 200, headers: { ETag: '"etag-1"' } })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }))

    // Kick off the upload but DO NOT await — it will park on the complete barrier.
    const uploadPromise = uploadReplayRecording('507f1f77bcf86cd799439011', 'camera', largeReplayBlob())

    // Let the upload progress past putUpload + ensureMultipart + worker parts
    // so it's parked on `complete`. The fake IDB uses setTimeout(0) callbacks
    // so a single microtask flush via setTimeout is enough.
    await new Promise((r) => setTimeout(r, 20))

    const drainResult = await drainQueuedReplayUploads()
    expect(drainResult.skipped).toBe(1)
    expect(drainResult.uploaded).toBe(0)
    expect(drainResult.attempted).toBe(1)

    // Release the upload's complete call.
    resolveComplete!(null)
    await expect(uploadPromise).resolves.toEqual({ status: 'uploaded' })

    // Critical invariant: exactly one complete call total. If Layer 1 had
    // failed to block the drain, this would be 2.
    expect(completeCalls).toHaveLength(1)
  })

  // ── Layer 2: cross-tab lease (active) ───────────────────────────────────
  it('skips records whose lease is held by another process (Layer 2 active)', async () => {
    const stores = installFakeIndexedDb()
    await drainQueuedReplayUploads() // initialise the store

    // Pre-seed a record with an active lease held by a different process.
    const future = Date.now() + 30_000
    const record = {
      id: 'foreign:camera:0',
      sessionId: '507f1f77bcf86cd799439011',
      kind: 'camera',
      blob: new Blob([new Uint8Array(8 * 1024 * 1024)], { type: 'video/webm' }),
      sizeBytes: 8 * 1024 * 1024,
      contentType: 'video/webm',
      createdAt: Date.now(),
      parts: [],
      attempts: 0,
      key: 'recordings/user/session-camera.webm',
      uploadId: 'upload-foreign',
      partSizeBytes: 8 * 1024 * 1024,
      leaseHolder: 'some-other-tab-uuid',
      leaseExpiresAt: future,
    }
    stores.get('uploads')!.set(record.id, record)

    const fetchMock = vi.fn(async () => { throw new Error('drain should not have called fetch') })
    vi.stubGlobal('fetch', fetchMock)

    const result = await drainQueuedReplayUploads()
    expect(result).toEqual({ attempted: 1, uploaded: 0, queued: 0, dropped: 0, skipped: 1 })
    expect(fetchMock).not.toHaveBeenCalled()

    // Record must remain unchanged — we must NOT have overwritten the foreign lease.
    const after = stores.get('uploads')!.get(record.id) as typeof record
    expect(after.leaseHolder).toBe('some-other-tab-uuid')
    expect(after.leaseExpiresAt).toBe(future)
  })

  // ── Layer 2: cross-tab lease (expired) ──────────────────────────────────
  it('reclaims records whose lease has expired (Layer 2 TTL)', async () => {
    const stores = installFakeIndexedDb()
    await drainQueuedReplayUploads()

    // Pre-seed with an expired lease — the original holder must have crashed
    // or been navigated away from. Drain should be able to take it over.
    const record = {
      id: 'expired:camera:0',
      sessionId: '507f1f77bcf86cd799439011',
      kind: 'camera',
      blob: new Blob([new Uint8Array(8 * 1024 * 1024)], { type: 'video/webm' }),
      sizeBytes: 8 * 1024 * 1024,
      contentType: 'video/webm',
      createdAt: Date.now(),
      parts: [{ partNumber: 1, etag: '"e1"' }] as Array<{ partNumber: number; etag: string }>,
      attempts: 0,
      key: 'recordings/user/session-camera.webm',
      uploadId: 'upload-expired',
      partSizeBytes: 8 * 1024 * 1024,
      leaseHolder: 'crashed-tab-uuid',
      leaseExpiresAt: Date.now() - 1, // already expired
    }
    stores.get('uploads')!.set(record.id, record)

    const completeStatuses = { current: [200] }
    vi.stubGlobal('fetch', installMultipartFetch(completeStatuses))

    const result = await drainQueuedReplayUploads()
    expect(result.uploaded).toBe(1)
    expect(result.skipped).toBe(0)
    // Successfully uploaded → record removed.
    expect(stores.get('uploads')!.get(record.id)).toBeUndefined()
  })

  // ── Layer 3: retry cap ──────────────────────────────────────────────────
  it('drops records that exhausted the retry budget (Layer 3 attempts)', async () => {
    const stores = installFakeIndexedDb()
    await drainQueuedReplayUploads()

    const record = {
      id: 'exhausted:camera:0',
      sessionId: '507f1f77bcf86cd799439011',
      kind: 'camera',
      blob: new Blob([new Uint8Array(8 * 1024 * 1024)], { type: 'video/webm' }),
      sizeBytes: 8 * 1024 * 1024,
      contentType: 'video/webm',
      createdAt: Date.now(),
      parts: [] as Array<{ partNumber: number; etag: string }>,
      attempts: 5, // MAX_DRAIN_ATTEMPTS reached
      key: 'recordings/user/session-camera.webm',
      uploadId: 'upload-exhausted',
      partSizeBytes: 8 * 1024 * 1024,
    }
    stores.get('uploads')!.set(record.id, record)

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      // Best-effort serverAbort call is allowed; everything else is a regression.
      if (url === '/api/storage/multipart') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string }
        if (body.action === 'abort') return jsonResponse({ ok: true })
      }
      throw new Error(`Unexpected fetch (zombie cleanup should not upload): ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await drainQueuedReplayUploads()
    expect(result).toEqual({ attempted: 1, uploaded: 0, queued: 0, dropped: 1, skipped: 0 })
    expect(stores.get('uploads')!.get(record.id)).toBeUndefined()
  })

  // ── Layer 3: age cap ────────────────────────────────────────────────────
  it('drops records older than MAX_RECORD_AGE_MS (Layer 3 age)', async () => {
    const stores = installFakeIndexedDb()
    await drainQueuedReplayUploads()

    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000
    const record = {
      id: 'ancient:camera:0',
      sessionId: '507f1f77bcf86cd799439011',
      kind: 'camera',
      blob: new Blob([new Uint8Array(8 * 1024 * 1024)], { type: 'video/webm' }),
      sizeBytes: 8 * 1024 * 1024,
      contentType: 'video/webm',
      createdAt: eightDaysAgo,
      parts: [] as Array<{ partNumber: number; etag: string }>,
      attempts: 1,
      key: 'recordings/user/session-camera.webm',
      uploadId: 'upload-ancient',
      partSizeBytes: 8 * 1024 * 1024,
    }
    stores.get('uploads')!.set(record.id, record)

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === '/api/storage/multipart') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string }
        if (body.action === 'abort') return jsonResponse({ ok: true })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }))

    const result = await drainQueuedReplayUploads()
    expect(result.dropped).toBe(1)
    expect(stores.get('uploads')!.get(record.id)).toBeUndefined()
  })

  // ── Layer 3: don't-resurrect-on-delete-race ─────────────────────────────
  it('does not resurrect a record that another invocation has deleted (Layer 3 anti-zombie)', async () => {
    // Models the exact 2026-05-14 sequence: Round 1 uploadReplayRecording
    // calls deleteUpload after a successful complete. Round 2 drain's
    // worker is still in flight when the deletion happens. Round 2's catch
    // fires when its parts fail with 404 (because the multipart was
    // finalized by Round 1) — the previous code would resurrect the record
    // via `?? record`, creating a zombie that retries forever.
    const stores = installFakeIndexedDb()
    await drainQueuedReplayUploads()

    const record = {
      id: 'will-be-deleted-midflight:camera:0',
      sessionId: '507f1f77bcf86cd799439011',
      kind: 'camera',
      blob: new Blob([new Uint8Array(16 * 1024 * 1024)], { type: 'video/webm' }),
      sizeBytes: 16 * 1024 * 1024,
      contentType: 'video/webm',
      createdAt: Date.now(),
      parts: [] as Array<{ partNumber: number; etag: string }>,
      attempts: 0,
      key: 'recordings/user/session-camera.webm',
      uploadId: 'upload-mid-delete',
      partSizeBytes: 8 * 1024 * 1024, // 2-part record
    }
    stores.get('uploads')!.set(record.id, record)

    let signPartCount = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === '/api/storage/multipart') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string; partNumber?: number }
        if (body.action === 'sign-part') {
          signPartCount++
          // After the first sign-part lands, simulate Round 1 having finished
          // and removed the record from IDB. Round 2's worker will then try
          // to PUT to a finalized multipart and get a 404.
          if (signPartCount === 1) {
            stores.get('uploads')!.delete(record.id)
          }
          return jsonResponse({ url: `https://r2.example/part-${body.partNumber}` })
        }
      }
      if (url.startsWith('https://r2.example/part-')) {
        return new Response('NoSuchUpload', { status: 404 })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }))

    await drainQueuedReplayUploads()

    // The IDB row was deleted mid-flight and the catch path must NOT have
    // recreated it. With the old `?? record` fallback this would be present.
    expect(stores.get('uploads')!.get(record.id)).toBeUndefined()
  })

  // ── Layer 2: lease refresh during long upload ───────────────────────────
  it('refreshes the lease on every part write (Layer 2 refresh)', async () => {
    const stores = installFakeIndexedDb()
    await drainQueuedReplayUploads()

    const record = {
      id: 'lease-refresh:camera:0',
      sessionId: '507f1f77bcf86cd799439011',
      kind: 'camera',
      blob: new Blob([new Uint8Array(16 * 1024 * 1024)], { type: 'video/webm' }),
      sizeBytes: 16 * 1024 * 1024,
      contentType: 'video/webm',
      createdAt: Date.now(),
      parts: [] as Array<{ partNumber: number; etag: string }>,
      attempts: 0,
      key: 'recordings/user/session-camera.webm',
      uploadId: 'upload-refresh',
      partSizeBytes: 8 * 1024 * 1024,
    }
    stores.get('uploads')!.set(record.id, record)

    const leaseSnapshots: number[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === '/api/storage/multipart') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string; partNumber?: number }
        if (body.action === 'sign-part') {
          // Snapshot the lease expiry on every sign-part call. After each
          // part upload, the worker should have refreshed the lease, so the
          // snapshot taken at the next sign-part should be strictly later.
          const inIdb = stores.get('uploads')!.get(record.id) as { leaseExpiresAt?: number } | undefined
          if (inIdb?.leaseExpiresAt) leaseSnapshots.push(inIdb.leaseExpiresAt)
          return jsonResponse({ url: `https://r2.example/part-${body.partNumber}` })
        }
        if (body.action === 'complete') return jsonResponse({ key: record.key })
      }
      if (url.startsWith('https://r2.example/part-')) {
        // Slow each part by a few ms so successive leases get different timestamps.
        await new Promise((r) => setTimeout(r, 5))
        return new Response('', { status: 200, headers: { ETag: '"e"' } })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }))

    await drainQueuedReplayUploads()

    // We expect at least 2 sign-part snapshots; the second's leaseExpiresAt
    // must be >= the first's (refresh did not regress) and there must be at
    // least one refresh (later value strictly greater).
    expect(leaseSnapshots.length).toBeGreaterThanOrEqual(2)
    expect(leaseSnapshots[leaseSnapshots.length - 1]).toBeGreaterThanOrEqual(leaseSnapshots[0])
  })

  // ── Layer 1: drain-vs-drain race (Vercel Agent finding 2026-05-14) ──────
  it('blocks two concurrent drainQueuedReplayUploads from racing the same record (Layer 1 drain-vs-drain)', async () => {
    // Vercel Agent caught this on the first version of the fix: the original
    // tryAcquireLease added to inFlightRecordIds AFTER the IDB write+verify
    // awaits, leaving a window where two concurrent drain calls could both
    // pass the .has() check synchronously, both write their lease (same
    // PROCESS_ID since same tab), both pass the verify, both proceed to
    // uploadMultipartRecord → duplicate multipart upload on the same record.
    //
    // The fix: move inFlightRecordIds.add() to immediately after the .has()
    // check, synchronously, before any await. This test seeds a record with
    // a slow complete so the lease is held during the second drain call,
    // and asserts exactly one complete fires.
    const stores = installFakeIndexedDb()
    await drainQueuedReplayUploads()

    const record = {
      id: 'drain-vs-drain:camera:0',
      sessionId: '507f1f77bcf86cd799439011',
      kind: 'camera' as const,
      blob: new Blob([new Uint8Array(8 * 1024 * 1024)], { type: 'video/webm' }),
      sizeBytes: 8 * 1024 * 1024,
      contentType: 'video/webm',
      createdAt: Date.now(),
      parts: [{ partNumber: 1, etag: '"e1"' }],
      attempts: 0,
      key: 'recordings/user/session-camera.webm',
      uploadId: 'upload-drain-race',
      partSizeBytes: 8 * 1024 * 1024,
    }
    stores.get('uploads')!.set(record.id, record)

    let resolveComplete: ((value: unknown) => void) | null = null
    const completeBarrier = new Promise<unknown>((r) => { resolveComplete = r })
    const completeCalls: number[] = []

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === '/api/storage/multipart') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string }
        if (body.action === 'complete') {
          completeCalls.push(Date.now())
          await completeBarrier // hold so the second drain races the first
          return jsonResponse({ key: record.key })
        }
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }))

    // Fire two drains in parallel — exactly the situation a fast
    // /interview → /feedback navigation produces.
    const drainA = drainQueuedReplayUploads()
    const drainB = drainQueuedReplayUploads()

    // Let drainA reach the complete barrier; drainB must see drainA's
    // inFlightRecordIds entry and skip.
    await new Promise((r) => setTimeout(r, 20))

    resolveComplete!(null)
    const [resultA, resultB] = await Promise.all([drainA, drainB])

    // Exactly one upload across both drains. The other must have been
    // skipped — not failed, not queued, not dropped.
    expect(resultA.uploaded + resultB.uploaded).toBe(1)
    expect(resultA.skipped + resultB.skipped).toBe(1)
    expect(resultA.queued + resultB.queued).toBe(0)
    expect(resultA.dropped + resultB.dropped).toBe(0)

    // And — the load-bearing invariant — exactly one complete call.
    expect(completeCalls).toHaveLength(1)
  })

  // ── Layer 4: 401 from server marks the record permanent ─────────────────
  it('purges the full replay queue when multipart returns exact account-unavailable', async () => {
    const stores = installFakeIndexedDb()
    await drainQueuedReplayUploads()

    const baseRecord = {
      sessionId: '507f1f77bcf86cd799439011',
      kind: 'camera' as const,
      blob: new Blob([new Uint8Array(8 * 1024 * 1024)], { type: 'video/webm' }),
      sizeBytes: 8 * 1024 * 1024,
      contentType: 'video/webm',
      createdAt: Date.now(),
      parts: [] as Array<{ partNumber: number; etag: string }>,
      attempts: 0,
      partSizeBytes: 8 * 1024 * 1024,
    }
    stores.get('uploads')!.set('account-unavailable:camera:1', {
      ...baseRecord,
      id: 'account-unavailable:camera:1',
      key: 'recordings/user/session-camera-1.webm',
      uploadId: 'upload-account-unavailable-1',
    })
    stores.get('uploads')!.set('account-unavailable:camera:2', {
      ...baseRecord,
      id: 'account-unavailable:camera:2',
      key: 'recordings/user/session-camera-2.webm',
      uploadId: 'upload-account-unavailable-2',
    })

    const fetchMock = vi.fn(async () => jsonResponse({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    }, 401))
    vi.stubGlobal('fetch', fetchMock)

    await expect(drainQueuedReplayUploads()).resolves.toEqual({
      attempted: 2,
      uploaded: 0,
      queued: 0,
      dropped: 0,
      skipped: 0,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(stores.get('uploads')?.size).toBe(0)
  })

  it('purges the full replay queue when multipart returns exact session-changed', async () => {
    const stores = installFakeIndexedDb()
    await drainQueuedReplayUploads()

    const baseRecord = {
      sessionId: SESSION_ID,
      kind: 'camera' as const,
      blob: new Blob([new Uint8Array(8 * 1024 * 1024)], { type: 'video/webm' }),
      sizeBytes: 8 * 1024 * 1024,
      contentType: 'video/webm',
      originUserId: USER_ID,
      createdAt: Date.now(),
      parts: [] as Array<{ partNumber: number; etag: string }>,
      attempts: 0,
      partSizeBytes: 8 * 1024 * 1024,
    }
    stores.get('uploads')!.set('session-changed:camera:1', {
      ...baseRecord,
      id: 'session-changed:camera:1',
      key: RECORDING_KEY,
      uploadId: 'upload-session-changed-1',
    })
    stores.get('uploads')!.set('session-changed:camera:2', {
      ...baseRecord,
      id: 'session-changed:camera:2',
      key: `recordings/${USER_ID}/${SESSION_ID}-1700000000001.webm`,
      uploadId: 'upload-session-changed-2',
    })

    const fetchMock = vi.fn(async () => jsonResponse({
      error: 'sign-in session changed',
      code: 'SESSION_CHANGED',
    }, 409))
    vi.stubGlobal('fetch', fetchMock)

    await expect(drainQueuedReplayUploads()).resolves.toEqual({
      attempted: 2,
      uploaded: 0,
      queued: 0,
      dropped: 0,
      skipped: 0,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(stores.get('uploads')?.size).toBe(0)
  })

  it('treats 401/403 from /api/storage/multipart as a permanent failure (Layer 4)', async () => {
    // Simulates the user's NextAuth session expiring mid-upload. Retrying
    // forever with the same expired cookie is pointless — the record must
    // be dropped, not queued.
    const stores = installFakeIndexedDb()
    await drainQueuedReplayUploads()

    const record = {
      id: 'auth-gone:camera:0',
      sessionId: '507f1f77bcf86cd799439011',
      kind: 'camera',
      blob: new Blob([new Uint8Array(8 * 1024 * 1024)], { type: 'video/webm' }),
      sizeBytes: 8 * 1024 * 1024,
      contentType: 'video/webm',
      createdAt: Date.now(),
      parts: [] as Array<{ partNumber: number; etag: string }>,
      attempts: 0,
      key: 'recordings/user/session-camera.webm',
      uploadId: 'upload-auth-gone',
      partSizeBytes: 8 * 1024 * 1024,
    }
    stores.get('uploads')!.set(record.id, record)

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === '/api/storage/multipart') {
        return jsonResponse({ error: 'Unauthorized' }, 401)
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }))

    const result = await drainQueuedReplayUploads()
    expect(result.dropped).toBe(1)
    expect(result.queued).toBe(0)
    expect(stores.get('uploads')!.get(record.id)).toBeUndefined()
  })
})
