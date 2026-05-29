export type EarlyCareerVariantId = 'entry-level' | 'academic'

export interface EarlyCareerTheme {
  headerBorderClass: string
  nameClass: string
  nameSize: string
  contactRowClass: string
  sectionTitleClass: string
  sectionGap: string
  summaryTitle: string
  experienceTitle: string
  skillsTitle: string
  bulletDotClass: string
  projectUrlClass: string
  /** graduate: edu → projects → skills → experience; academic: edu → experience → skills → projects */
  layoutMode: 'graduate' | 'academic'
}

export const EARLY_CAREER_THEMES: Record<EarlyCareerVariantId, EarlyCareerTheme> = {
  'entry-level': {
    headerBorderClass: 'text-center border-b-2 border-rose-500 pb-2 mb-3',
    nameClass: 'font-bold text-rose-500',
    nameSize: 'var(--r-title, 18px)',
    contactRowClass: 'flex items-center justify-center gap-2 text-[8px] text-gray-600 mt-0.5 flex-wrap',
    sectionTitleClass:
      'font-bold uppercase tracking-widest text-rose-500 border-b border-rose-200 pb-0.5 mb-1',
    sectionGap: 'mb-3',
    summaryTitle: 'Objective',
    experienceTitle: 'Experience',
    skillsTitle: 'Skills',
    bulletDotClass: 'bg-rose-500',
    projectUrlClass: 'text-[8px] text-rose-500',
    layoutMode: 'graduate',
  },
  academic: {
    headerBorderClass: 'text-center border-b-2 border-blue-700 pb-1.5 mb-2',
    nameClass: 'font-bold tracking-wide',
    nameSize: 'var(--r-title, 18px)',
    contactRowClass: 'flex items-center justify-center gap-2 text-[8px] text-gray-600 mt-0.5 flex-wrap',
    sectionTitleClass:
      'font-bold uppercase tracking-widest text-blue-700 border-b border-blue-300 pb-0.5 mb-1',
    sectionGap: 'mb-2',
    summaryTitle: 'Research Interests',
    experienceTitle: 'Research Experience',
    skillsTitle: 'Technical Skills',
    bulletDotClass: 'bg-blue-700',
    projectUrlClass: 'text-[8px] text-blue-700 ml-1',
    layoutMode: 'academic',
  },
}

export function getEarlyCareerTheme(variantId: string): EarlyCareerTheme {
  if (variantId in EARLY_CAREER_THEMES) {
    return EARLY_CAREER_THEMES[variantId as EarlyCareerVariantId]
  }
  return EARLY_CAREER_THEMES['entry-level']
}
