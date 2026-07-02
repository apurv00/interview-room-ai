/**
 * Partial-tolerant handling of the resume-parse LLM output.
 *
 * The old chain was all-or-nothing: truncated/malformed JSON → null → generic
 * 500, and the client discarded even a perfect parse when contactInfo was
 * missing. These helpers make every layer degrade instead of abort:
 *
 * - `salvageTruncatedJson` repairs output that was cut mid-structure (the
 *   dominant failure: dense resumes exceeding the completion budget) by
 *   trimming to the last complete value and closing the open brackets.
 * - `normalizeParsedResume` coerces whatever survived into shapes the editor
 *   can safely load (ids always present, bullets always arrays, junk entries
 *   dropped per-item — never the whole section), and reports which sections
 *   were imported vs dropped so the UI can say "imported X of Y".
 */

// ─── Truncated-JSON salvage ──────────────────────────────────────────────────

/**
 * Best-effort parse of possibly-truncated JSON. Walks the text tracking
 * string/escape state and a bracket stack, collecting CUT CANDIDATES:
 * offsets where a complete VALUE just ended (a closing quote of a value
 * string — not a key, detected by ':' lookahead — or a closing brace/
 * bracket), plus the offsets of each opening brace/bracket (a prefix ending
 * right after an opener is completable to an empty container). Candidates
 * are tried newest-first: slice there, append the closers for the brackets
 * still open at that point, parse. The first parse that succeeds wins — so
 * a cut mid-string, mid-key, or mid-entry falls back to the last complete
 * element instead of losing everything. Returns null only for structurally
 * broken input (mismatched brackets) or when no prefix parses.
 */
export function salvageTruncatedJson(text: string): unknown | null {
  const src = text.trim()
  if (!src) return null
  try {
    return JSON.parse(src)
  } catch { /* fall through to salvage */ }

  interface Candidate { cut: number; stack: string[] }
  const valueEnds: Candidate[] = []
  const openers: Candidate[] = []
  const stack: string[] = []
  let inString = false
  let escaped = false

  const isKeyString = (closeIdx: number): boolean => {
    for (let j = closeIdx + 1; j < src.length; j++) {
      const c = src[j]
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue
      return c === ':'
    }
    return false // string closed at EOF — treat as a value
  }

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inString) {
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === '"') {
        inString = false
        if (!isKeyString(i)) valueEnds.push({ cut: i, stack: [...stack] })
      }
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') { stack.push('}'); openers.push({ cut: i, stack: [...stack] }); continue }
    if (ch === '[') { stack.push(']'); openers.push({ cut: i, stack: [...stack] }); continue }
    if (ch === '}' || ch === ']') {
      if (stack[stack.length - 1] !== ch) return null // structurally broken, not just truncated
      stack.pop()
      valueEnds.push({ cut: i, stack: [...stack] })
    }
  }

  const tryCandidates = (candidates: Candidate[], cap: number): unknown | null => {
    for (let k = candidates.length - 1, tried = 0; k >= 0 && tried < cap; k--, tried++) {
      const { cut, stack: open } = candidates[k]
      const closers = [...open].reverse().join('')
      try {
        return JSON.parse(src.slice(0, cut + 1) + closers)
      } catch { /* try an earlier candidate */ }
    }
    return null
  }

  // Prefer the newest complete value; fall back to empty-container prefixes.
  return tryCandidates(valueEnds, 40) ?? tryCandidates(openers, 10)
}

// ─── Lenient normalization ───────────────────────────────────────────────────

export interface NormalizedParseResult {
  resume: Record<string, unknown>
  /** Sections that yielded usable content, in canonical order. */
  importedSections: string[]
  /** Sections present in the raw output that yielded nothing usable. */
  droppedSections: string[]
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(str).filter(Boolean) : []

function normalizeContactInfo(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const key of ['fullName', 'email', 'phone', 'location', 'linkedin', 'website', 'github']) {
    const v = str(r[key])
    if (v) out[key] = v
  }
  return Object.keys(out).length > 0 ? out : null
}

function normalizeExperience(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return []
  const out: Array<Record<string, unknown>> = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const company = str(e.company)
    const title = str(e.title)
    if (!company && !title) continue
    out.push({
      id: str(e.id) || `exp-${out.length + 1}`,
      company,
      title,
      location: str(e.location),
      startDate: str(e.startDate),
      endDate: str(e.endDate),
      bullets: strArr(e.bullets),
    })
  }
  return out
}

function normalizeEducation(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return []
  const out: Array<Record<string, unknown>> = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const institution = str(e.institution)
    const degree = str(e.degree)
    if (!institution && !degree) continue
    out.push({
      id: str(e.id) || `edu-${out.length + 1}`,
      institution,
      degree,
      field: str(e.field),
      graduationDate: str(e.graduationDate),
      gpa: str(e.gpa),
      honors: str(e.honors),
    })
  }
  return out
}

function normalizeSkills(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return []
  const out: Array<Record<string, unknown>> = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const items = strArr(e.items)
    if (items.length === 0) continue
    out.push({ category: str(e.category) || 'Skills', items })
  }
  return out
}

function normalizeProjects(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return []
  const out: Array<Record<string, unknown>> = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const name = str(e.name)
    if (!name) continue
    out.push({
      id: str(e.id) || `proj-${out.length + 1}`,
      name,
      description: str(e.description),
      technologies: strArr(e.technologies),
      url: str(e.url),
    })
  }
  return out
}

function normalizeCertifications(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return []
  const out: Array<Record<string, unknown>> = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const name = str(e.name)
    if (!name) continue
    out.push({ name, issuer: str(e.issuer), date: str(e.date) })
  }
  return out
}

const SECTION_LABELS: Array<[key: string, label: string]> = [
  ['contactInfo', 'contact info'],
  ['summary', 'summary'],
  ['experience', 'experience'],
  ['education', 'education'],
  ['skills', 'skills'],
  ['projects', 'projects'],
  ['certifications', 'certifications'],
]

/**
 * Coerce raw LLM parse output into editor-safe partial resume data. Junk is
 * dropped per-ITEM, never per-section; a section with zero usable items is
 * reported in droppedSections (only when the raw output actually attempted
 * it) so the UI can tell the user what needs manual entry.
 */
export function normalizeParsedResume(raw: unknown): NormalizedParseResult {
  const empty: NormalizedParseResult = { resume: {}, importedSections: [], droppedSections: [] }
  if (!raw || typeof raw !== 'object') return empty
  const r = raw as Record<string, unknown>

  const normalized: Record<string, unknown> = {}
  const contactInfo = normalizeContactInfo(r.contactInfo)
  if (contactInfo) normalized.contactInfo = contactInfo
  const summary = str(r.summary)
  if (summary) normalized.summary = summary
  const experience = normalizeExperience(r.experience)
  if (experience.length) normalized.experience = experience
  const education = normalizeEducation(r.education)
  if (education.length) normalized.education = education
  const skills = normalizeSkills(r.skills)
  if (skills.length) normalized.skills = skills
  const projects = normalizeProjects(r.projects)
  if (projects.length) normalized.projects = projects
  const certifications = normalizeCertifications(r.certifications)
  if (certifications.length) normalized.certifications = certifications

  const importedSections: string[] = []
  const droppedSections: string[] = []
  for (const [key, label] of SECTION_LABELS) {
    if (key in normalized) {
      importedSections.push(label)
    } else if (r[key] !== undefined && r[key] !== null
      && !(Array.isArray(r[key]) && (r[key] as unknown[]).length === 0)
      && r[key] !== '') {
      // The model attempted the section but nothing survived normalization.
      droppedSections.push(label)
    }
  }

  return { resume: normalized, importedSections, droppedSections }
}

/**
 * Prefill payload for uploading a resume INTO the editor. Upload semantics
 * are REPLACE, not merge: the parse result is intentionally partial and
 * `loadResume` shallow-merges into existing state — without explicit empties,
 * uploading over a non-empty draft would keep stale sections (old contact
 * info under the new experience) that save/export silently. Every
 * parse-managed section gets an explicit empty default; editor-only fields
 * (name, template, styling, customSections — which a parse can never
 * populate) are deliberately absent so they survive the merge.
 */
export function buildUploadPrefill(parsedResume: Record<string, unknown>): Record<string, unknown> {
  return {
    contactInfo: { fullName: '', email: '' },
    summary: '',
    experience: [],
    education: [],
    skills: [],
    projects: [],
    certifications: [],
    ...parsedResume,
  }
}
