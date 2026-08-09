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
      // the import line matches neither. STRICT on purpose: there is no
      // hand-rolled exemption. Multipart routes belong on composeApiRoute
      // too — omit `schema` and the middleware never reads the body
      // (jobs/[jobId]/intake is the precedent, Codex round on #612).
      const calls = (src.match(/composeApiRoute[<(]/g) ?? []).length
      const fences = (src.match(/requireActiveAccount:\s*true/g) ?? []).length
      expect(calls).toBeGreaterThan(0)
      expect(fences).toBe(calls)
    }
  )
})

/**
 * Payload-shape contracts that are easy to regress silently: a field added
 * to the shared application serializer reaches the pipeline BOARD too, and
 * a root-relative link on a public page follows whatever subdomain rewrite
 * the host applies.
 */
describe('serializer + routing contracts (Codex P2 on #615)', () => {
  const SERIALIZE = readFileSync(join(API_ROOT, '_lib/serialize.ts'), 'utf8')
  // API_ROOT is app/api/workspace → repo root is three levels up.
  const MIDDLEWARE = readFileSync(join(API_ROOT, '../../../middleware.ts'), 'utf8')

  it('applicantResume is opt-in, so the pipeline board never ships 50k-char résumés', () => {
    // serializeApplication feeds BOTH the detail endpoint and
    // serializePipelineEntry (hundreds of cards per job).
    expect(SERIALIZE).toContain('includeApplicantResume')
    const guarded = /\.\.\.\(opts\.includeApplicantResume[\s\S]{0,400}?applicantResume:/
    expect(
      guarded.test(SERIALIZE),
      'applicantResume must be emitted only under the includeApplicantResume flag',
    ).toBe(true)
    // The board path must not opt in. Slice from the DECLARATION, not the
    // first textual mention (which is a comment referencing it).
    const pipelineBlock = SERIALIZE.slice(
      SERIALIZE.indexOf('export function serializePipelineEntry'),
    )
    expect(pipelineBlock).not.toContain('includeApplicantResume')
  })

  it('global legal pages are excluded from subdomain rewriting', () => {
    // The public apply page links to /privacy; on hire.* an unexcluded
    // root-relative link is rewritten to /workspace/privacy, which 404s.
    const excluded = MIDDLEWARE.slice(
      MIDDLEWARE.indexOf('subdomainExcludedPaths = ['),
      MIDDLEWARE.indexOf(']', MIDDLEWARE.indexOf('subdomainExcludedPaths = [')),
    )
    for (const legal of ['/privacy', '/terms', '/contact']) {
      expect(excluded, `${legal} must not be subdomain-rewritten`).toContain(legal)
    }
  })
})
