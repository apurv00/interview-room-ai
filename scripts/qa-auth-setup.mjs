#!/usr/bin/env node
/**
 * Save Playwright storageState after manual prod login.
 *
 * Google OAuth blocks Playwright's bundled Chromium. This script uses
 * **installed Google Chrome** with a persistent profile.
 *
 * If Google still blocks sign-in, use the codegen fallback (documented below).
 *
 * Usage:
 *   npm run qa:auth:setup:prod
 *   node scripts/qa-auth-setup.mjs --prod
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { launchQaPersistentContext } from '../modules/qa/runner/browserLaunch.mjs'
import { defaultAuthPath } from '../modules/qa/orchestrator/runManifest.mjs'

const prod = process.argv.includes('--prod')
const urlIdx = process.argv.indexOf('--url')
const baseUrl = urlIdx >= 0 ? process.argv[urlIdx + 1] : prod ? 'https://www.interviewprep.guru' : 'http://localhost:3000'
const authPath = defaultAuthPath(prod)
const profileName = prod ? 'prod' : 'local'

mkdirSync(dirname(authPath), { recursive: true })

console.log('')
console.log('QA auth setup — uses Google Chrome (not bundled Chromium)')
console.log('Google OAuth is blocked in automation browsers.')
console.log('')
console.log(`1. Chrome opens → sign in at ${baseUrl}/signin`)
console.log('   Use Google OR GitHub — avoid "Continue with Google" in Chromium.')
console.log('2. After you land on a logged-in page, return here and press Enter.')
console.log('')
console.log('If Google shows "This browser or app may not be secure", use the fallback:')
console.log('')
console.log(`  npx playwright codegen --channel=chrome --save-storage=${authPath} ${baseUrl}/signin`)
console.log('')

const { context, profileDir } = await launchQaPersistentContext(profileName)
const page = context.pages()[0] ?? (await context.newPage())
await page.goto(`${baseUrl.replace(/\/$/, '')}/signin`, { waitUntil: 'domcontentloaded' })

await new Promise((resolve) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  rl.question('Press Enter after login succeeds… ', () => {
    rl.close()
    resolve()
  })
})

const sessionRes = await page.goto(`${baseUrl.replace(/\/$/, '')}/api/auth/session`)
const session = await sessionRes?.json().catch(() => ({}))
if (!session?.user) {
  console.error('')
  console.error('Session check failed — no user in /api/auth/session.')
  console.error('Use the codegen fallback above (real Chrome), then re-run preflight.')
  await context.close()
  process.exit(1)
}

await context.storageState({ path: authPath })
await context.close()

console.log('')
console.log(`Saved auth for ${session.user.email ?? session.user.name ?? 'user'}`)
console.log(`  storageState: ${authPath}`)
console.log(`  chrome profile: ${profileDir}`)
console.log('Matrix runs can use headless Chromium with this storageState.')
