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
}

// ─── Dynamic label resolver (falls back to legacy or capitalizes slug) ───────

export function getDomainLabel(slug: string, domainsCache?: { slug: string; label: string }[]): string {
  if (domainsCache) {
    const found = domainsCache.find(d => d.slug === slug)
    if (found) return found.label
  }
  // Legacy mapping
  if (LEGACY_ROLE_LABELS[slug]) return LEGACY_ROLE_LABELS[slug]
  // Fallback: capitalize slug
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

// Backward compat export
export const ROLE_LABELS = LEGACY_ROLE_LABELS

export const EXPERIENCE_LABELS: Record<ExperienceLevel, string> = {
  '0-2': '0–2 years (Entry level)',
  '3-6': '3–6 years (Mid-level)',
  '7+': '7+ years (Senior)',
}

export const DURATION_LABELS: Record<Duration, string> = {
  10: '10 min — Quick screen',
  20: '20 min — Standard',
  30: '30 min — Deep dive',
}

// Upper bound for AI-generated question indices (total interactions including probes).
// Loop runs from 1..<QUESTION_COUNT>, so actual AI questions = QUESTION_COUNT - 1.
// Total questions answered = 1 (intro at Q0) + (QUESTION_COUNT - 1) AI questions.
export const QUESTION_COUNT: Record<Duration, number> = {
  10: 6,
  20: 11,
  30: 16,
}

// Minimum distinct topics to cover (reduced from QUESTION_COUNT since probes use time).
// With probing, fewer topics are needed but each gets explored more deeply.
export const MINIMUM_TOPICS: Record<Duration, number> = {
  10: 4,
  20: 7,
  30: 10,
}

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
    screening: 'screening interview',
    behavioral: 'behavioral interview',
    technical: 'technical deep-dive',
    'case-study': 'case study session',
  }
  const typeLabel = typeLabels[interviewType || 'screening'] || 'screening interview'

  const companyNote = targetCompany
    ? ` I understand you're preparing for ${targetCompany} — I'll keep that in mind as we go.`
    : ''

  return `Hi, I'm Alex — thanks for joining today. We'll be doing a ${label} ${typeLabel}.${companyNote} Let's kick things off: tell me a bit about yourself and what draws you to this field.`
}

export function getAvatarTitle(interviewType?: string): string {
  switch (interviewType) {
    case 'behavioral': return 'Senior Hiring Manager'
    case 'technical': return 'Technical Interview Lead'
    case 'case-study': return 'Strategy & Assessment Lead'
    default: return 'Senior Recruiter · Talent Acquisition'
  }
}

// Backward compat export
export const INTERVIEW_INTROS = LEGACY_INTERVIEW_INTROS

// ─── Closing wrap-up line ─────────────────────────────────────────────────────

export const WRAP_UP_LINE =
  "That's all the questions I have for today. Thank you so much — you've given me a lot to think about. Do you have any questions for me before we wrap up?"

// ─── Pressure question triggers (question index where light pressure hits) ────

export const PRESSURE_QUESTION_INDEX: Record<Duration, number> = {
  10: 4,
  20: 8,
  30: 12,
}
