/**
 * Contract test: EVERY member-facing workspace route must carry the
 * account-lifecycle egress fence (requireActiveAccount) — a deleted or
 * deleting account holding a still-valid 7-day JWT must not be able to read
 * or mutate hiring data (Codex P1 on #604). Source-level assertion so a new
 * route added without the fence fails here, not in production.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const API_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function routeFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue
      out.push(...routeFiles(full))
    } else if (entry === 'route.ts') {
      out.push(full)
    }
  }
  return out
}

describe('workspace API fence contract', () => {
  const files = routeFiles(API_ROOT)

  it('finds the workspace route surface', () => {
    expect(files.length).toBeGreaterThanOrEqual(11)
  })

  it.each(files.map((f) => [f.slice(API_ROOT.length + 1), f]))(
    '%s: every composeApiRoute handler carries requireActiveAccount',
    (_label, file) => {
      const src = readFileSync(file as string, 'utf8')
      // Call sites only — `composeApiRoute<T>({` or `composeApiRoute({` —
      // the import line matches neither.
      const calls = (src.match(/composeApiRoute[<(]/g) ?? []).length
      const fences = (src.match(/requireActiveAccount:\s*true/g) ?? []).length
      if (calls === 0) {
        // Hand-rolled handlers (multipart bodies — composeApiRoute parses
        // JSON only) must carry the manual fence instead, and use it: at
        // least one isJobsAccountActive call site (jobs/[jobId]/intake is
        // the precedent). The intent is identical — a deleted account's
        // still-valid JWT reads/mutates nothing here.
        expect(
          (src.match(/isJobsAccountActive\(/g) ?? []).length,
          `${file} uses neither composeApiRoute+requireActiveAccount nor the manual isJobsAccountActive fence`
        ).toBeGreaterThan(0)
        return
      }
      expect(fences).toBe(calls)
    }
  )
})
