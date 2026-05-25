#!/usr/bin/env node
/**
 * Poll Cursor browser tab title until QA matrix completes.
 * Pair with browser MCP: navigate bootstrap URL, then run this script.
 *
 * Usage: node scripts/poll-qa-browser.mjs [--interval 60] [--timeout 7200]
 */
const args = process.argv.slice(2)
const intervalIdx = args.indexOf('--interval')
const timeoutIdx = args.indexOf('--timeout')
const intervalSec = intervalIdx >= 0 ? parseInt(args[intervalIdx + 1], 10) : 60
const timeoutSec = timeoutIdx >= 0 ? parseInt(args[timeoutIdx + 1], 10) : 7200

const doneTitles = new Set(['QA_MATRIX_DONE', 'QA_MATRIX_ERROR', 'QA_LOAD_FAILED'])
const start = Date.now()

console.log(`Polling every ${intervalSec}s (timeout ${timeoutSec}s). Check browser title via MCP.`)

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// This script documents the poll loop; actual title checks happen via browser MCP in the agent session.
let elapsed = 0
while (elapsed < timeoutSec) {
  await sleep(intervalSec * 1000)
  elapsed += intervalSec
  console.log(`[${new Date().toISOString()}] elapsed=${elapsed}s — expect title QA_MATRIX_RUNNING until done`)
}

console.log('Timeout reached. If title is QA_MATRIX_DONE, extract report via console or localStorage.')
