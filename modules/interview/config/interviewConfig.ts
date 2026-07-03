import type { ExperienceLevel, Duration } from '@shared/types'

// ─── Legacy role labels (kept for backward compat with existing sessions) ────

export const LEGACY_ROLE_LABELS: Record<string, string> = {
  PM: 'Product Manager',
  SWE: 'Backend Engineer',
  Sales: 'Sales',
  MBA: 'Business & Strategy',
  // Old slugs that may still exist in DB sessions
  consulting: 'Business & Strategy',
  hr: 'Human Resources',
  legal: 'Legal',
  // Removed domains (merged into others)
  devops: 'DevOps / SRE',
  marketing: 'Marketing',
  finance: 'Finance',
  sales: 'Sales',
}

// ─── Dynamic label resolver (falls back to legacy or capitalizes slug) ───────

// UAT-013: slug lookups are now case-insensitive. CMS-managed domains
// ship lowercase slugs like `pm`, `swe`, while the legacy map below
// uses mixed-case keys (`PM`, `SWE`) — without normalization a `pm`
// payload missed every entry and degraded to title-casing the slug,
// surfacing "Pm" in history rows, the lobby, the TTS intro, etc.
export function getDomainLabel(slug: string, domainsCache?: { slug: string; label: string }[]): string {
  if (slug == null) return ''
  const raw = String(slug).trim()
  if (!raw) return ''
  const normalized = raw.toLowerCase()

  if (domainsCache) {
    const found = domainsCache.find(d => d.slug?.toLowerCase() === normalized)
    if (found) return found.label
  }
  // Legacy mapping — try exact key first, then case-insensitive sweep
  // so callers that already pass canonical-case (`PM`) keep working
  // while new lowercase slugs resolve too.
  if (LEGACY_ROLE_LABELS[raw]) return LEGACY_ROLE_LABELS[raw]
  for (const key of Object.keys(LEGACY_ROLE_LABELS)) {
    if (key.toLowerCase() === normalized) return LEGACY_ROLE_LABELS[key]
  }
  // Fallback: capitalize each hyphen/underscore segment of the slug.
  return normalized
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

// Backward compat export
export const ROLE_LABELS = LEGACY_ROLE_LABELS

export const EXPERIENCE_LABELS: Record<ExperienceLevel, string> = {
  '0-2': '0–2 years (Entry level)',
  '3-6': '3–6 years (Mid-level)',
  '7+': '7+ years (Senior)',
}

/** Preset labels for common durations; custom durations get a generated label */
const PRESET_DURATION_LABELS: Record<number, string> = {
  10: '10 min — Quick screen',
  20: '20 min — Standard',
  30: '30 min — Deep dive',
}

export function getDurationLabel(duration: Duration): string {
  return PRESET_DURATION_LABELS[duration] ?? `${duration} min`
}

/** @deprecated Use getDurationLabel() instead. Kept for backward compatibility. */
export const DURATION_LABELS = PRESET_DURATION_LABELS

// ─── Interpolation helpers ──────────────────────────────────────────────────
// These use linear interpolation between known anchor points (10, 20, 30 min)
// and extrapolate for durations outside that range (clamped to sensible bounds).

function interpolate(
  duration: number,
  anchors: [number, number][],
  { minVal = 1, round = true }: { minVal?: number; round?: boolean } = {}
): number {
  // Sort anchors by duration
  const sorted = [...anchors].sort((a, b) => a[0] - b[0])

  // Below/above range: extrapolate from the nearest two anchors (NOT clamp). Clamping below the first
  // anchor over-counted sub-10-min durations — getQuestionCount(5) returned the 10-min budget, so a
  // 5-minute interview scored against a 10-question denominator (false partial-completion penalty).
  // minVal keeps very short durations >= 1. Codex #484 P2.
  if (duration <= sorted[0][0]) {
    const [d1, v1] = sorted[0]
    const [d2, v2] = sorted[1]
    const slope = (v2 - v1) / (d2 - d1)
    const val = v1 + slope * (duration - d1)
    return round ? Math.max(minVal, Math.round(val)) : Math.max(minVal, val)
  }
  if (duration >= sorted[sorted.length - 1][0]) {
    // Extrapolate from last two points
    const [d1, v1] = sorted[sorted.length - 2]
    const [d2, v2] = sorted[sorted.length - 1]
    const slope = (v2 - v1) / (d2 - d1)
    const val = v2 + slope * (duration - d2)
    return round ? Math.max(minVal, Math.round(val)) : Math.max(minVal, val)
  }

  // Find the two surrounding anchor points
  for (let i = 0; i < sorted.length - 1; i++) {
    const [d1, v1] = sorted[i]
    const [d2, v2] = sorted[i + 1]
    if (duration >= d1 && duration <= d2) {
      const t = (duration - d1) / (d2 - d1)
      const val = v1 + t * (v2 - v1)
      return round ? Math.max(minVal, Math.round(val)) : Math.max(minVal, val)
    }
  }

  return sorted[0][1] // fallback
}

// Upper bound for AI-generated question indices (total interactions including probes).
// Loop runs from 1..<questionCount>, so actual AI questions = questionCount - 1. The loop still stops
// at this count OR when time runs low (whichever first) — a definite limit, not "keep asking".
// Set to 1.0 q/min (was 0.5): interviews were exhausting the old count well before the clock, ending
// early with time unused. Anchors: 10min→10, 20min→20, 30min→30.
export function getQuestionCount(duration: Duration): number {
  return interpolate(duration, [[10, 10], [20, 20], [30, 30]])
}

// Number of MAIN (post-intro) questions the interview loop should ask.
//
// getQuestionCount is the TOTAL question budget for the interview INCLUDING the
// opening intro question (asked before the loop), so the loop's own budget is one
// less. Crucially this counts MAIN questions ONLY — probes, pivot re-anchors, and
// deferred-topic bridges are NOT counted here; they are bounded separately by each
// slot's maxProbes and the interview clock. The loop must gate on THIS value, not on
// the monotonic exchange index, or a probed topic silently consumes a main-question
// slot and a 10-question interview collapses to ~5 (see INTERVIEW_FLOW.md §8,
// 2026-07-03). minVal keeps very short durations >= 1 main question.
export function getMainQuestionBudget(duration: Duration): number {
  return Math.max(1, getQuestionCount(duration) - 1)
}

/** @deprecated Use getQuestionCount() instead */
export const QUESTION_COUNT: Record<number, number> = { 10: 10, 20: 20, 30: 30 }

// Minimum distinct topics to cover (reduced from question count since probes use time).
// Anchors: 10min→4, 20min→7, 30min→10
export function getMinimumTopics(duration: Duration): number {
  return interpolate(duration, [[10, 4], [20, 7], [30, 10]])
}

/** @deprecated Use getMinimumTopics() instead */
export const MINIMUM_TOPICS: Record<number, number> = { 10: 4, 20: 7, 30: 10 }

// Coding interviews have fewer problems (1-2) with more time per problem
// Anchors: 10min→1, 20min→1, 30min→2
export function getCodingQuestionCount(duration: Duration): number {
  return interpolate(duration, [[10, 1], [20, 1], [30, 2]])
}

/** @deprecated Use getCodingQuestionCount() instead */
export const CODING_QUESTION_COUNT: Record<number, number> = { 10: 1, 20: 1, 30: 2 }

// ─── Avatar persona ───────────────────────────────────────────────────────────

export const AVATAR_NAME = 'Alex Chen'
export const AVATAR_TITLE = 'Senior HR · Talent Acquisition'

// ─── Role-specific interviewer intros ─────────────────────────────────────────

export const LEGACY_INTERVIEW_INTROS: Record<string, string> = {
  PM: `Hi, I'm Alex — thanks for making time today. We'll be doing a Product Manager screening. I'd love to start with a quick intro: tell me a bit about yourself and what draws you to product management.`,
  SWE: `Hey, welcome! I'm Alex from the talent team. We'll spend a bit of time today on your background and experience as an engineer. Let's start simple: tell me about yourself and what you're looking for in your next role.`,
  Sales: `Great to meet you! I'm Alex. We're going to talk about your sales experience and what drives you. Kick us off — give me your 60-second pitch on yourself.`,
  MBA: `Hello! I'm Alex, nice to have you here. This is a general business leadership screen. To start: tell me about your background and why you decided to pursue an MBA.`,
}

export function getInterviewIntro(
  domainSlug: string,
  interviewType?: string,
  targetCompany?: string,
  domainLabel?: string,
): string {
  // For legacy domains with no explicit interview type and no company context, use legacy intros
  if (!interviewType && !targetCompany && LEGACY_INTERVIEW_INTROS[domainSlug]) {
    return LEGACY_INTERVIEW_INTROS[domainSlug]
  }

  const label = domainLabel || getDomainLabel(domainSlug)

  const typeLabels: Record<string, string> = {
    behavioral: 'behavioral interview',
    technical: 'technical deep-dive',
    'case-study': 'case study session',
    'system-design': 'system design interview',
    coding: 'coding challenge',
    academics: 'academics round',
  }
  const typeLabel = typeLabels[interviewType || 'behavioral'] || 'behavioral interview'

  const companyNote = targetCompany
    ? ` I understand you're preparing for ${targetCompany} — I'll keep that in mind as we go.`
    : ''

  // Academic / subject viva opens like a campus panel — straight to the favourite subject.
  // The spoken opener IS the subject question, so there's no separate "tell me about
  // yourself" warm-up; the named subject anchors the rest of the viva.
  if (interviewType === 'academics') {
    return `Hi, I'm Alex — thanks for joining today. This is a ${label} ${typeLabel}, so I'll focus on the subjects you know best.${companyNote} Let's start right there: which academic subject are you strongest in, or enjoy the most — and why?`
  }

  return `Hi, I'm Alex — thanks for joining today. We'll be doing a ${label} ${typeLabel}.${companyNote} Let's kick things off: tell me a bit about yourself and what draws you to this field.`
}

export function getAvatarTitle(interviewType?: string): string {
  switch (interviewType) {
    case 'behavioral': return 'Senior Hiring Manager'
    case 'technical': return 'Technical Interview Lead'
    case 'case-study': return 'Strategy & Assessment Lead'
    case 'system-design': return 'Senior Systems Architect'
    case 'coding': return 'Technical Interview Lead'
    case 'academics': return 'Academic Examiner'
    default: return 'Senior Recruiter · Talent Acquisition'
  }
}

// Backward compat export
export const INTERVIEW_INTROS = LEGACY_INTERVIEW_INTROS

// ─── Closing wrap-up line ─────────────────────────────────────────────────────

export const WRAP_UP_LINE =
  "That's all the questions I have for today. Thank you so much — you've given me a lot to think about. Do you have any questions for me before we wrap up?"

// ─── Pressure question triggers (question index where light pressure hits) ────

// Pressure question triggers (question index where light pressure hits)
// The pressure-point index (~50% of the interview — the midpoint). Anchors: 10min→5, 20min→10, 30min→15.
export function getPressureQuestionIndex(duration: Duration): number {
  return interpolate(duration, [[10, 5], [20, 10], [30, 15]])
}

/** @deprecated Use getPressureQuestionIndex() instead */
export const PRESSURE_QUESTION_INDEX: Record<number, number> = { 10: 5, 20: 10, 30: 15 }
