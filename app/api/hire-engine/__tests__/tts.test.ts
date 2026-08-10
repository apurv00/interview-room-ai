import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  checkRateLimit: vi.fn(),
  authorize: vi.fn(),
  synthesize: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/middleware/checkRateLimit', () => ({
  checkRateLimit: mocks.checkRateLimit,
}))
vi.mock('@shared/logger', () => ({
  aiLogger: { error: vi.fn() },
}))
vi.mock('@modules/hire-runtime/services/runtimeTtsService', () => ({
  authorizeRuntimeTtsBoundary: mocks.authorize,
  synthesizeRuntimeTts: mocks.synthesize,
}))

import { POST as bufferedPost } from '../tts/route'
import { POST as streamingPost } from '../tts/stream/route'

const WORKSPACE_ID = 'a'.repeat(24)
const PRINCIPAL_ID = 'b'.repeat(24)

function request(pathname: string): NextRequest {
  return new NextRequest(`https://engine.test${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-ipg-hire-runtime-fence-bypass': 'f'.repeat(64),
    },
    body: JSON.stringify({ text: 'A candidate-specific follow-up.' }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.authorize.mockReturnValue(true)
  mocks.getServerSession.mockResolvedValue({
    user: { id: PRINCIPAL_ID, organizationId: WORKSPACE_ID },
  })
  mocks.checkRateLimit.mockResolvedValue(null)
})

describe('Hire runtime transient TTS boundary', () => {
  it('buffers provider audio without exposing a cacheable response', async () => {
    mocks.synthesize.mockResolvedValue({
      response: new Response(new Uint8Array([1, 2, 3])),
      provider: 'deepgram',
      encoding: 'mp3',
    })
    const response = await bufferedPost(request('/api/hire-engine/tts'))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('x-tts-cache')).toBe('disabled')
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      `${WORKSPACE_ID}:${PRINCIPAL_ID}`,
      expect.any(Object),
    )
  })

  it('passes the provider stream through directly with caching disabled', async () => {
    const providerBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([4, 5, 6]))
        controller.close()
      },
    })
    mocks.synthesize.mockResolvedValue({
      response: new Response(providerBody),
      provider: 'deepgram',
      encoding: 'opus',
    })
    const response = await streamingPost(
      request('/api/hire-engine/tts/stream?encoding=opus'),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('audio/opus')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('x-tts-cache')).toBe('disabled')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([4, 5, 6]),
    )
  })

  it('is outside the shared cache dependency graph', () => {
    for (const path of [
      'modules/hire-runtime/services/runtimeTtsService.ts',
      'app/api/hire-engine/tts/route.ts',
      'app/api/hire-engine/tts/stream/route.ts',
    ]) {
      const source = readFileSync(path, 'utf8')
      expect(source).not.toMatch(/ttsCache|cacheTTS|getCachedTTS/)
    }
  })

  it('rejects direct access that did not cross the runtime write fence', async () => {
    mocks.authorize.mockReturnValue(false)
    const response = await bufferedPost(request('/api/hire-engine/tts'))
    expect(response.status).toBe(404)
    expect(mocks.getServerSession).not.toHaveBeenCalled()
  })
})
