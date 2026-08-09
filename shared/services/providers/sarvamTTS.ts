/**
 * Sarvam AI (Bulbul) — Text-to-Speech adapter: the "Indian voice" personality.
 *
 * Replaces the Azure Speech adapter (2026-08-09). The Azure key began
 * returning 401 in every region (dead key/resource), and because the routes
 * fall back silently, every Indian-voice interview quietly played a US
 * fallback voice — see INTERVIEW_FLOW.md §8. Sarvam is India-first (native
 * en-IN voices, INR pricing) and takes plain JSON, which also removes the
 * SSML/XML-injection surface the Azure adapter had to escape.
 *
 * Contract with the TTS routes (kept identical to the Azure adapter so the
 * hot-path diff is a name swap): `sarvamSynthesize(text)` resolves to a
 * fetch-shaped Response whose body is complete MP3 bytes — tee()-able by
 * /api/tts/stream and arrayBuffer()-able by /api/tts. A non-2xx provider
 * response is passed through as-is so the routes log status/body and
 * surface a 502 (the client then walks its existing TTS fallback chain).
 *
 * Sarvam's REST endpoint is buffered (base64 audio in JSON — no chunked
 * stream), so on a cache miss the "stream" route delivers the whole clip in
 * one flush: time-to-first-sound equals full synthesis time instead of
 * first-chunk time. R2-cached repeats are unaffected. Sarvam's WebSocket
 * streaming API cannot be proxied through these route handlers — the same
 * constraint that kept the Azure adapter on REST.
 */

const SARVAM_KEY = process.env.SARVAM_API_KEY
const SARVAM_MODEL = process.env.SARVAM_TTS_MODEL_ID || 'bulbul:v3'
// ishita is Sarvam's documented top female pick for English (en-IN).
// Alternatives (female, en-IN capable): priya, shreya, shruti, kavya.
// Speaker ids are lowercase AND case-sensitive — audition on
// https://dashboard.sarvam.ai before changing.
const SARVAM_SPEAKER = process.env.SARVAM_TTS_SPEAKER || 'ishita'

/**
 * Cache-key "model" id. `ttsCacheKey` strips non-alphanumeric chars, so this
 * partitions Sarvam audio from Deepgram's `aura-*` (and the retired Azure)
 * entries in R2 — identical text can never serve the wrong voice, and a
 * speaker or model change rolls the key.
 */
export const SARVAM_TTS_MODEL = `sarvam-${SARVAM_MODEL}-${SARVAM_SPEAKER}`

/** Sarvam is usable only when the subscription key is present. */
export function isSarvamTTSConfigured(): boolean {
  return !!SARVAM_KEY
}

/** bulbul:v3 rejects inputs over 2500 characters per request. */
const MAX_CHARS_PER_REQUEST = 2500

/**
 * Split text into ≤`max`-char pieces at sentence (then word) boundaries.
 * The TTS routes cap text at 5000 chars, so real traffic is one piece and a
 * long intro is two — MP3 frame streams concatenate cleanly (no container).
 */
export function chunkForSarvam(text: string, max: number = MAX_CHARS_PER_REQUEST): string[] {
  const trimmed = text.trim()
  if (trimmed.length <= max) return [trimmed]
  const chunks: string[] = []
  let rest = trimmed
  while (rest.length > max) {
    const window = rest.slice(0, max)
    const sentenceEnd = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('! '),
      window.lastIndexOf('? '),
    )
    // Sentence break when it keeps the chunk reasonably full, else the last
    // word break, else a hard cut (single unbroken token — not real speech).
    const wordEnd = window.lastIndexOf(' ')
    const cut = sentenceEnd > max / 2 ? sentenceEnd + 1 : wordEnd > 0 ? wordEnd : max
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

/** Exported for tests — this object IS the wire contract with Sarvam. */
export function buildSarvamRequestBody(text: string): Record<string, unknown> {
  return {
    text,
    // `target_language_code` is what every shipping integration sends
    // (pipecat/livekit/mastra) and is accepted for bulbul:v3; current docs
    // also show `language_code`. Chosen from live integrations, not a live
    // key — do not rename without a real-key test.
    target_language_code: 'en-IN',
    speaker: SARVAM_SPEAKER,
    model: SARVAM_MODEL,
    // MP3 so the audio drops into the existing audio/mpeg MediaSource +
    // R2-cache pipeline unchanged. Sample rate omitted → provider default
    // (24 kHz on v3), matching the retired Azure output format.
    output_audio_codec: 'mp3',
  }
}

export async function sarvamSynthesize(text: string): Promise<Response> {
  const pieces = chunkForSarvam(text)
  const responses = await Promise.all(
    pieces.map((piece) =>
      fetch('https://api.sarvam.ai/text-to-speech', {
        method: 'POST',
        headers: {
          'api-subscription-key': SARVAM_KEY as string,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildSarvamRequestBody(piece)),
      }),
    ),
  )

  const failed = responses.find((r) => !r.ok)
  if (failed) {
    // Release the sibling sockets, then hand the error back untouched.
    await Promise.all(
      responses
        .filter((r) => r !== failed)
        .map((r) => r.body?.cancel().catch(() => undefined)),
    )
    return failed
  }

  const buffers: Buffer[] = []
  for (const r of responses) {
    const parsed = (await r.json().catch(() => null)) as { audios?: unknown[] } | null
    const audios = parsed && Array.isArray(parsed.audios) ? parsed.audios : []
    const first = audios[0]
    const audio = typeof first === 'string' ? Buffer.from(first, 'base64') : Buffer.alloc(0)
    if (audio.length === 0) {
      return new Response('Sarvam returned no audio', { status: 502 })
    }
    // If Sarvam ever ignores output_audio_codec and sends WAV (the API
    // default), serving it as audio/mpeg would silently break MediaSource
    // playback — fail loud instead so the client falls back cleanly.
    if (audio.toString('ascii', 0, 4) === 'RIFF') {
      return new Response('Sarvam returned WAV despite output_audio_codec=mp3', { status: 502 })
    }
    buffers.push(audio)
  }

  return new Response(new Uint8Array(Buffer.concat(buffers)), {
    status: 200,
    headers: { 'Content-Type': 'audio/mpeg' },
  })
}
