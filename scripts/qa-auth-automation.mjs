#!/usr/bin/env node
/**
 * Mint QA session via POST /api/qa/automation-login (no OAuth, no cookie paste).
 *
 * Usage:
 *   npm run qa:auth:automation:prod
 */
import { defaultAuthPath } from '../modules/qa/orchestrator/runManifest.mjs'
import { loginViaAutomationApi } from '../modules/qa/runner/automationAuth.mjs'
import { verifyAuthSession } from '../modules/qa/runner/playwrightMatrix.mjs'
import { loadQaEnv } from '../modules/qa/runner/loadEnv.mjs'

loadQaEnv()

const prod = process.argv.includes('--prod')
const authPath = defaultAuthPath(prod)
const baseUrl = prod ? 'https://www.interviewprep.guru' : 'http://localhost:3000'

try {
  await loginViaAutomationApi({ baseUrl, authPath })
  const live = await verifyAuthSession(authPath, baseUrl)
  if (!live.ok) {
    console.error('Automation login wrote auth file but live session check failed')
    process.exit(1)
  }
  console.log(`Live session OK: ${live.user?.email}`)
} catch (err) {
  console.error(String(err.message || err))
  process.exit(1)
}
