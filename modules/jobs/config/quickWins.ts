/**
 * Quick-wins engine (PRODUCT_FLOW §1 Stage 2 + package 10) — ZERO LLM.
 * Deterministic rules over the structured base resume; renders as a
 * non-blocking feed card ("Resume: N quick wins → Fix in builder"). Pure
 * and client-safe (deep-importable; the @jobs barrel drags mongoose).
 */

export interface QuickWin {
  id: string
  title: string
  hint: string
}

interface ResumeLike {
  summary?: string
  contactInfo?: { fullName?: string; email?: string; phone?: string }
  experience?: Array<{ bullets?: string[]; description?: string }>
  skills?: Array<{ items?: string[] }>
  projects?: unknown[]
}

const WEAK_OPENERS = /^(responsible for|worked on|helped|involved in|assisted with|was part of)/i

export function computeQuickWins(resume: ResumeLike): QuickWin[] {
  const wins: QuickWin[] = []
  const bullets: string[] = []
  for (const exp of resume.experience ?? []) {
    for (const b of exp.bullets ?? []) if (b?.trim()) bullets.push(b.trim())
    if (typeof exp.description === 'string' && exp.description.trim()) {
      for (const line of exp.description.split('\n')) if (line.trim()) bullets.push(line.trim())
    }
  }
  const skills = (resume.skills ?? []).flatMap((g) => g.items ?? []).filter((s) => s?.trim())

  if (!resume.summary || resume.summary.trim().length < 120) {
    wins.push({ id: 'summary', title: 'Add a 2-line professional summary', hint: 'Recruiters read it first — role, years, top strength.' })
  }
  if (bullets.length > 0) {
    const quantified = bullets.filter((b) => /\d/.test(b)).length
    if (quantified / bullets.length < 0.3) {
      wins.push({ id: 'quantify', title: 'Add numbers to your achievements', hint: '₹ saved, % improved, users served — numbers survive skimming.' })
    }
    if (bullets.some((b) => WEAK_OPENERS.test(b))) {
      wins.push({ id: 'verbs', title: 'Lead bullets with action verbs', hint: '“Built”, “Cut”, “Shipped” — never “responsible for”.' })
    }
    if (bullets.some((b) => b.length > 220)) {
      wins.push({ id: 'tighten', title: 'Tighten long bullets', hint: 'One line each — the second line rarely gets read.' })
    }
  }
  if (skills.length === 0) {
    wins.push({ id: 'skills', title: 'Add a skills section', hint: 'ATS filters match on it; so does our job feed.' })
  } else if (skills.length < 5) {
    wins.push({ id: 'more-skills', title: 'List more concrete skills', hint: 'Aim for 8–12 — tools, frameworks, methods you actually used.' })
  }
  if (!resume.contactInfo?.email || !resume.contactInfo?.phone) {
    wins.push({ id: 'contact', title: 'Complete your contact info', hint: 'Email and phone — missing either kills responses.' })
  }
  if ((resume.experience ?? []).length === 0 && (resume.projects ?? []).length === 0) {
    wins.push({ id: 'projects', title: 'Add projects', hint: 'Projects carry a fresher resume — coursework counts.' })
  }
  return wins.slice(0, 6)
}
