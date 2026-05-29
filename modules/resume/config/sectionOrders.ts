/**
 * Body-section render order per template, and the resolver that lets the editor's
 * drag-reorder (`data.sectionOrder`) drive the preview + PDF.
 *
 * Only single-column families honor `data.sectionOrder` — columnar families
 * (Sidebar/Creative, Startup) keep a fixed positional layout (skills/certs live
 * in the rail; Startup partitions custom sections), so they are intentionally
 * absent from TEMPLATE_BODY_ORDER and fall back to the global default in the
 * editor while their layouts ignore order entirely. See TEMPLATE_PAGINATION.md.
 */

export type BodySectionId =
  | 'summary'
  | 'experience'
  | 'education'
  | 'skills'
  | 'projects'
  | 'certifications'
  | 'customSections'

/** Global default body order (matches DEFAULT_SECTION_ORDER minus contactInfo). */
export const DEFAULT_BODY_ORDER: BodySectionId[] = [
  'summary',
  'experience',
  'education',
  'skills',
  'projects',
  'certifications',
  'customSections',
]

export const CLASSIC_ORDER: BodySectionId[] = DEFAULT_BODY_ORDER
export const TECHNICAL_ORDER: BodySectionId[] = [
  'skills',
  'summary',
  'experience',
  'projects',
  'education',
  'certifications',
  'customSections',
]
export const EXECUTIVE_ORDER: BodySectionId[] = DEFAULT_BODY_ORDER
export const CAREER_CHANGE_ORDER: BodySectionId[] = [
  'summary',
  'skills',
  'experience',
  'education',
  'projects',
  'certifications',
  'customSections',
]
export const EARLY_CAREER_GRADUATE_ORDER: BodySectionId[] = [
  'summary',
  'education',
  'projects',
  'skills',
  'experience',
  'customSections',
  'certifications',
]
export const EARLY_CAREER_ACADEMIC_ORDER: BodySectionId[] = [
  'summary',
  'education',
  'experience',
  'skills',
  'projects',
  'certifications',
  'customSections',
]

/** templateId → body render order. Single-column families only. */
export const TEMPLATE_BODY_ORDER: Record<string, BodySectionId[]> = {
  professional: CLASSIC_ORDER,
  'classic-navy': CLASSIC_ORDER,
  minimalist: CLASSIC_ORDER,
  federal: CLASSIC_ORDER,
  technical: TECHNICAL_ORDER,
  executive: EXECUTIVE_ORDER,
  'career-change': CAREER_CHANGE_ORDER,
  'entry-level': EARLY_CAREER_GRADUATE_ORDER,
  academic: EARLY_CAREER_ACADEMIC_ORDER,
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/**
 * Resolve the body order a layout should render in.
 *
 * - No persisted order, OR a persisted order equal to the GLOBAL default →
 *   the family default (this is the migration guard: every existing resume that
 *   never reordered, or was saved with the old global-default order, renders
 *   exactly as before).
 * - A genuinely-reordered order → honor it, reconciled against the family's
 *   section set (drop unknown ids, append any family section the user omitted).
 */
export function resolveSectionOrder(
  userOrder: string[] | undefined,
  familyDefault: BodySectionId[],
): BodySectionId[] {
  if (!userOrder) return familyDefault
  const userBody = userOrder.filter((id): id is BodySectionId =>
    (familyDefault as string[]).includes(id),
  )
  const userBodyRaw = userOrder.filter(id => id !== 'contactInfo')
  if (arraysEqual(userBodyRaw, DEFAULT_BODY_ORDER)) return familyDefault

  const ordered: BodySectionId[] = [...userBody]
  for (const id of familyDefault) {
    if (!ordered.includes(id)) ordered.push(id)
  }
  return ordered
}

/** Full section order (incl. contactInfo) for the editor's reorder list. */
export function getTemplateSectionOrder(templateId: string): string[] {
  const body = TEMPLATE_BODY_ORDER[templateId]
  return body
    ? ['contactInfo', ...body]
    : ['contactInfo', ...DEFAULT_BODY_ORDER]
}
