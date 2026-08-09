/**
 * Sarvam TTS adapter — the load-bearing parts are (1) the wire contract
 * (field names live-verified against api.sarvam.ai on 2026-08-09 — these
 * tests pin them against accidental "fixes"), (2) the fetch-shaped Response
 * contract the hot-path TTS routes depend on (chunked/tee()-able MP3 body,
 * non-2xx passthrough), and (3) the guards that turn silent audio
 * corruption into a loud 502 (content-type drift, empty audio, WAV bytes).
 *
 * Two paths: texts ≤3500 chars use the REST STREAM endpoint (progressive
 * chunked MP3, measured TTFB ~0.3s — interview pacing depends on this);
 * oversize texts fall back to the buffered REST endpoint in ≤2500-char
 * sentence-boundary pieces.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  chunkForSarvam,
  buildSarvamRequestBody,
  sarvamSynthesize,
  SARVAM_TTS_MODEL,
  isSarvamTTSConfigured,
} from '../sarvamTTS'

// A few bytes starting with an MP3 frame sync (0xFF 0xFB) — enough for the
// adapter's format sniffing; it never decodes audio.
const MP3_A = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x01, 0x02, 0x03])
const MP3_B = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x0a, 0x0b])
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.from([36, 0, 0, 0]), Buffer.from('WAVE')])

/** The buffered REST endpoint's response shape (base64 JSON). */
function bufferedOk(audio: Buffer): Response {
  return new Response(
    JSON.stringify({ request_id: 'req_test', audios: [audio.toString('base64')] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

/** The stream endpoint's response shape (chunked binary MP3). */
function streamOk(audio: Buffer): Response {
  return new Response(new Uint8Array(audio), {
    status: 200,
    headers: { 'Content-Type': 'audio/mpeg' },
  })
}

/** ~4000 chars of sentences — forces the oversize buffered fallback. */
function oversizeText(): string {
  return `${'This sentence pads the interview intro to force chunking. '.repeat(70)}`.trim()
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('buildSarvamRequestBody — the wire contract', () => {
  it('sends exactly the fields Sarvam expects, with the pinned names', () => {
    const body = buildSarvamRequestBody('Hello there')
    expect(body).toEqual({
      text: 'Hello there',
      // Pinned: live-verified on both /text-to-speech and /stream
      // (2026-08-09). Docs oscillate between this and language_code —
      // changing it requires a live-key test.
      target_language_code: 'en-IN',
      speaker: 'ishita',
      model: 'bulbul:v3',
      output_audio_codec: 'mp3',
    })
    // Minimal payload by design: no sample-rate/pace keys whose names vary
    // between doc revisions — provider defaults are correct.
    expect(Object.keys(body).sort()).toEqual([
      'model',
      'output_audio_codec',
      'speaker',
      'target_language_code',
      'text',
    ])
  })
})

describe('cache partition key', () => {
  it('embeds model + speaker so voice changes roll the R2 key', () => {
    expect(SARVAM_TTS_MODEL).toBe('sarvam-bulbul:v3-ishita')
  })
})

describe('isSarvamTTSConfigured', () => {
  it('is false without SARVAM_API_KEY (module default in tests)', () => {
    expect(isSarvamTTSConfigured()).toBe(false)
  })

  it('is true when SARVAM_API_KEY is set at module load', async () => {
    vi.stubEnv('SARVAM_API_KEY', 'sk-test')
    vi.resetModules()
    const fresh = await import('../sarvamTTS')
    expect(fresh.isSarvamTTSConfigured()).toBe(true)
  })
})

describe('chunkForSarvam', () => {
  it('passes short text through as a single piece', () => {
    expect(chunkForSarvam('Tell me about yourself.')).toEqual(['Tell me about yourself.'])
  })

  it('splits long text at sentence boundaries with every piece under the cap', () => {
    const sentence = `${'a'.repeat(120)}. `
    const text = sentence.repeat(30).trim() // ~3.6k chars
    const chunks = chunkForSarvam(text, 2500)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2500)
      expect(chunk.length).toBeGreaterThan(0)
    }
    // Nothing lost: rejoining reproduces the original modulo whitespace.
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '))
  })

  it('falls back to word boundaries when there are no sentence breaks', () => {
    const text = Array.from({ length: 700 }, (_, i) => `word${i}`).join(' ') // >4k chars
    const chunks = chunkForSarvam(text, 2500)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2500)
      // Word-boundary split never bisects a token.
      expect(text.split(' ')).toEqual(expect.arrayContaining(chunk.split(' ')))
    }
  })
})

describe('sarvamSynthesize — STREAMING path (≤3500 chars, the hot path)', () => {
  it('POSTs to the STREAM endpoint with the subscription-key header and 64k bitrate', async () => {
    const fetchMock = vi.fn().mockResolvedValue(streamOk(MP3_A))
    vi.stubGlobal('fetch', fetchMock)

    await sarvamSynthesize('Hello')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.sarvam.ai/text-to-speech/stream')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect('api-subscription-key' in init.headers).toBe(true)
    const body = JSON.parse(init.body)
    expect(body.text).toBe('Hello')
    expect(body.model).toBe('bulbul:v3')
    expect(body.output_audio_codec).toBe('mp3')
    expect(body.output_audio_bitrate).toBe('64k')
  })

  it('forwards chunks PROGRESSIVELY — resolves while the provider is still synthesizing', async () => {
    // Chunk 2 is gated: if the adapter drained the stream before returning
    // (the re-buffering bug the endpoint switch fixed), this await would
    // deadlock and the test would time out.
    let releaseSecondChunk!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseSecondChunk = resolve
    })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MP3_A))
      },
      async pull(controller) {
        await gate
        controller.enqueue(new Uint8Array(MP3_B))
        controller.close()
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(body, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } }),
      ),
    )

    const res = await sarvamSynthesize('Hello')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('audio/mpeg')

    // Only now let the "rest of the synthesis" arrive; nothing is lost or
    // reordered across the peek-then-forward seam.
    releaseSecondChunk()
    const drained = Buffer.from(await res.arrayBuffer())
    expect(drained.equals(Buffer.concat([MP3_A, MP3_B]))).toBe(true)
  })

  it('502s when a 200 stream ends before any audio byte (R2 cache-poison guard, Codex P2 on #611)', async () => {
    const empty = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(0)) // leading empty chunk
          controller.close()
        },
      }),
      { status: 200, headers: { 'Content-Type': 'audio/mpeg' } },
    )
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(empty))

    const res = await sarvamSynthesize('Hello')
    expect(res.status).toBe(502)
    expect(await res.text()).toContain('no audio')
  })

  it('502s when the first streamed bytes are WAV despite an audio/mpeg label', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array(WAV), {
          status: 200,
          headers: { 'Content-Type': 'audio/mpeg' },
        }),
      ),
    )

    const res = await sarvamSynthesize('Hello')
    expect(res.status).toBe(502)
    expect(await res.text()).toContain('WAV')
  })

  it('passes a provider error Response through untouched', async () => {
    const unauthorized = new Response('invalid subscription key', { status: 401 })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(unauthorized))

    const res = await sarvamSynthesize('Hello')

    expect(res).toBe(unauthorized)
    expect(res.status).toBe(401)
  })

  it('502s loudly on content-type drift instead of feeding MediaSource non-MP3 bytes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array(WAV), {
          status: 200,
          headers: { 'Content-Type': 'audio/wav' },
        }),
      ),
    )

    const res = await sarvamSynthesize('Hello')
    expect(res.status).toBe(502)
    expect(await res.text()).toContain('content-type')
  })
})

describe('sarvamSynthesize — buffered fallback (>3500 chars)', () => {
  it('fires one buffered REST request per chunk and concatenates audio in order', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(bufferedOk(MP3_A))
      .mockResolvedValueOnce(bufferedOk(MP3_B))
    vi.stubGlobal('fetch', fetchMock)

    const res = await sarvamSynthesize(oversizeText())

    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [url] of fetchMock.mock.calls) {
      expect(url).toBe('https://api.sarvam.ai/text-to-speech')
    }
    expect(res.headers.get('Content-Type')).toBe('audio/mpeg')
    const audio = Buffer.from(await res.arrayBuffer())
    expect(audio.equals(Buffer.concat([MP3_A, MP3_B]))).toBe(true)
  })

  it('passes a buffered provider error through untouched', async () => {
    const unauthorized = new Response('invalid subscription key', { status: 401 })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(unauthorized))

    const res = await sarvamSynthesize(oversizeText())

    expect(res).toBe(unauthorized)
  })

  it('turns an empty audios payload into a loud 502 instead of caching silence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ request_id: 'r', audios: [] }), { status: 200 }),
      ),
    )

    const res = await sarvamSynthesize(oversizeText())
    expect(res.status).toBe(502)
  })

  it('rejects WAV bytes (codec contract drift) instead of mislabeling them audio/mpeg', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(bufferedOk(WAV)))

    const res = await sarvamSynthesize(oversizeText())
    expect(res.status).toBe(502)
    expect(await res.text()).toContain('WAV')
  })
})
