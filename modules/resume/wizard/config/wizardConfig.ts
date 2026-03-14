// ─── Segments ──────────────────────────────────────────────────────────────

export const WIZARD_SEGMENTS = [
  {
    id: 'fresh_grad' as const,
    label: 'Fresh Graduate',
    description: 'Recently graduated or about to graduate, limited work experience',
    icon: '🎓',
  },
  {
    id: 'career_changer' as const,
    label: 'Career Changer',
    description: 'Transitioning to a new industry or role',
    icon: '🔄',
  },
  {
    id: 'returning_worker' as const,
    label: 'Returning to Work',
    description: 'Re-entering the workforce after a gap',
    icon: '🔙',
  },
  {
    id: 'experienced' as const,
    label: 'Experienced Professional',
    description: '3+ years of experience in your field',
    icon: '💼',
  },
] as const

// ─── Stage Definitions ─────────────────────────────────────────────────────

export const WIZARD_STAGES = [
  { id: 0, label: 'Segment', shortLabel: 'Type' },
  { id: 1, label: 'Contact Info', shortLabel: 'Contact' },
  { id: 2, label: 'Experience', shortLabel: 'Work' },
  { id: 3, label: 'Education', shortLabel: 'Edu' },
  { id: 4, label: 'Skills', shortLabel: 'Skills' },
  { id: 5, label: 'Projects & Certs', shortLabel: 'Extras' },
  { id: 6, label: 'AI Review', shortLabel: 'Review' },
  { id: 7, label: 'Export', shortLabel: 'Export' },
] as const

// ─── Cost Controls ─────────────────────────────────────────────────────────

export const WIZARD_COST_CAP_USD = 1.0

// ─── Strength Score Weights ────────────────────────────────────────────────

export const STRENGTH_WEIGHTS = {
  contact: 10,
  experience: 40,
  education: 15,
  skills: 20,
  extras: 15,
} as const

// ─── Fallback Follow-Up Questions ──────────────────────────────────────────

export const FALLBACK_FOLLOW_UPS: Record<string, string[]> = {
  default: [
    'What were your key achievements or accomplishments in this role?',
    'Can you quantify any results (e.g., revenue generated, people managed, efficiency improved)?',
    'What tools, technologies, or methodologies did you use regularly?',
  ],
  fresh_grad: [
    'What did you learn or accomplish in this role that you are most proud of?',
    'Did you receive any recognition, awards, or positive feedback?',
    'What specific skills did you develop or strengthen?',
  ],
  career_changer: [
    'What transferable skills from this role apply to your target career?',
    'Did you lead any projects or initiatives? What was the outcome?',
    'What measurable results can you share (numbers, percentages, dollar amounts)?',
  ],
  returning_worker: [
    'What was the scope of your responsibilities in this role?',
    'Did you manage or mentor anyone? How many people?',
    'What lasting impact did your work have on the team or organization?',
  ],
  experienced: [
    'What was the business impact of your work (revenue, cost savings, growth)?',
    'How many people did you lead, manage, or collaborate with?',
    'What strategic decisions or initiatives did you drive?',
  ],
}

// ─── Segment Prompt Modifiers ──────────────────────────────────────────────

export const SEGMENT_PROMPT_CONTEXT: Record<string, string> = {
  fresh_grad: 'The candidate is a recent graduate with limited work experience. Focus on academic projects, internships, volunteer work, and transferable skills. Emphasize learning agility and potential.',
  career_changer: 'The candidate is transitioning careers. Highlight transferable skills, relevant projects, and how past experience applies to their new direction. Bridge the gap between old and new roles.',
  returning_worker: 'The candidate is returning to work after a career gap. Focus on the depth of prior experience, any skills maintained during the gap (freelancing, volunteering, courses), and readiness to re-enter.',
  experienced: 'The candidate is an experienced professional. Focus on leadership, strategic impact, quantified achievements, and career progression. Use senior-level language and highlight P&L impact.',
}
