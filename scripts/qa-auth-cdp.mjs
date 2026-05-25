#!/usr/bin/env node
/**
 * Export auth from Chrome you already logged into (Google OAuth works there).
 *
 * Steps:
 *   1. Close ALL Chrome windows
 *   2. Start Chrome with debugging (PowerShell):
 *        & "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" `
 *          --remote-debugging-port=9222 `
 *          --user-data-dir="$env:LOCALAPPDATA\Google\Chrome\User Data"
 *   3. In that Chrome, open https://www.interviewprep.guru and sign in (Google OK)
 *   4. Run: npm run qa:auth:cdp:prod
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { chromium } from '@playwright/test'
import { defaultAuthPath } from '../modules/qa/orchestrator/runManifest.mjs'
import { validateStorageState } from '../modules/qa/runner/validateAuth.mjs'

const prod = process.argv.includes('--prod')
const portArg = process.argv.find((a) => a.startsWith('--port='))
const cdpPort = portArg ? portArg.split('=')[1] : '9222'
const baseUrl = prod ? 'https://www.interviewprep.guru' : 'http://localhost:3000'
const authPath = defaultAuthPath(prod)

console.log(`Connecting to Chrome CDP on port ${cdpPort}…`)

let browser
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`)
} catch (err) {
  console.error('')
  console.error('Could not connect to Chrome. Start Chrome with remote debugging first:')
  console.error('')
  console.error('  PowerShell (close all Chrome windows first):')
  console.error('')
  console.error('  & "$env:ProgramFiles\\Google\\Chrome\\Application\\chrome.exe" `')
  console.error('    --remote-debugging-port=9222 `')
  console.error('    --user-data-dir="$env:LOCALAPPDATA\\Google\\Chrome\\User Data"')
  console.error('')
  console.error(`Error: ${err.message}`)
  process.exit(1)
}

const contexts = browser.contexts()
if (!contexts.length) {
  console.error('No browser contexts found.')
  process.exit(1)
}

let saved = false
for (const context of contexts) {
  const cookies = await context.cookies(baseUrl)
  const hasSession = cookies.some((c) => c.name.includes('session-token'))
  if (!hasSession) continue

  mkdirSync(dirname(authPath), { recursive: true })
  await context.storageState({ path: authPath })
  saved = true
  break
}

if (!saved) {
  // Open signin in first context and let user know
  const context = contexts[0]
  const page = context.pages()[0] ?? (await context.newPage())
  console.log('')
  console.log(`No session on ${baseUrl} — opening signin in your Chrome…`)
  console.log('Log in with Google, then run this script again.')
  await page.goto(`${baseUrl}/signin`)
  process.exit(1)
}

const check = validateStorageState(authPath)
if (!check.ok) {
  console.error(`Export failed validation: ${check.message}`)
  process.exit(1)
}

console.log('')
console.log(`Saved valid session → ${authPath}`)
console.log(`Cookie: ${check.cookieName}`)
console.log('Run: npm run qa:preflight:prod')

await browser.close()
