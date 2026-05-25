import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** Load vars from .env.local for QA CLI scripts. */
export function loadDotEnvLocal(keys = null) {
  const envPath = join(root, '.env.local')
  if (!existsSync(envPath)) return
  const allow =
    keys ??
    new Set([
      'QA_',
      'NEXTAUTH_SECRET',
      'MONGODB_URI',
      'MONGODB_URI_PROD',
      'INNGEST_EVENT_KEY',
      'INNGEST_SIGNING_KEY',
    ])
  const text = readFileSync(envPath, 'utf-8')
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const allowed =
      typeof allow === 'function'
        ? allow(key)
        : [...allow].some((p) => (p.endsWith('_') ? key.startsWith(p) : key === p))
    if (!allowed) continue
    if (process.env[key]) continue
    let val = trimmed.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    process.env[key] = val
  }
}

/** @deprecated use loadDotEnvLocal */
export function loadQaEnv() {
  loadDotEnvLocal(['QA_', 'NEXTAUTH_SECRET'])
}

export function qaAutomationConfig() {
  loadQaEnv()
  return {
    secret: process.env.QA_AUTOMATION_SECRET ?? '',
    email: process.env.QA_AUTOMATION_EMAIL ?? '',
    enabled: process.env.QA_AUTOMATION_ENABLED === 'true',
  }
}
