/**
 * Completeness guard for the hire-guest allowlist.
 *
 * Default-deny is safe by construction but breaks the flow when the list is
 * INCOMPLETE — twice already (HEAD /api/health left the lobby's Join button
 * disabled; POST /api/analysis/start silently discarded the candidate's
 * multimodal analysis). Enumerating by hand does not scale, so this test
 * derives the engine's authenticated client call surface from source and
 * fails when an endpoint is neither allowed nor explicitly acknowledged as
 * out-of-scope. New engine endpoint → this test fails in CI, not in a
 * candidate's interview.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { evaluateGuestAccess } from '../guestScope'

const ROOT = process.cwd()

/** Client code the guest actually executes during an interview. */
const SCAN_TARGETS = [
  'modules/interview/hooks',
  'modules/interview/components',
  'modules/interview/audio',
  'modules/interview/services',
  'app/lobby',
  'app/interview',
]

/**
 * Endpoints the engine references but a GUEST never reaches, with why.
 * Anything here is deliberately denied; everything else must be allowed.
 */
const OUT_OF_SCOPE: Record<string, string> = {
  '/api/documents/upload': 'setup-form only — guests get a server-provisioned config',
  '/api/extract-company-context': 'setup-form JD paste',
  '/api/jd/generate': 'lobby JD auto-generation for self-serve configs only',
  '/api/onboarding': 'B2C profile capture',
  '/api/onboarding/extract': 'B2C profile capture',
  '/api/resume/interview-config': 'resume-to-interview (B2C)',
  '/api/interviews/last-config': 'self-serve config recall',
  '/api/interviews/last-same-domain-feedback': 'RESULTS — HR-only',
  '/api/interviews/my-session-id': 'self-serve session recall',
  '/api/learn/pathway': 'learn module (B2C)',
  '/api/categories': 'public catalog (no auth gate to bypass)',
  '/api/domains': 'public catalog',
  '/api/interview-types': 'public catalog',
  '/api/jobs': 'jobs module (B2C)',
  '/api/events': 'anonymous analytics capture',
}

function walk(dir: string): string[] {
  const abs = join(ROOT, dir)
  let entries: string[] = []
  try {
    entries = readdirSync(abs)
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    const full = join(abs, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue
      files.push(...walk(join(dir, entry)))
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.|\.spec\./.test(entry)) {
      files.push(full)
    }
  }
  return files
}

/** Endpoints referenced by fetch() in the scanned client code. */
function discoverEndpoints(): string[] {
  const found = new Set<string>()
  for (const dir of SCAN_TARGETS) {
    for (const file of walk(dir)) {
      const src = readFileSync(file, 'utf8')
      for (const match of src.matchAll(/fetch\(\s*[`'"](\/api\/[a-zA-Z0-9/_-]+)/g)) {
        // Normalize template-literal roots like `/api/interviews/${id}`.
        found.add(match[1].replace(/\/$/, ''))
      }
    }
  }
  return Array.from(found).sort()
}

describe('guest allowlist completeness (derived from engine source)', () => {
  const endpoints = discoverEndpoints()

  it('discovers the engine call surface', () => {
    expect(endpoints.length).toBeGreaterThan(15)
  })

  it.each(endpoints)('%s is allowed for guests or explicitly out of scope', (endpoint) => {
    if (endpoint in OUT_OF_SCOPE) {
      expect(OUT_OF_SCOPE[endpoint].length).toBeGreaterThan(0)
      return
    }
    // Allowed under at least one method the engine could use.
    const anyMethodAllowed = ['GET', 'HEAD', 'POST', 'PATCH', 'PUT'].some(
      (method) => evaluateGuestAccess(endpoint, method).allowed
    )
    expect(
      anyMethodAllowed,
      `${endpoint} is denied for hire guests and not listed in OUT_OF_SCOPE — a guest interview would break here. Add it to the allowlist (with its verbs) or document why guests never call it.`
    ).toBe(true)
  })
})
