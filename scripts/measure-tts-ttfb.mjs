#!/usr/bin/env node
/**
 * TTS TTFB measurement — validates Fix 1 in PR f6bc48a.
 *
 * Compares two strategies for piping Deepgram Aura audio to a client:
 *
 *   1. BEFORE: `await response.arrayBuffer()` → buffer entire response
 *      server-side → return one complete Buffer. Client TTFB = full
 *      Deepgram round-trip (network + TTS synthesis).
 *
 *   2. AFTER: `response.body.tee()` → pipe one branch to a client sink,
 *      drain the other into a Buffer for R2 in the background. Client
 *      TTFB = time-to-first-byte from Deepgram (typically ~300ms).
 *
 * Run:
 *   DEEPGRAM_API_KEY=... node scripts/measure-tts-ttfb.mjs
 *
 * Not committed-to env vars. Reads `.env.local` if present.
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
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}
loadEnvLocal()

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY
if (!DEEPGRAM_API_KEY) {
  console.error('DEEPGRAM_API_KEY not set')
  process.exit(1)
}

const TTS_MODEL = 'aura-2-zeus-en'
const TEST_TEXT =
  "Hi, I'm Alex. I'll be your interviewer today. Let's start with a quick warmup — tell me a bit about yourself and what brings you here."

async function callDeepgram() {
  return fetch(
    `https://api.deepgram.com/v1/speak?model=${TTS_MODEL}&encoding=mp3`,
    {
      method: 'POST',
      headers: {
        Authorization: `Token ${DEEPGRAM_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: TEST_TEXT }),
    }
  )
}

// ─── Strategy A: BEFORE (buffer entire response) ─────────────────────────────
async function measureBuffered() {
  const t0 = performance.now()
  const res = await callDeepgram()
  if (!res.ok || !res.body) {
    throw new Error(`Deepgram failed: ${res.status}`)
  }
  // This is what the BROKEN route did:
  const buf = Buffer.from(await res.arrayBuffer())
  const t1 = performance.now()
  // Client would then receive the buffer — TTFB-as-seen-by-client is t1.
  // (We ignore network hop from server→client since we're measuring the
  // server-side buffering penalty, which is the regression.)
  return { ttfbMs: Math.round(t1 - t0), totalBytes: buf.length }
}

// ─── Strategy B: AFTER (tee + stream first byte) ─────────────────────────────
async function measureTeed() {
  const t0 = performance.now()
  const res = await callDeepgram()
  if (!res.ok || !res.body) {
    throw new Error(`Deepgram failed: ${res.status}`)
  }

  const [clientStream, cacheStream] = res.body.tee()

  // Drain the cache branch in the background (same as route.ts does).
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

  // Measure TTFB on the client branch: time until first chunk arrives.
  const clientReader = clientStream.getReader()
  const { value: firstChunk } = await clientReader.read()
  const t1 = performance.now()
  const ttfbMs = Math.round(t1 - t0)
  const firstChunkBytes = firstChunk ? firstChunk.length : 0

  // Continue draining the client branch to completion so we can report
  // the full payload size and confirm the cache branch finishes too.
  let totalClientBytes = firstChunkBytes
  while (true) {
    const { done, value } = await clientReader.read()
    if (done) break
    if (value) totalClientBytes += value.length
  }
  const t2 = performance.now()

  const cacheBuf = await cachePromise
  const cacheCompleteMs = Math.round(t2 - t0)

  return {
    ttfbMs,
    firstChunkBytes,
    totalClientBytes,
    cacheBytes: cacheBuf.length,
    totalMs: cacheCompleteMs,
  }
}

// ─── Run both strategies and print the comparison ────────────────────────────

async function main() {
  console.log('TTS TTFB measurement — validates Fix 1 in commit f6bc48a')
  console.log('Test text:', `"${TEST_TEXT.slice(0, 60)}…" (${TEST_TEXT.length} chars)`)
  console.log('Deepgram model:', TTS_MODEL)
  console.log('')

  console.log('Strategy A: BEFORE — await response.arrayBuffer() (regression from commit 133e44f)')
  const before = await measureBuffered()
  console.log(`  TTFB (client sees first byte): ${before.ttfbMs}ms`)
  console.log(`  Total bytes: ${before.totalBytes}`)
  console.log('')

  console.log('Strategy B: AFTER — response.body.tee() (Fix 1)')
  const after = await measureTeed()
  console.log(`  TTFB (client sees first byte): ${after.ttfbMs}ms`)
  console.log(`  First chunk size: ${after.firstChunkBytes} bytes`)
  console.log(`  Total client bytes: ${after.totalClientBytes}`)
  console.log(`  Cache branch bytes: ${after.cacheBytes}`)
  console.log(`  Total time to drain both branches: ${after.totalMs}ms`)
  console.log('')

  const delta = before.ttfbMs - after.ttfbMs
  const pct = Math.round((delta / before.ttfbMs) * 100)
  console.log(`  Improvement: ${delta}ms faster (${pct}% reduction in time-to-first-sound)`)
  console.log('')

  // Invariants from INTERVIEW_FLOW.md §7.3
  const TARGET_TTFB_MS = 600
  console.log(`Invariant §7.3: TTFB on /api/tts/stream ≤${TARGET_TTFB_MS}ms (cold cache)`)
  if (after.ttfbMs <= TARGET_TTFB_MS) {
    console.log(`  PASS — ${after.ttfbMs}ms ≤ ${TARGET_TTFB_MS}ms`)
  } else {
    console.log(`  FAIL — ${after.ttfbMs}ms > ${TARGET_TTFB_MS}ms`)
    process.exitCode = 1
  }

  // Sanity: both branches should produce the same total bytes
  if (before.totalBytes !== after.cacheBytes) {
    console.log(`  WARNING: buffered total (${before.totalBytes}) != teed cache total (${after.cacheBytes})`)
  }
  if (after.totalClientBytes !== after.cacheBytes) {
    console.log(`  WARNING: teed client total (${after.totalClientBytes}) != cache total (${after.cacheBytes})`)
  }
}

main().catch((err) => {
  console.error('measurement failed:', err)
  process.exit(1)
})
