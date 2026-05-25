#!/usr/bin/env node
import { defaultAuthPath } from '../modules/qa/orchestrator/runManifest.mjs'
import { validateStorageState } from '../modules/qa/runner/validateAuth.mjs'
import { verifyAuthSession } from '../modules/qa/runner/playwrightMatrix.mjs'
import { ensureQaAuth } from '../modules/qa/runner/automationAuth.mjs'
import { loadQaEnv, qaAutomationConfig } from '../modules/qa/runner/loadEnv.mjs'

loadQaEnv()

const prod = process.argv.includes('--prod')
const authPath = defaultAuthPath(prod)
const baseUrl = prod ? 'https://www.interviewprep.guru' : 'http://localhost:3000'
const { secret, email } = qaAutomationConfig()

console.log('Auth path:', authPath)

if (secret && email) {
  console.log('Mode: automation login (QA_AUTOMATION_* configured)')
  try {
    await ensureQaAuth({
      baseUrl,
      authPath,
      verifyAuthSession,
      log: console.log,
    })
    const live = await verifyAuthSession(authPath, baseUrl)
    console.log('Live session:', live.ok ? `OK (${live.user?.email})` : 'FAILED')
    process.exit(live.ok ? 0 : 1)
  } catch (err) {
    console.error(String(err.message || err))
    process.exit(1)
  }
}

const fileCheck = validateStorageState(authPath)
console.log('Mode: cached storageState')
console.log('File validation:', fileCheck.ok ? 'OK' : fileCheck.message)

if (!fileCheck.ok) {
  console.log('')
  console.log('Configure automation (recommended):')
  console.log('  QA_AUTOMATION_ENABLED=true')
  console.log('  QA_AUTOMATION_SECRET=<openssl rand -hex 32>')
  console.log('  QA_AUTOMATION_EMAIL=<qa-user@...>')
  console.log('  npm run qa:auth:automation:prod')
  console.log('')
  console.log('Or manual fallback: npm run qa:auth:import:prod')
  process.exit(1)
}

const live = await verifyAuthSession(authPath, baseUrl)
console.log('Live session:', live.ok ? `OK (${live.user?.email})` : 'FAILED — no user')
process.exit(live.ok ? 0 : 1)
