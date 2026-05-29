export type ExecutiveVariantId = 'executive' | 'executive-gold'

export interface ExecutiveTheme {
  /** Tailwind text-color class for the name (kept as a class so it ships in the precompiled PDF CSS). */
  nameColorClass: string
  nameSize: string
  sectionTitleClass: string
  /** Tailwind text-color class for the triangle bullet marker. */
  bulletColorClass: string
  /** Tailwind border-color class for the header rule. */
  ruleBorderClass: string
  summaryTitle: string
  experienceTitle: string
  skillsTitle: string
  projectsTitle: string
  certificationsTitle: string
  summaryItalic: boolean
  experienceTitleUpper: boolean
  bulletMarker: 'triangle' | 'dot'
  skillsGrid: boolean
}

export const EXECUTIVE_THEMES: Record<ExecutiveVariantId, ExecutiveTheme> = {
  executive: {
    nameColorClass: 'text-[#1e293b]',
    nameSize: 'var(--r-title, 20px)',
    sectionTitleClass:
      'font-bold uppercase tracking-[0.2em] text-[#1e293b] border-b-2 border-[#1e293b] pb-0.5 mb-1',
    bulletColorClass: 'text-[#1e293b]',
    ruleBorderClass: 'border-[#1e293b]',
    summaryTitle: 'Executive Summary',
    experienceTitle: 'Key Achievements & Experience',
    skillsTitle: 'Core Competencies',
    projectsTitle: 'Notable Projects',
    certificationsTitle: 'Certifications & Credentials',
    summaryItalic: true,
    experienceTitleUpper: true,
    bulletMarker: 'triangle',
    skillsGrid: true,
  },
  'executive-gold': {
    nameColorClass: 'text-amber-700',
    nameSize: 'var(--r-title, 20px)',
    sectionTitleClass:
      'font-bold uppercase tracking-[0.2em] text-amber-700 border-b-2 border-amber-600 pb-0.5 mb-1',
    bulletColorClass: 'text-amber-700',
    ruleBorderClass: 'border-amber-600',
    summaryTitle: 'Executive Summary',
    experienceTitle: 'Key Achievements & Experience',
    skillsTitle: 'Core Competencies',
    projectsTitle: 'Notable Projects',
    certificationsTitle: 'Certifications & Credentials',
    summaryItalic: true,
    experienceTitleUpper: true,
    bulletMarker: 'triangle',
    skillsGrid: true,
  },
}

export function getExecutiveTheme(variantId: string): ExecutiveTheme {
  if (variantId in EXECUTIVE_THEMES) {
    return EXECUTIVE_THEMES[variantId as ExecutiveVariantId]
  }
  return EXECUTIVE_THEMES.executive
}
