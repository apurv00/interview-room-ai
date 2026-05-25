#!/usr/bin/env node
/**
 * Import session cookie copied from your normal browser (DevTools).
 *
 * 1. Log in at https://www.interviewprep.guru in regular Chrome/Edge
 * 2. DevTools → Application → Cookies → www.interviewprep.guru
 * 3. Copy VALUE of __Secure-next-auth.session-token
 * 4. Run:
 *      npm run qa:auth:import:prod -- --token "PASTE_HERE"
 *    Or set QA_SESSION_TOKEN env var
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { chromium } from '@playwright/test'
import { defaultAuthPath } from '../modules/qa/orchestrator/runManifest.mjs'
import {
  buildStorageStateFromSessionToken,
  validateStorageState,
} from '../modules/qa/runner/validateAuth.mjs'

const prod = process.argv.includes('--prod')
const tokenIdx = process.argv.indexOf('--token')
const baseUrl = prod ? 'https://www.interviewprep.guru' : 'http://localhost:3000'
const authPath = defaultAuthPath(prod)

let token = tokenIdx >= 0 ? process.argv[tokenIdx + 1] : process.env.QA_SESSION_TOKEN

if (!token) {
  console.log('Paste __Secure-next-auth.session-token value (from DevTools → Application → Cookies):')
  token = await new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question('> ', (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

if (!token || token.length < 20) {
  console.error('Token too short or missing.')
  process.exit(1)
}

const state = buildStorageStateFromSessionToken(token)
mkdirSync(dirname(authPath), { recursive: true })
writeFileSync(authPath, JSON.stringify(state, null, 2), 'utf-8')

const check = validateStorageState(state)
if (!check.ok) {
  console.error(check.message)
  process.exit(1)
}

// Live verify against prod
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ storageState: authPath })
const page = await context.newPage()
const res = await page.goto(`${baseUrl}/api/auth/session`, { timeout: 30_000 })
const session = await res?.json().catch(() => ({}))
await browser.close()

if (!session?.user) {
  console.error('')
  console.error('Cookie saved but /api/auth/session returned no user.')
  console.error('Token may be expired or copied incorrectly — log in again and re-copy.')
  process.exit(1)
}

console.log('')
console.log(`Auth OK for ${session.user.email ?? session.user.name}`)
console.log(`Saved → ${authPath}`)
console.log('Run: npm run qa:v3:smoke:prod')
