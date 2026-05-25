import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** Load QA_* and NEXTAUTH vars from .env.local for CLI scripts. */
export function loadQaEnv() {
  const envPath = join(root, '.env.local')
  if (!existsSync(envPath)) return
  const text = readFileSync(envPath, 'utf-8')
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    if (!key.startsWith('QA_') && key !== 'NEXTAUTH_SECRET') continue
    if (process.env[key]) continue
    let val = trimmed.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    process.env[key] = val
  }
}

export function qaAutomationConfig() {
  loadQaEnv()
  return {
    secret: process.env.QA_AUTOMATION_SECRET ?? '',
    email: process.env.QA_AUTOMATION_EMAIL ?? '',
    enabled: process.env.QA_AUTOMATION_ENABLED === 'true',
  }
}
