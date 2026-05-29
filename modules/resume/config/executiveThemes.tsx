export type ExecutiveVariantId = 'executive'

export interface ExecutiveTheme {
  nameColor: string
  nameSize: string
  sectionTitleClass: string
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
    nameColor: '#1e293b',
    nameSize: 'var(--r-title, 20px)',
    sectionTitleClass:
      'font-bold uppercase tracking-[0.2em] text-[#1e293b] border-b-2 border-[#1e293b] pb-0.5 mb-1',
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
  return EXECUTIVE_THEMES.executive
}
