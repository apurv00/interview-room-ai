import { listResumes, getResume, saveResume, ResumeSchema } from '@resume'
import {
  isJobsAccountActive,
  JobsAccountInactiveError,
} from '@shared/services/jobsAccountFence'

/**
 * Explicit-consent base-resume save + import door (PRODUCT_FLOW §1 Stage 2).
 * A signed-in user may explicitly save the parser-produced upload as
 * "Base Resume — {role}". preserveFullText keeps the upload's original text
 * authoritative. Jobs matching-skill edits stay feed-only; this service
 * receives the parser's canonical structured skill groups unchanged.
 *
 * Re-upload dedup: an existing base resume for the SAME target role is
 * UPDATED, not duplicated — repeat onboarding never eats the 3-slot cap.
 * At the cap: no save. The caller remains on review and offers an explicit
 * tab-only continuation, so persistence failure is never hidden.
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
  if (!(await isJobsAccountActive(userId))) throw new JobsAccountInactiveError(userId)
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
  if (!(await isJobsAccountActive(userId))) throw new JobsAccountInactiveError(userId)
  const result = await saveResume(userId, candidate.data as never, { preserveFullText: true })
  if ('error' in result && result.error) {
    if (
      result.code === 'ACCOUNT_UNAVAILABLE' ||
      (result.code === 'NOT_FOUND' && !(await isJobsAccountActive(userId)))
    ) {
      throw new JobsAccountInactiveError(userId)
    }
    return { saved: false, reason: result.code === 'RESUME_LIMIT' ? 'cap' : 'error' }
  }
  return { saved: true, id: String((result as { id: string }).id), updated: !!existing }
}

export interface BaseResumeSummary {
  id: string
  name: string
  targetRole: string
  /** Latest experience title (first non-empty) — the confirm bar's role
   *  prefill when no saved targetRole exists (founder 2026-07-19: the
   *  saved-resume door left the role box empty; paste/upload already
   *  prefill from experience). Editable downstream, never authoritative. */
  latestRole: string
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
  // Latest experience title — resumes list newest first; scan for the
  // first non-empty title rather than trusting [0] blindly.
  const experience = (full as { experience?: Array<{ title?: string }> })?.experience ?? []
  const latestRole = experience.map((e) => (e.title ?? '').trim()).find(Boolean) ?? ''
  return {
    id: latest.id,
    name: latest.name,
    targetRole: latest.targetRole ?? '',
    latestRole: latestRole.slice(0, 80),
    skills: Array.from(new Set(skills)).slice(0, 20),
  }
}
