/**
 * Azure AI Speech — Text-to-Speech adapter (the "Indian voice" personality).
 *
 * Why this exists: Deepgram Aura has no Indian-English voice, so the opt-in
 * Indian interviewer voice is served by Azure. Azure's `cognitiveservices/v1`
 * REST endpoint returns a CHUNKED MP3 stream — the same shape Deepgram returns
 * — so the TTS routes can `tee()` it and the client's MediaSource can play it
 * with ZERO changes to the playback pipeline. This is purely additive: it only
 * runs when the request carries `?voice=indian` AND Azure is configured;
 * otherwise the Deepgram path is byte-for-byte unchanged.
 *
 * Auth is a simple region + subscription key (no service-account JSON, no SDK).
 */

const AZURE_KEY = process.env.AZURE_SPEECH_KEY
const AZURE_REGION = process.env.AZURE_SPEECH_REGION
// Default to a GA standard-neural en-IN voice. For the most realistic
// (Dragon HD) voices, set AZURE_SPEECH_VOICE to e.g. 'en-IN-Aarti:DragonHDLatestNeural'
// or 'en-IN-Arjun:DragonHDLatestNeural' once confirmed GA in your region.
const AZURE_VOICE = process.env.AZURE_SPEECH_VOICE || 'en-IN-NeerjaNeural'

/**
 * Cache-key "model" id for the Azure voice. `ttsCacheKey` strips non-alphanumeric
 * chars, so this safely partitions Azure audio from Deepgram's `aura-*` entries
 * in R2 — they can never collide even for identical text.
 */
export const AZURE_TTS_MODEL = `azure-${AZURE_VOICE}`

/** Azure is usable only when both the key and region are present. */
export function isAzureTTSConfigured(): boolean {
  return !!(AZURE_KEY && AZURE_REGION)
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Synthesize `text` via Azure AI Speech. Returns the raw `fetch` Response whose
 * body is a chunked MP3 stream (24kHz/48kbit mono, matching the `audio/mpeg`
 * MediaSource pipeline). Callers tee() it for streaming + R2 cache, or
 * arrayBuffer() it for the buffered path — identical handling to Deepgram.
 *
 * Throws only on network failure; a non-2xx Azure response is returned as-is so
 * the route can log status/body and surface a 502 (the client then falls through
 * its existing TTS fallback chain).
 */
/**
 * Build the Azure SSML payload. Exported for testing — the XML escaping is
 * security-relevant: an interview question containing `<`, `&`, etc. must not
 * break the SSML or inject markup into the request.
 */
export function buildSsml(text: string, voice: string = AZURE_VOICE): string {
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-IN'>` +
    `<voice name='${voice}'>${escapeXml(text)}</voice>` +
    `</speak>`
  )
}

export async function azureSynthesize(text: string): Promise<Response> {
  return fetch(
    `https://${AZURE_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`,
    {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': AZURE_KEY as string,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'User-Agent': 'interview-room-ai',
      },
      body: buildSsml(text),
    },
  )
}
