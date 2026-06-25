import { template, type CompactSlot } from '../slotBuilder'
import type { FlowTemplate } from '../types'
import type { ExperienceLevel } from '@shared/types'

// Viva-toned adaptive deep-dives (the shared DEEP_DIVE_1/2 use behavioral "revisit your
// weakest area" framing, which clashes with the subject-viva NEVER_ASK). Same ids +
// 'adaptive' bucket so coverage/competency wiring is unchanged.
const VIVA_DEEP_DIVE_1: CompactSlot = [
  'adaptive-deep-dive-1', 'Adaptive Deep-Dive (Weakest subject)', 'adaptive',
  'deep-dive', 'must', 3,
  'Return to the subject or concept the candidate was weakest on, with a fresh angle — a simpler sub-question or a different entry point. Do NOT repeat a previous question.',
  'Probe whether the gap is a real misunderstanding or just nerves; offer a first-principles foothold and see if they can build from it.',
]
const VIVA_DEEP_DIVE_2: CompactSlot = [
  'adaptive-deep-dive-2', 'Adaptive Deep-Dive (Stretch / recover)', 'adaptive',
  'deep-dive', 'if-time', 3,
  'If the candidate is strong, stretch them with a harder derivation or a cross-subject connection. If they are struggling, return to their strongest subject so they finish on solid ground.',
  'For strong candidates, push for a proof, a derivation, or an edge case. For struggling candidates, let them show depth where they are most confident.',
]

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
// NOTE: the favourite-subject question is the spoken INTRO (getInterviewIntro for academics),
// so the viva opens directly on the subject — no generic "tell me about yourself" turn. Slot 0
// is a LIGHT warm-up (a roadmap of the named subject): the flow engine requires a warm-up slot,
// and it eases the candidate in before real probing. Slots are worded to work even though Q1 is
// prefetched before the candidate's intro answer is captured (they reference "their subject").
const academicSlots: CompactSlot[] = [
  ['subject-warmup', 'Ease into their subject', 'technical-breadth', 'warm-up', 'must', 1,
    'The candidate has just named their strongest subject in the opening. Warm up by asking them to map out the main topics or areas within it they have studied — a quick roadmap, no deep probing yet. This settles them and surfaces which areas to drill next.',
    'Surface only — note which areas they are most comfortable with; do NOT push for depth here.',
    'A confident roadmap of their subject matters more than depth at this first step.'],
  ['fundamentals-of-favourite', 'Fundamentals of their subject', 'technical-depth', 'exploration', 'must', 2,
    'The candidate named their strongest subject in the opening. Have them take THAT subject and explain a core fundamental of it from first principles — let them pick the concept; do NOT assume a specific subject. Push for the mechanism, not just a definition. Stay on the standard, widely-taught syllabus.',
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
  VIVA_DEEP_DIVE_1,
  VIVA_DEEP_DIVE_2,
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
