/**
 * Internal link integrity check.
 *
 * Scans the source tree for hardcoded internal links of the form
 *
 *   href="/some/path"
 *   href={`/some/${dynamic}/path`}
 *
 * and validates that each *static* path resolves to a real route in the
 * Next.js App Router under `app/`. Dynamic segments (`/foo/[slug]`,
 * `/foo/[id]`) are matched against `[slug]`-style folders. Routes
 * defined via `redirects()` in `next.config.js` are also accepted.
 *
 * Run:
 *   npx tsx scripts/check-internal-links.ts
 *
 * Exit codes:
 *   0  no broken links
 *   1  one or more broken links
 *
 * The script intentionally errs on the side of false-negatives over
 * false-positives: anything we cannot statically resolve (template
 * strings with multiple variables, runtime-generated paths) is skipped
 * with a `[skip]` log line so authors can see why.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(__dirname, '..')
const APP_DIR = path.join(REPO_ROOT, 'app')

// Directories to scan for source links.
const SCAN_DIRS = ['app', 'modules', 'shared'].map((d) => path.join(REPO_ROOT, d))

// Allowlisted external prefixes / non-route paths we should never validate.
const IGNORE_PREFIXES = [
  'http://',
  'https://',
  '//',
  'mailto:',
  'tel:',
  '#',
  '/api/', // API routes are allowed but we don't validate them here
  '/_next/',
  '/static/',
]

// Static destinations that come from next.config.js redirects().
// Keep this in sync with `next.config.js`.
const REDIRECT_DESTINATIONS = new Set<string>([
  '/lobby', // /setup -> /lobby
])

// File extensions to scan.
const SCAN_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mdx'])

// File extensions Next treats as a route.
const PAGE_FILES = new Set([
  'page.tsx',
  'page.ts',
  'page.jsx',
  'page.js',
  'route.ts',
  'route.js',
])

// ─── Route discovery ──────────────────────────────────────────────────────────

interface RoutePattern {
  /** Original folder path under app/, e.g. `/learn/guides/[slug]` */
  pattern: string
  /** Regex matching real URLs against this pattern. */
  regex: RegExp
}

async function collectRoutes(dir: string, prefix = ''): Promise<RoutePattern[]> {
  const out: RoutePattern[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }

  // Does this directory itself contain a page.tsx / route.ts?
  const hasPage = entries.some((e) => e.isFile() && PAGE_FILES.has(e.name))
  if (hasPage) {
    const pattern = prefix === '' ? '/' : prefix
    out.push({ pattern, regex: patternToRegex(pattern) })
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const name = entry.name
    // Skip private folders, parallel routes, route groups handled below.
    if (name.startsWith('_')) continue

    let segment = name
    // Route groups: `(group)` — invisible in URL.
    if (segment.startsWith('(') && segment.endsWith(')')) segment = ''
    // Intercepted routes / parallel routes — treat as transparent.
    if (segment.startsWith('@')) continue
    if (segment.startsWith('.')) continue

    const child = path.join(dir, entry.name)
    const childPrefix = segment === '' ? prefix : `${prefix}/${segment}`
    out.push(...(await collectRoutes(child, childPrefix)))
  }
  return out
}

function patternToRegex(pattern: string): RegExp {
  // Convert App Router pattern to regex.
  // [slug]      -> [^/]+
  // [...slug]   -> .+
  // [[...slug]] -> .*
  let body = pattern
    .replace(/\[\[\.\.\.[^\]]+\]\]/g, '.*')
    .replace(/\[\.\.\.[^\]]+\]/g, '.+')
    .replace(/\[[^\]]+\]/g, '[^/]+')
  if (body === '/') body = '/'
  return new RegExp(`^${body}/?$`)
}

// ─── Link extraction ──────────────────────────────────────────────────────────

interface FoundLink {
  file: string
  line: number
  raw: string
  path: string
}

// Matches both JSX attributes (`href="/foo"`) and object literal properties
// (`href: '/foo'`) used in nav/step data arrays.
const HREF_RE = /(?:href|to)\s*[=:]\s*["'`]([^"'`]+)["'`]/g

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue
      yield* walk(full)
    } else if (entry.isFile() && SCAN_EXTS.has(path.extname(entry.name))) {
      yield full
    }
  }
}

async function extractLinks(file: string): Promise<FoundLink[]> {
  const content = await fs.readFile(file, 'utf8')
  const out: FoundLink[] = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let m: RegExpExecArray | null
    HREF_RE.lastIndex = 0
    while ((m = HREF_RE.exec(line)) !== null) {
      const raw = m[1]
      if (!raw.startsWith('/')) continue
      if (IGNORE_PREFIXES.some((p) => raw.startsWith(p))) continue
      out.push({
        file: path.relative(REPO_ROOT, file),
        line: i + 1,
        raw,
        path: raw.split('?')[0].split('#')[0],
      })
    }
  }
  return out
}

// ─── Validation ───────────────────────────────────────────────────────────────

function isStaticPath(p: string): boolean {
  // If the path contains template literal syntax we cannot statically resolve.
  return !p.includes('${')
}

function matchesAny(p: string, routes: RoutePattern[]): boolean {
  if (REDIRECT_DESTINATIONS.has(p)) return true
  return routes.some((r) => r.regex.test(p))
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const routes = await collectRoutes(APP_DIR)
  // eslint-disable-next-line no-console
  console.log(`Discovered ${routes.length} routes under app/`)

  const broken: FoundLink[] = []
  const skipped: FoundLink[] = []
  let total = 0

  for (const dir of SCAN_DIRS) {
    for await (const file of walk(dir)) {
      const links = await extractLinks(file)
      for (const link of links) {
        total++
        if (!isStaticPath(link.path)) {
          skipped.push(link)
          continue
        }
        if (!matchesAny(link.path, routes)) {
          broken.push(link)
        }
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `Scanned ${total} internal links — ${broken.length} broken, ${skipped.length} skipped (dynamic).`
  )

  if (broken.length > 0) {
    // eslint-disable-next-line no-console
    console.error('\nBroken internal links:')
    for (const b of broken) {
      // eslint-disable-next-line no-console
      console.error(`  ${b.file}:${b.line}  ${b.raw}`)
    }
    process.exit(1)
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(2)
})
