import type { ResumeData } from '../validators/resume'

/** True when the resume has ANY structured section that buildFullText can
 *  serialize. Must cover EVERY section buildFullText emits — a projects-only
 *  or certifications-only resume is structured content too; the old inline
 *  predicates (summary/experience/education/skills/fullName only) made those
 *  resumes fall through to the stale import-time fullText (Codex P2).
 *  Client-safe: no db imports, usable by both saveResume and the builder's
 *  parse-on-open decision. */
export function hasStructuredResumeContent(
  data: Partial<Pick<ResumeData,
    'summary' | 'experience' | 'education' | 'skills'
    | 'projects' | 'certifications' | 'customSections' | 'contactInfo'>>,
): boolean {
  const c = data.contactInfo
  return !!(
    data.summary
    || data.experience?.length
    || data.education?.length
    || data.skills?.length
    || data.projects?.length
    || data.certifications?.length
    || data.customSections?.length
    || c?.fullName
    || c?.email
    || c?.phone
    || c?.location
  )
}
