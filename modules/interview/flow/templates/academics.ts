import { template, DEEP_DIVE_1, DEEP_DIVE_2, type CompactSlot } from '../slotBuilder'
import type { FlowTemplate } from '../types'
import type { ExperienceLevel } from '@shared/types'

/**
 * Academic / Subject-Viva flow shape (campus-placement "favourite subject?" round).
 *
 * Deliberately SUBJECT-AGNOSTIC: the candidate names their strongest subject in the
 * warm-up, then the per-domain `modules/interview/skills/{domain}-academics.md` skill
 * file supplies the subject pool, adjacency map, sample questions, and the accuracy
 * guardrails. One shared shape is registered for every academics domain × band — the
 * domain-specific content lives in the skill files, preserving the per-domain grain
 * while keeping the viva structure consistent (favourite → fundamentals → derive →
 * adjacent → connect → close).
 */
const academicSlots: CompactSlot[] = [
  ['favourite-subject', 'Favourite / strongest subject', 'technical-breadth', 'warm-up', 'must', 0,
    'Open by asking which academic subject the candidate is strongest in or enjoys most, and why. This NAMES the subject the viva will drill — do not grill yet.',
    'Surface only — capture the named subject and the reason; it anchors the rest of the viva.',
    'A clear favourite with a genuine reason matters more than breadth at this level.'],
  ['fundamentals-of-favourite', 'Fundamentals of their subject', 'technical-depth', 'exploration', 'must', 2,
    'Probe a core fundamental of the candidate\'s stated favourite subject. Ask them to EXPLAIN or DERIVE a key concept from first principles — not just define it. Stay on the standard, widely-taught syllabus.',
    'Push on the mechanism and the "why"; ask them to justify, derive, or work a simple example. Never demand a memorized constant — accept "I\'d look it up".',
    'Reward clean first-principles reasoning and stated assumptions over recall.'],
  ['derive-or-justify', 'Derive / justify a result', 'problem-solving', 'exploration', 'must', 2,
    'Go one level deeper into the favourite subject — a theorem, derivation, edge case, or "what happens if" that tests genuine understanding.',
    'Find the edge of their understanding; raise difficulty a notch each time they answer cleanly. Correct a wrong answer gently with the standard result.',
    'The boundary of their knowledge is the signal — push until you find it.'],
  ['adjacent-subject', 'An adjacent subject', 'technical-breadth', 'exploration', 'must', 2,
    'Move to a subject ADJACENT to their favourite (per this domain\'s subject map in the skill file) and probe one fundamental there to test breadth.',
    'Probe one core concept; reward honest reasoning over a confident wrong recital on a subject they are weaker in.',
    'Breadth check — do not treat an adjacent-subject gap as harshly as a gap in their stated strength.'],
  ['connect-concepts', 'Connect two concepts', 'problem-solving', 'exploration', 'if-time', 2,
    'Ask a question that connects two subjects or applies a concept to a simple, concrete scenario.',
    'Look for whether they can bridge subjects or apply theory — not just recite within one silo.'],
  ['breadth-check', 'One more core subject', 'technical-breadth', 'exploration', 'if-time', 1,
    'Briefly probe one more core subject from the standard syllabus to gauge overall breadth.',
    'Surface probe — one fundamental; gauge whether the basics are solid across the syllabus.'],
  DEEP_DIVE_1,
  DEEP_DIVE_2,
  ['closing-curiosity', 'Subject they want to deepen', 'self-awareness', 'closing', 'must', 0,
    'Ask which subject they most want to go deeper into and how they study it.',
    'Surface — wrap up warmly; assess genuine intellectual curiosity.'],
]

const NEVER_ASK = [
  'Obscure trivia, specific constants/values, version numbers, or a niche paper',
  'Fabricating or mis-stating a theorem, formula, or definition',
  'Penalizing "I would look it up" for a specific constant or value',
  'STAR / behavioral framing — this is a subject viva, not a behavioral round',
  'Grilling a subject the candidate disclaimed as weak as if it were their strength',
]

// Domains the academics depth is offered for — the 19 taxonomy domains (categories:
// programming, data-ai, core-engineering, business), each with its own
// `{domain}-academics.md` skill file, PLUS `general` as the CMS backstop. academics
// inherits by category in /api/interview-types, so a CMS-added domain in those categories
// can select it; resolveFlow + getSkillContent then fall back to general:academics /
// general-academics.md when that domain has no own files — matching every other depth's
// general backstop (skillLoader.ts:148-154, resolver.ts:31-34).
const ACADEMIC_DOMAINS = [
  'frontend', 'backend', 'sdet', 'fullstack', 'devops', 'mobile',
  'data-science', 'ml-engineer', 'data-analyst',
  'mechanical', 'civil', 'electrical', 'electronics',
  'marketing', 'finance', 'operations', 'sales', 'strategy', 'business',
  'general',
] as const

// All 3 bands registered (the coverage guard requires it); the depth itself is
// visibility-gated to 0-2 via applicableExperience, so the mid/senior bands are never
// resolved live. Built from named consts (not an inline three-element band array) so the
// QA template scanner in strongAnswerRouter doesn't misread the band list as a
// competency-bucket slot tuple.
const ENTRY_BAND: ExperienceLevel = '0-2'
const MID_BAND: ExperienceLevel = '3-6'
const SENIOR_BAND: ExperienceLevel = '7+'
const BANDS: ExperienceLevel[] = [ENTRY_BAND, MID_BAND, SENIOR_BAND]

export const TEMPLATES: FlowTemplate[] = ACADEMIC_DOMAINS.flatMap(domain =>
  BANDS.map(band => template(domain, 'academics', band, academicSlots, NEVER_ASK)),
)
