import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const JOBS_API_ROOT = path.join(process.cwd(), 'app/api/jobs')

const EXPECTED_POST_ROUTES = [
  '[id]/apply-click/route.ts',
  '[id]/ats-check/route.ts',
  '[id]/broken-link/route.ts',
  '[id]/interview-date/route.ts',
  '[id]/nudge-dismiss/route.ts',
  '[id]/open/route.ts',
  '[id]/practice-link-email/route.ts',
  '[id]/save/route.ts',
  '[id]/status/route.ts',
  '[id]/tailored/route.ts',
  'admin/source-control/route.ts',
  'admin/sync/route.ts',
  'base-resume/route.ts',
  'email-action/route.ts',
  'parse-pdf/route.ts',
] as const

const EXISTING_LIMIT_EXEMPTIONS = new Map<string, RegExp>([
  ['parse-pdf/route.ts', /\bawait\s+checkRateLimit\s*\(/],
])

function collectRouteFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return collectRouteFiles(entryPath)
    return entry.name === 'route.ts' ? [entryPath] : []
  })
}

function routeSource(relativePath: string) {
  return readFileSync(path.join(JOBS_API_ROOT, relativePath), 'utf8')
}

describe('Jobs API mutation rate-limit coverage contract', () => {
  it('forces every newly added POST route through an explicit policy review', () => {
    const discovered = collectRouteFiles(JOBS_API_ROOT)
      .filter((file) => /\bexport\s+(?:async\s+function|const)\s+POST\b/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(JOBS_API_ROOT, file))
      .sort()

    expect(discovered).toEqual([...EXPECTED_POST_ROUTES].sort())
  })

  it.each(EXPECTED_POST_ROUTES)('%s has an awaited rate-limit guard', (route) => {
    const source = routeSource(route)
    const acceptedGuard = EXISTING_LIMIT_EXEMPTIONS.get(route)
      ?? /\bawait\s+checkJobsRateLimit\s*\(/

    expect(source).toMatch(acceptedGuard)
  })

  it('covers X-ray even though its GET performs cached/provider work', () => {
    expect(routeSource('[id]/xray/route.ts')).toMatch(
      /\bawait\s+checkJobsRateLimit\s*\([^\n]+['"]xray['"]\s*\)/,
    )
  })
})
