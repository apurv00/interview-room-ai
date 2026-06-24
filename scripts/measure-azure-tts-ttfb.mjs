#!/usr/bin/env node
/**
 * Azure TTS TTFB measurement (feedback #4 — the Indian-accent voice).
 *
 * Validates that the Azure path streams its first audio byte within the
 * hot-path budget (≤600ms, INTERVIEW_FLOW.md §5), exactly like Deepgram. Azure
 * returns a chunked MP3 stream, so we tee() it and measure time-to-first-chunk
 * on the client branch — the same handling app/api/tts/stream/route.ts uses.
 *
 * Run (after adding AZURE_SPEECH_* to .env.local):
 *   node scripts/measure-azure-tts-ttfb.mjs
 *
 * Reads .env.local; no secrets are committed.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Tiny .env.local reader — avoids adding dotenv as a dep.
function loadEnvLocal() {
  const p = path.join(__dirname, '..', '.env.local')
  if (!fs.existsSync(p)) return
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/\s+#.*$/, '').trim()
  }
}
loadEnvLocal()

const KEY = process.env.AZURE_SPEECH_KEY
const REGION = process.env.AZURE_SPEECH_REGION
const VOICE = process.env.AZURE_SPEECH_VOICE || 'en-IN-Aarti:DragonHDLatestNeural'
if (!KEY || !REGION) {
  console.error('AZURE_SPEECH_KEY and AZURE_SPEECH_REGION must be set (add them to .env.local).')
  process.exit(1)
}

const TEST_TEXT =
  "Hi, I'm Alex. I'll be your interviewer today. Tell me about a time you handled a difficult stakeholder, and what you'd do differently next time."

function escapeXml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function buildSsml(text, voice) {
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-IN'>` +
    `<voice name='${voice}'>${escapeXml(text)}</voice></speak>`
  )
}

async function callAzure() {
  return fetch(
    `https://${REGION}.tts.speech.microsoft.com/cognitiveservices/v1`,
    {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': KEY,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'User-Agent': 'interview-room-ai',
      },
      body: buildSsml(TEST_TEXT, VOICE),
    },
  )
}

async function measureTeed() {
  const t0 = performance.now()
  const res = await callAzure()
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '')
    throw new Error(`Azure TTS failed: ${res.status} ${body.slice(0, 300)}`)
  }
  const [clientStream, cacheStream] = res.body.tee()

  const cachePromise = (async () => {
    const reader = cacheStream.getReader()
    const chunks = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
    return Buffer.concat(chunks)
  })()

  const clientReader = clientStream.getReader()
  const { value: firstChunk } = await clientReader.read()
  const t1 = performance.now()
  const ttfbMs = Math.round(t1 - t0)

  let totalClientBytes = firstChunk ? firstChunk.length : 0
  while (true) {
    const { done, value } = await clientReader.read()
    if (done) break
    if (value) totalClientBytes += value.length
  }
  const t2 = performance.now()
  const cacheBuf = await cachePromise

  return {
    ttfbMs,
    firstChunkBytes: firstChunk ? firstChunk.length : 0,
    totalClientBytes,
    cacheBytes: cacheBuf.length,
    totalMs: Math.round(t2 - t0),
  }
}

async function main() {
  console.log('Azure TTS TTFB measurement — Indian-accent voice (feedback #4)')
  console.log('Region:', REGION, '· Voice:', VOICE)
  console.log('Test text:', `"${TEST_TEXT.slice(0, 60)}…" (${TEST_TEXT.length} chars)`)
  console.log('')

  // Two runs: first is cold (synthesis), second warms TCP/TLS — report both.
  for (const label of ['run 1 (cold)', 'run 2 (warm conn)']) {
    const r = await measureTeed()
    console.log(`${label}:`)
    console.log(`  TTFB (first audio byte): ${r.ttfbMs}ms`)
    console.log(`  First chunk: ${r.firstChunkBytes} bytes · total client: ${r.totalClientBytes} · cache: ${r.cacheBytes} bytes · drained in ${r.totalMs}ms`)
  }
  console.log('')

  const final = await measureTeed()
  const TARGET_TTFB_MS = 600
  console.log(`Invariant (INTERVIEW_FLOW.md §5): /api/tts/stream TTFB ≤${TARGET_TTFB_MS}ms (cold cache)`)
  if (final.ttfbMs <= TARGET_TTFB_MS) {
    console.log(`  PASS — ${final.ttfbMs}ms ≤ ${TARGET_TTFB_MS}ms`)
  } else {
    console.log(`  OVER BUDGET — ${final.ttfbMs}ms > ${TARGET_TTFB_MS}ms (acceptable only as an explicit opt-in trade)`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('measurement failed:', err)
  process.exit(1)
})
