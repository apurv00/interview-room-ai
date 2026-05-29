export type CareerChangeVariantId = 'career-change' | 'career-change-emerald'

export interface CareerChangeTheme {
  headerBorderClass: string
  nameClass: string
  nameSize: string
  contactRowClass: string
  sectionTitleClass: string
  summaryTitle: string
  skillsTitle: string
  experienceTitle: string
  educationTitle: string
  bulletDotClass: string
  skillCategoryClass: string
  projectUrlClass: string
}

export const CAREER_CHANGE_THEMES: Record<CareerChangeVariantId, CareerChangeTheme> = {
  'career-change': {
    headerBorderClass: 'border-b-2 border-cyan-600 pb-2 mb-3',
    nameClass: 'font-bold text-cyan-600',
    nameSize: 'var(--r-title, 18px)',
    contactRowClass: 'flex items-center gap-2 text-[8px] text-gray-600 mt-0.5 flex-wrap',
    sectionTitleClass:
      'font-bold uppercase tracking-widest text-cyan-600 border-b border-cyan-200 pb-0.5 mb-1',
    summaryTitle: 'Career Objective',
    skillsTitle: 'Core Competencies',
    experienceTitle: 'Relevant Experience',
    educationTitle: 'Education & Training',
    bulletDotClass: 'bg-cyan-600',
    skillCategoryClass: 'text-[8px] font-semibold text-cyan-700',
    projectUrlClass: 'text-[8px] text-cyan-600 ml-1',
  },
  'career-change-emerald': {
    headerBorderClass: 'border-b-2 border-emerald-600 pb-2 mb-3',
    nameClass: 'font-bold text-emerald-600',
    nameSize: 'var(--r-title, 18px)',
    contactRowClass: 'flex items-center gap-2 text-[8px] text-gray-600 mt-0.5 flex-wrap',
    sectionTitleClass:
      'font-bold uppercase tracking-widest text-emerald-600 border-b border-emerald-200 pb-0.5 mb-1',
    summaryTitle: 'Career Objective',
    skillsTitle: 'Core Competencies',
    experienceTitle: 'Relevant Experience',
    educationTitle: 'Education & Training',
    bulletDotClass: 'bg-emerald-600',
    skillCategoryClass: 'text-[8px] font-semibold text-emerald-700',
    projectUrlClass: 'text-[8px] text-emerald-600 ml-1',
  },
}

export function getCareerChangeTheme(variantId: string): CareerChangeTheme {
  if (variantId in CAREER_CHANGE_THEMES) {
    return CAREER_CHANGE_THEMES[variantId as CareerChangeVariantId]
  }
  return CAREER_CHANGE_THEMES['career-change']
}
