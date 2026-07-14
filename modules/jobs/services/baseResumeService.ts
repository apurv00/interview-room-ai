import { listResumes, getResume, saveResume, ResumeSchema } from '@resume'

/**
 * Base-resume auto-save + import door (PRODUCT_FLOW §1 Stage 2, Wave 3.2b).
 * Signed-in confirm auto-saves the parsed upload as "Base Resume — {role}"
 * (preserveFullText — the upload's original text is authoritative; a partial
 * parse must not silently drop what the parser couldn't model).
 *
 * Re-upload dedup: an existing base resume for the SAME target role is
 * UPDATED, not duplicated — repeat onboarding never eats the 3-slot cap.
 * At the cap: no save, no block — extraction still feeds ranking; the
 * caller renders a dismissible notice (spec: never gate the feed on it).
 */

const BASE_PREFIX = 'Base Resume — '

export type BaseSaveResult =
  | { saved: true; id: string; updated: boolean }
  | { saved: false; reason: 'cap' | 'error' | 'invalid' }

export async function saveBaseResume(
  userId: string,
  structured: Record<string, unknown>,
  targetRole: string,
  fullText?: string
): Promise<BaseSaveResult> {
  const name = `${BASE_PREFIX}${targetRole || 'General'}`.slice(0, 120)
  const listing = await listResumes(userId)
  const rows = (listing?.resumes ?? []) as unknown as Array<{ id: string; name: string; targetRole?: string; updatedAt?: string }>
  const existing = rows.find((r) => r.name === name)
  // The SAME contract /api/resume/save enforces (Codex on #520): a direct
  // POST must not persist arbitrary shapes/lengths into savedResumes —
  // ResumeSchema clamps every string/array (fullText to its legal 100k;
  // no jobs-side truncation below that).
  const candidate = ResumeSchema.safeParse({ ...structured, id: existing?.id, name, targetRole, fullText })
  if (!candidate.success) return { saved: false, reason: 'invalid' }
  const result = await saveResume(userId, candidate.data as never, { preserveFullText: true })
  if ('error' in result && result.error) {
    return { saved: false, reason: result.code === 'RESUME_LIMIT' ? 'cap' : 'error' }
  }
  return { saved: true, id: String((result as { id: string }).id), updated: !!existing }
}

export interface BaseResumeSummary {
  id: string
  name: string
  targetRole: string
  skills: string[]
}

/** The import door: the user's most recently updated saved resume, with a
 *  flat skill list for the confirm bar. */
export async function getBaseResume(userId: string): Promise<BaseResumeSummary | null> {
  const listing = await listResumes(userId)
  const resumes = (listing?.resumes ?? []) as unknown as Array<{ id: string; name: string; targetRole?: string; updatedAt?: string }>
  if (!resumes.length) return null
  const latest = [...resumes].sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))[0]
  const full = await getResume(userId, latest.id)
  const skills: string[] = []
  for (const g of ((full as { skills?: Array<{ items?: string[] }> })?.skills ?? [])) {
    for (const s of g.items ?? []) if (s?.trim()) skills.push(s.trim())
  }
  return {
    id: latest.id,
    name: latest.name,
    targetRole: latest.targetRole ?? '',
    skills: Array.from(new Set(skills)).slice(0, 20),
  }
}
