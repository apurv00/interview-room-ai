import { STRENGTH_WEIGHTS } from '../config/wizardConfig'

// ─── Types ─────────────────────────────────────────────────────────────────

export interface StrengthInput {
  contactInfo?: {
    fullName?: string
    email?: string
    phone?: string
    city?: string
    linkedInUrl?: string
  } | null
  roles?: Array<{
    rawBullets?: string[]
    followUpQuestions?: Array<{ answer?: string }>
    bulletDecisions?: Array<{ decision: string }>
    finalBullets?: string[]
  }>
  education?: Array<{
    institution?: string
    degree?: string
    gpa?: string
    honors?: string
  }>
  skills?: {
    hard?: string[]
    soft?: string[]
    technical?: string[]
  }
  projects?: Array<{ name?: string }>
  certifications?: Array<{ name?: string }>
  finalSummary?: string
  generatedSummary?: string
}

export interface StrengthResult {
  total: number
  breakdown: {
    contact: number
    experience: number
    education: number
    skills: number
    extras: number
  }
}

// ─── Calculator ────────────────────────────────────────────────────────────

export function calculateStrengthScore(data: StrengthInput): StrengthResult {
  const breakdown = {
    contact: calcContact(data),
    experience: calcExperience(data),
    education: calcEducation(data),
    skills: calcSkills(data),
    extras: calcExtras(data),
  }

  const total = Math.min(100,
    breakdown.contact + breakdown.experience + breakdown.education +
    breakdown.skills + breakdown.extras
  )

  return { total, breakdown }
}

// ─── Section Calculators ───────────────────────────────────────────────────

function calcContact(data: StrengthInput): number {
  const max = STRENGTH_WEIGHTS.contact // 10
  const c = data.contactInfo
  if (!c) return 0

  let score = 0
  if (c.fullName?.trim()) score += 2
  if (c.email?.trim()) score += 2
  if (c.phone?.trim()) score += 2
  if (c.city?.trim()) score += 2
  if (c.linkedInUrl?.trim()) score += 2

  return Math.min(max, score)
}

function calcExperience(data: StrengthInput): number {
  const max = STRENGTH_WEIGHTS.experience // 40
  const roles = data.roles || []
  if (roles.length === 0) return 0

  let score = 0

  // +8 per role, up to 4 roles = 32
  score += Math.min(4, roles.length) * 8

  for (const role of roles.slice(0, 4)) {
    // +1 per raw bullet, up to 3 per role = 3
    const bulletCount = role.rawBullets?.filter(b => b.trim()).length || 0
    score += Math.min(3, bulletCount)

    // +1 per follow-up answer, up to 3 per role = 3
    const answerCount = role.followUpQuestions?.filter(q => q.answer?.trim()).length || 0
    score += Math.min(3, answerCount)

    // +2 if any enhanced bullets were accepted
    const hasAccepted = role.bulletDecisions?.some(d => d.decision === 'accept' || d.decision === 'edit')
    if (hasAccepted) score += 2
  }

  return Math.min(max, score)
}

function calcEducation(data: StrengthInput): number {
  const max = STRENGTH_WEIGHTS.education // 15
  const entries = data.education || []
  if (entries.length === 0) return 0

  let score = 0

  // +5 per entry, up to 2 = 10
  score += Math.min(2, entries.length) * 5

  // +2.5 for GPA on first entry
  if (entries[0]?.gpa?.trim()) score += 2.5

  // +2.5 for honors on first entry
  if (entries[0]?.honors?.trim()) score += 2.5

  return Math.min(max, score)
}

function calcSkills(data: StrengthInput): number {
  const max = STRENGTH_WEIGHTS.skills // 20
  const s = data.skills
  if (!s) return 0

  let categoriesWithItems = 0
  if ((s.hard?.length || 0) >= 3) categoriesWithItems++
  if ((s.soft?.length || 0) >= 3) categoriesWithItems++
  if ((s.technical?.length || 0) >= 3) categoriesWithItems++

  // +4 per category with 3+ items, up to 5 categories
  // (we have 3 categories max → 12 pts from categories)
  let score = categoriesWithItems * 4

  // Bonus for quantity: +2 per 5 total skills, up to 8 bonus
  const totalSkills = (s.hard?.length || 0) + (s.soft?.length || 0) + (s.technical?.length || 0)
  score += Math.min(8, Math.floor(totalSkills / 5) * 2)

  return Math.min(max, score)
}

function calcExtras(data: StrengthInput): number {
  const max = STRENGTH_WEIGHTS.extras // 15
  let score = 0

  // +5 per project, up to 2 = 10
  const validProjects = (data.projects || []).filter(p => p.name?.trim())
  score += Math.min(2, validProjects.length) * 5

  // +2.5 per cert, up to 2 = 5
  const validCerts = (data.certifications || []).filter(c => c.name?.trim())
  score += Math.min(2, validCerts.length) * 2.5

  // +5 if summary exists (from finalSummary or generatedSummary)
  if (data.finalSummary?.trim() || data.generatedSummary?.trim()) {
    score += 5
  }

  return Math.min(max, score)
}
