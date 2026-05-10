import {
  drainQueuedReplayUploads,
  getPartRange,
  uploadReplayRecording,
} from '@interview/utils/resumableUpload'

function deferredRequest<T>(result: T): IDBRequest<T> {
  const request = { result } as IDBRequest<T>
  setTimeout(() => request.onsuccess?.(new Event('success')), 0)
  return request
}

function installFakeIndexedDb() {
  const stores = new Map<string, Map<string, unknown>>()
  const db = {
    objectStoreNames: {
      contains: (name: string) => stores.has(name),
    },
    createObjectStore: (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map())
    },
    transaction: (name: string) => ({
      objectStore: () => ({
        put: (record: { id: string }) => {
          stores.get(name)?.set(record.id, record)
          return deferredRequest(record.id)
        },
        delete: (id: string) => {
          stores.get(name)?.delete(id)
          return deferredRequest(undefined)
        },
        getAll: () => deferredRequest(Array.from(stores.get(name)?.values() ?? [])),
      }),
      oncomplete: null,
      onerror: null,
      onabort: null,
    }),
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
          key: 'recordings/user/session-camera.webm',
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
        if (status === 200) return jsonResponse({ key: 'recordings/user/session-camera.webm' })
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
  })

  it('splits multipart upload ranges without exceeding the blob size', () => {
    const partSize = 8 * 1024 * 1024
    const size = partSize * 2 + 123

    expect(getPartRange(1, size, partSize)).toEqual({ start: 0, end: partSize })
    expect(getPartRange(2, size, partSize)).toEqual({ start: partSize, end: partSize * 2 })
    expect(getPartRange(3, size, partSize)).toEqual({ start: partSize * 2, end: size })
  })

  it('drops queued multipart uploads permanently on 410 responses', async () => {
    const completeStatuses = { current: [410] }
    vi.stubGlobal('fetch', installMultipartFetch(completeStatuses))

    const result = await uploadReplayRecording('507f1f77bcf86cd799439011', 'camera', largeReplayBlob())
    const drain = await drainQueuedReplayUploads()

    expect(result).toEqual({ status: 'dropped' })
    expect(drain).toEqual({ attempted: 0, uploaded: 0, queued: 0, dropped: 0 })
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
    expect(retry).toEqual({ attempted: 1, uploaded: 1, queued: 0, dropped: 0 })

    const empty = await drainQueuedReplayUploads()
    expect(empty).toEqual({ attempted: 0, uploaded: 0, queued: 0, dropped: 0 })
  })
})
