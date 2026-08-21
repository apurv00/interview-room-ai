/**
 * Contract test: every member-facing workspace route uses the Hire-aware
 * principal boundary. It re-resolves Hire member sessions without touching
 * User and retains the B2C deletion fence for legacy principals.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const API_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const COMPOSE_HIRE = readFileSync(join(API_ROOT, '_lib/composeHireApiRoute.ts'), 'utf8')

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
    '%s: uses the Hire principal boundary',
    (label, file) => {
      const src = readFileSync(file as string, 'utf8')
      expect(src).not.toContain('@shared/middleware/composeApiRoute')
      expect(src).not.toMatch(/\bcomposeApiRoute[<(]/)
      expect(src).not.toContain('requireActiveAccount')

      // Call sites only — import lines do not match this expression.
      expect((src.match(/composeHireApiRoute[<(]/g) ?? []).length).toBeGreaterThan(0)
    }
  )

  it.each(files.map((f) => [f.slice(API_ROOT.length + 1), f]))(
    '%s: exposes no mutation outside the central boundary',
    (label, file) => {
      const src = readFileSync(file as string, 'utf8')
      const unsafeDeclarations =
        src.match(/export const (?:POST|PUT|PATCH|DELETE)\s*=/g) ?? []
      const composedUnsafeDeclarations =
        src.match(
          /export const (?:POST|PUT|PATCH|DELETE)\s*=\s*composeHireApiRoute(?:<[^>]+>)?\s*\(/g,
        ) ?? []
      expect(
        composedUnsafeDeclarations.length,
        `${label as string} must wrap every unsafe method`,
      ).toBe(unsafeDeclarations.length)
      expect(src).not.toMatch(
        /export async function (?:POST|PUT|PATCH|DELETE)\s*\(/,
      )
    },
  )

  it('rechecks the correct identity system on success, exception, and long requests', () => {
    expect(COMPOSE_HIRE).toContain("kind: 'hire_member'")
    expect(COMPOSE_HIRE).toContain('resolveHireMemberSession(principal.rawHireToken)')
    expect(COMPOSE_HIRE).toContain('isPrincipalActive: () => principalStillActive(principal, req)')
    expect(COMPOSE_HIRE).toContain('catch (handlerError)')
    expect((COMPOSE_HIRE.match(/principalStillActive\(principal, req\)/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })

  it('enforces the central trusted-Origin gate before resolving any principal', () => {
    const originFence = COMPOSE_HIRE.indexOf('hasTrustedOriginForMutation(req)')
    const principalResolution = COMPOSE_HIRE.indexOf('await resolvePrincipal(req)')
    expect(originFence).toBeGreaterThan(0)
    expect(principalResolution).toBeGreaterThan(originFence)
    expect(COMPOSE_HIRE).toContain("{ error: 'Invalid request origin' }")
  })

  it('permits only the exact workspace GET/POST bootstrap without weakening removal races', () => {
    expect(COMPOSE_HIRE).toContain("req.nextUrl.pathname === '/api/workspace'")
    expect(COMPOSE_HIRE).toContain("req.method === 'GET' || req.method === 'POST'")
    expect(COMPOSE_HIRE).toContain('workspaceIdAtEntry')
  })
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

  it('applicant submissions are opt-in, so the pipeline board never ships 50k-char résumés', () => {
    // serializeApplication feeds BOTH the detail endpoint and
    // serializePipelineEntry (hundreds of cards per job).
    expect(SERIALIZE).toContain('includeApplicantResume')
    const guarded = /\.\.\.\(opts\.includeApplicantResume[\s\S]{0,400}?applicantSubmissions:/
    expect(
      guarded.test(SERIALIZE),
      'applicantSubmissions must be emitted only under the includeApplicantResume flag',
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


/**
 * A match is only "stale" relative to the document it was computed FROM.
 * Applications carrying their own quarantined résumé must be validated
 * against that, not the workspace pool copy (Codex P2 on #615).
 */
describe('staleness is measured against the scored document', () => {
  const SERIALIZE = readFileSync(join(API_ROOT, '_lib/serialize.ts'), 'utf8')

  it('resolves the scored document by HASH IDENTITY, never by position', () => {
    // Position-based anchoring ("newest submission produced the score") let
    // an anonymous caller force a false outdated warning by appending, and
    // broke whenever the headline came from the pool copy instead.
    expect(SERIALIZE).toContain('const headlineHash = a.resumeMatch?.resumeHash')
    expect(SERIALIZE).toContain('submissionHashes.includes(headlineHash)')
    expect(SERIALIZE).toContain('stale: haveSources ? !headlineSourceExists')
    expect(SERIALIZE).not.toContain('a.applicantSubmissions?.[0]')
  })

  it('derives staleness only with FULL source context, never from a partial set', () => {
    // Submissions alone are not context: a caller omitting the candidate
    // hash would compare a pool-derived headline against submissions only
    // and report a valid score as stale (Codex P2 on #616). Key PRESENCE
    // is the signal — null legitimately means "no pool résumé".
    expect(SERIALIZE).toContain("const haveSources = 'candidateResumeHash' in opts")
    expect(SERIALIZE).not.toContain('submissionHashes.length > 0')
  })
})
