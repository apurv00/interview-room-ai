/**
 * Contract test for app/api/tts/stream/route.ts (HOT PATH).
 *
 * Validates Fix 1 in commit f6bc48a mechanically: the route must pipe
 * Deepgram's response body progressively to the client via
 * `response.body.tee()` rather than buffering the whole response with
 * `await response.arrayBuffer()`. The original regression in commit
 * 133e44f silently added ~1500–3000ms to the intro question's time-
 * to-first-sound and wasn't caught by any existing test.
 *
 * The test mocks `fetch` so Deepgram returns a ReadableStream whose
 * second chunk is gated behind a test-controlled promise. If the route
 * is streaming correctly, the first chunk reaches the client BEFORE
 * the gate is released. If someone re-introduces `arrayBuffer()` in
 * the future, the POST handler will hang on the gate and this test
 * will time out.
 *
 * See modules/interview/docs/INTERVIEW_FLOW.md §7.3 and §8 for the
 * full invariant + failure-mode history.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

// ─── Mocks (must be before route import) ───────────────────────────────────

vi.mock('next-auth', () => ({
  getServerSession: vi.fn().mockResolvedValue({
    user: { id: 'test-user-1' },
  }),
}))

vi.mock('@shared/auth/authOptions', () => ({
  authOptions: {},
}))

vi.mock('@shared/logger', () => ({
  aiLogger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}))

// Hoisted so vi.mock (also hoisted) can reference these without TDZ errors.
const { mockCacheTTS, mockGetCachedTTS } = vi.hoisted(() => ({
  mockCacheTTS: vi.fn().mockResolvedValue(undefined),
  mockGetCachedTTS: vi.fn().mockResolvedValue(null), // default: cache miss
}))

vi.mock('@shared/services/ttsCache', () => ({
  cacheTTS: mockCacheTTS,
  getCachedTTS: mockGetCachedTTS,
}))

// Rate limiting uses a Redis counter. Mock the shared redis client so the
// existing streaming-contract tests don't depend on a real Redis instance
// AND so the per-user 30/min quota doesn't tip over when multiple test
// cases share the same mocked user id.
const { mockRedisIncr, mockRedisPexpire } = vi.hoisted(() => ({
  mockRedisIncr: vi.fn().mockResolvedValue(1),
  mockRedisPexpire: vi.fn().mockResolvedValue(1),
}))
vi.mock('@shared/redis', () => ({
  redis: {
    incr: (...args: unknown[]) => mockRedisIncr(...args),
    pexpire: (...args: unknown[]) => mockRedisPexpire(...args),
  },
}))

// DEEPGRAM_API_KEY must be set at module load time since the route
// captures it in a module-level const. `vi.hoisted` runs before any
// imports resolve, so this assignment wins the race.
vi.hoisted(() => {
  process.env.DEEPGRAM_API_KEY = 'test-deepgram-key'
})

// Import AFTER mocks + env are set up.
import { POST } from '@/app/api/tts/stream/route'

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/tts/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/**
 * Create a fake Deepgram Response whose body streams two chunks,
 * with the SECOND chunk gated behind a test-controlled promise.
 * Returns the Response plus the release function.
 */
function makeGatedDeepgramResponse() {
  let releaseChunk2: () => void = () => {}
  const chunk2Gate = new Promise<void>((resolve) => {
    releaseChunk2 = resolve
  })

  const chunk1 = new Uint8Array([1, 2, 3, 4])
  const chunk2 = new Uint8Array([5, 6, 7, 8])

  const stream = new ReadableStream({
    async start(controller) {
      // Emit chunk 1 immediately.
      controller.enqueue(chunk1)
      // Wait for the test to release chunk 2.
      await chunk2Gate
      controller.enqueue(chunk2)
      controller.close()
    },
  })

  const response = new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'audio/mpeg' },
  })

  return { response, releaseChunk2: () => releaseChunk2(), chunk1, chunk2 }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('POST /api/tts/stream — streaming contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCachedTTS.mockResolvedValue(null) // default: cache miss
    mockCacheTTS.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('streams Deepgram chunks progressively (first chunk before last)', async () => {
    const { response, releaseChunk2, chunk1, chunk2 } = makeGatedDeepgramResponse()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))

    // POST handler must return quickly — if it's doing
    // `await response.arrayBuffer()`, it will hang here until chunk 2
    // is released, and the test below will either time out or observe
    // chunk 1 and chunk 2 arriving at the same instant.
    const resPromise = POST(makeRequest({ text: 'hello world' }))

    // Wrap POST in a 500ms timeout race — a correct streaming
    // implementation returns in <50ms (it only awaits the fetch call,
    // which is mocked). A broken buffered implementation will hang
    // waiting for Deepgram's full response.
    const res = (await Promise.race([
      resPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('POST did not return within 500ms — route is buffering the response')), 500)
      ),
    ])) as Response

    expect(res.status).toBe(200)
    expect(res.headers.get('X-TTS-Cache')).toBe('miss')
    expect(res.body).toBeTruthy()

    // Read the first chunk from the client branch BEFORE releasing
    // chunk 2. This is the critical assertion: if the route is
    // buffered, the response body was assembled from a complete
    // arrayBuffer and chunk 1 only arrives after chunk 2 is already
    // in the buffer. With tee(), chunk 1 flows through immediately.
    const reader = res.body!.getReader()
    const first = await Promise.race([
      reader.read(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('First chunk did not arrive before chunk 2 was released — route is not streaming')), 500)
      ),
    ]) as ReadableStreamReadResult<Uint8Array>

    expect(first.done).toBe(false)
    expect(first.value).toEqual(chunk1)

    // Now release chunk 2 and drain the rest.
    releaseChunk2()
    const second = await reader.read()
    expect(second.done).toBe(false)
    expect(second.value).toEqual(chunk2)
    const end = await reader.read()
    expect(end.done).toBe(true)

    // The cache branch should eventually receive both chunks joined.
    await vi.waitFor(() => {
      expect(mockCacheTTS).toHaveBeenCalledTimes(1)
    })
    const [cachedText, cachedBuf, cachedEncoding] = mockCacheTTS.mock.calls[0]
    expect(cachedText).toBe('hello world')
    expect(cachedEncoding).toBe('mp3')
    expect(Array.from(cachedBuf as Uint8Array)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('returns R2 cache hit without calling Deepgram', async () => {
    const cachedBytes = Buffer.from([9, 9, 9])
    mockGetCachedTTS.mockResolvedValue(cachedBytes)

    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const res = await POST(makeRequest({ text: 'cached text' }))

    expect(res.status).toBe(200)
    expect(res.headers.get('X-TTS-Cache')).toBe('hit')
    expect(fetchSpy).not.toHaveBeenCalled()

    const buf = new Uint8Array(await res.arrayBuffer())
    expect(Array.from(buf)).toEqual([9, 9, 9])

    // Never writes back to cache on a hit.
    expect(mockCacheTTS).not.toHaveBeenCalled()
  })

  it('returns 401 when no session', async () => {
    const { getServerSession } = await import('next-auth')
    vi.mocked(getServerSession).mockResolvedValueOnce(null)

    const res = await POST(makeRequest({ text: 'nope' }))
    expect(res.status).toBe(401)
  })

  it('returns 400 on invalid text payload', async () => {
    const res = await POST(makeRequest({ text: '' }))
    expect(res.status).toBe(400)
  })

  it('cache write failure is non-fatal (client still streams)', async () => {
    mockCacheTTS.mockRejectedValueOnce(new Error('R2 unreachable'))

    const { response, releaseChunk2 } = makeGatedDeepgramResponse()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))

    const res = await POST(makeRequest({ text: 'hello world' }))
    expect(res.status).toBe(200)

    // Client branch still drains successfully.
    const reader = res.body!.getReader()
    const first = await reader.read()
    expect(first.value).toEqual(new Uint8Array([1, 2, 3, 4]))
    releaseChunk2()
    await reader.read()
    await reader.read()
  })

  // ─── Rate limiting (N1) ──────────────────────────────────────────────────

  it('returns 429 when the per-user rate limit is exceeded', async () => {
    // Simulate 31st request in the current window — one over the 30/min cap.
    mockRedisIncr.mockResolvedValueOnce(31)

    const res = await POST(makeRequest({ text: 'over limit' }))
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('60')
  })

  it('keys rate limit per user (id is embedded in the redis key)', async () => {
    mockRedisIncr.mockResolvedValueOnce(1)

    const { response, releaseChunk2 } = makeGatedDeepgramResponse()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))

    await POST(makeRequest({ text: 'hello' }))

    expect(mockRedisIncr).toHaveBeenCalledWith('rl:tts-stream:test-user-1')
    releaseChunk2()
  })

  it('redis failure fails open (request still served)', async () => {
    // Redis throws → checkRateLimit catches the error and returns null,
    // allowing the request. A cache blip must not take TTS offline.
    mockRedisIncr.mockRejectedValueOnce(new Error('ECONNREFUSED'))

    const { response, releaseChunk2 } = makeGatedDeepgramResponse()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))

    const res = await POST(makeRequest({ text: 'hello' }))
    expect(res.status).toBe(200)
    releaseChunk2()
  })
})

