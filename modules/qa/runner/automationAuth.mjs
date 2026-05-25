import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { request as playwrightRequest } from '@playwright/test'
import { qaAutomationConfig } from './loadEnv.mjs'
import { buildStorageStateFromSessionToken, validateStorageState } from './validateAuth.mjs'

function cookieDomainForBaseUrl(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname
    if (host === 'localhost' || host === '127.0.0.1') return host
    if (host.endsWith('interviewprep.guru')) return '.interviewprep.guru'
    return host
  } catch {
    return 'www.interviewprep.guru'
  }
}

/**
 * Mint a NextAuth session via POST /api/qa/automation-login (no OAuth).
 * Saves Playwright storageState to authPath for reuse until expiry.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} opts.authPath
 * @param {(msg: string) => void} [opts.log]
 */
export async function loginViaAutomationApi(opts) {
  const { baseUrl, authPath, log = console.log } = opts
  const { secret, email } = qaAutomationConfig()

  if (!secret || !email) {
    throw new Error(
      'QA_AUTOMATION_SECRET and QA_AUTOMATION_EMAIL must be set in .env.local (and on Vercel for prod runs)',
    )
  }

  if (secret.includes('openssl rand') || secret.length < 16) {
    throw new Error(
      'QA_AUTOMATION_SECRET looks like a placeholder — run: openssl rand -hex 32\n' +
        'Set the same value in .env.local and Vercel production.',
    )
  }

  log(`Automation login as ${email} …`)

  const ctx = await playwrightRequest.newContext({ baseURL: baseUrl.replace(/\/$/, '') })
  const res = await ctx.post('/api/qa/automation-login', {
    headers: {
      'x-qa-automation-secret': secret,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    data: { email },
  })

  const contentType = res.headers()['content-type'] ?? ''
  const text = await res.text()

  if (!res.ok()) {
    let hint = text.slice(0, 300)
    if (res.status() === 403 && text.includes('disabled')) {
      hint += ' — set QA_AUTOMATION_ENABLED=true on Vercel production'
    }
    if (res.status() === 401) {
      hint += ' — QA_AUTOMATION_SECRET must match Vercel exactly'
    }
    throw new Error(`automation-login HTTP ${res.status()}: ${hint}`)
  }

  if (!contentType.includes('application/json')) {
    const isSignInPage = text.includes('Sign In') || text.includes('/signin')
    throw new Error(
      isSignInPage
        ? 'automation-login returned sign-in HTML — route not deployed yet.\n' +
            'Deploy app/api/qa/automation-login + middleware change to production, then retry.'
        : `automation-login expected JSON, got ${contentType || 'unknown'} (${text.slice(0, 120)}…)`,
    )
  }

  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`automation-login returned invalid JSON: ${text.slice(0, 200)}`)
  }

  if (!body?.ok || !body?.sessionToken) {
    throw new Error(
      `automation-login JSON missing sessionToken — deploy latest automation-login route.\n` +
        `Response: ${text.slice(0, 200)}`,
    )
  }

  await ctx.dispose()

  const domain = cookieDomainForBaseUrl(baseUrl)
  const state = buildStorageStateFromSessionToken(body.sessionToken, domain)
  if (body.cookieName && body.cookieName !== state.cookies[0].name) {
    state.cookies[0].name = body.cookieName
  }

  mkdirSync(dirname(authPath), { recursive: true })
  writeFileSync(authPath, JSON.stringify(state, null, 2), 'utf-8')

  const check = validateStorageState(state)
  if (!check.ok) {
    throw new Error(`Automation login succeeded but storageState invalid: ${check.message}`)
  }

  log(`Session saved → ${authPath} (valid ~7 days)`)
  return authPath
}

/**
 * Use cached storageState if valid; otherwise automation-login.
 */
export async function ensureQaAuth({ baseUrl, authPath, verifyAuthSession, log = console.log }) {
  const { secret, email } = qaAutomationConfig()

  if (secret && email) {
    const { existsSync } = await import('node:fs')
    if (existsSync(authPath)) {
      const live = await verifyAuthSession(authPath, baseUrl)
      if (live.ok) {
        log(`Reusing cached session (${live.user?.email ?? 'user'})`)
        return authPath
      }
      log('Cached session expired or invalid — refreshing via automation login …')
    } else {
      log('No auth cache — automation login …')
    }
    return loginViaAutomationApi({ baseUrl, authPath, log })
  }

  const check = validateStorageState(authPath)
  if (!check.ok) {
    throw new Error(
      `${check.message}\n\n` +
        'Scalable fix: set QA_AUTOMATION_SECRET + QA_AUTOMATION_EMAIL + QA_AUTOMATION_ENABLED=true\n' +
        'on Vercel and in .env.local — matrix will auto-login every run.',
    )
  }

  const live = await verifyAuthSession(authPath, baseUrl)
  if (!live.ok) {
    throw new Error('Auth file present but session invalid — configure QA automation env vars or re-import cookie')
  }
  return authPath
}
