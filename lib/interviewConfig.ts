import type { Role, ExperienceLevel, Duration } from './types'

// ─── Role descriptors ─────────────────────────────────────────────────────────

export const ROLE_LABELS: Record<Role, string> = {
  PM: 'Product Manager',
  SWE: 'Software Engineer',
  Sales: 'Sales',
  MBA: 'MBA / Business',
}

export const EXPERIENCE_LABELS: Record<ExperienceLevel, string> = {
  '0-2': '0–2 years (Entry level)',
  '3-6': '3–6 years (Mid-level)',
  '7+': '7+ years (Senior)',
}

export const DURATION_LABELS: Record<Duration, string> = {
  5: '5 min — Quick screen',
  10: '10 min — Standard',
  20: '20 min — Deep dive',
}

// Upper bound for AI-generated question indices.
// Loop runs from 1..<QUESTION_COUNT>, so actual AI questions = QUESTION_COUNT - 1.
// Total questions answered = 1 (intro at Q0) + (QUESTION_COUNT - 1) AI questions.
export const QUESTION_COUNT: Record<Duration, number> = {
  5: 3,
  10: 6,
  20: 11,
}

// ─── Avatar persona ───────────────────────────────────────────────────────────

export const AVATAR_NAME = 'Alex Chen'
export const AVATAR_TITLE = 'Senior HR · Talent Acquisition'

// ─── Role-specific interviewer intros ─────────────────────────────────────────

export const INTERVIEW_INTROS: Record<Role, string> = {
  PM: `Hi, I'm Alex — thanks for making time today. We'll be doing a ${ROLE_LABELS.PM} screening. I'd love to start with a quick intro: tell me a bit about yourself and what draws you to product management.`,
  SWE: `Hey, welcome! I'm Alex from the talent team. We'll spend a bit of time today on your background and experience as an engineer. Let's start simple: tell me about yourself and what you're looking for in your next role.`,
  Sales: `Great to meet you! I'm Alex. We're going to talk about your sales experience and what drives you. Kick us off — give me your 60-second pitch on yourself.`,
  MBA: `Hello! I'm Alex, nice to have you here. This is a general business leadership screen. To start: tell me about your background and why you decided to pursue an MBA.`,
}

// ─── Closing wrap-up line ─────────────────────────────────────────────────────

export const WRAP_UP_LINE =
  "That's all the questions I have for today. Thank you so much — you've given me a lot to think about. Do you have any questions for me before we wrap up?"

// ─── Pressure question triggers (question index where light pressure hits) ────

export const PRESSURE_QUESTION_INDEX: Record<Duration, number> = {
  5: 2,
  10: 4,
  20: 8,
}
