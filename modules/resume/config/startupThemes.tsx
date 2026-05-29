export type StartupVariantId = 'startup'

export interface StartupTheme {
  sectionTitleClass: string
  summaryTitle: string
  headerGradient: string
  contactSeparator: string
  companyAtClass: string
  bulletGradientClass: string
  projectUrlClass: string
  tagColors: string[]
}

export const STARTUP_THEMES: Record<StartupVariantId, StartupTheme> = {
  startup: {
    sectionTitleClass: 'font-bold uppercase tracking-widest text-orange-500 mb-1',
    summaryTitle: 'About',
    headerGradient: 'linear-gradient(to right, #f97316, #ec4899)',
    contactSeparator: '·',
    companyAtClass: 'text-pink-500',
    bulletGradientClass: 'bg-gradient-to-r from-orange-400 to-pink-400',
    projectUrlClass: 'text-[8px] text-pink-500',
    tagColors: [
      'bg-orange-100 text-orange-700',
      'bg-pink-100 text-pink-700',
      'bg-purple-100 text-purple-700',
      'bg-blue-100 text-blue-700',
      'bg-green-100 text-green-700',
      'bg-yellow-100 text-yellow-700',
    ],
  },
}

export function getStartupTheme(variantId: string): StartupTheme {
  return STARTUP_THEMES.startup
}
