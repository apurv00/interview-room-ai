export type TechnicalVariantId = 'technical' | 'technical-slate'

export interface TechnicalTheme {
  accentSectionTitle: string
  headerBorder: string
  contactRow: string
  skillsSectionClass: string
  skillsHeaderClass: string
  summaryTitle: string
  bodyText: string
  metaText: string
  /** Tailwind `before:text-*` class for the experience bullet glyph. */
  bulletAccentClass: string
  /** Tailwind class for the inline project URL. */
  projectUrlClass: string
}

export const TECHNICAL_THEMES: Record<TechnicalVariantId, TechnicalTheme> = {
  technical: {
    accentSectionTitle: 'font-bold uppercase text-emerald-700 mb-1',
    headerBorder: 'border-b-2 border-emerald-600 pb-2 mb-3',
    contactRow: 'flex items-center gap-2 text-[8px] text-gray-600 mt-0.5 flex-wrap',
    skillsSectionClass: 'mb-3 grid grid-cols-2 gap-x-4 gap-y-0.5',
    skillsHeaderClass: 'font-bold uppercase text-emerald-700 mb-1 col-span-2',
    summaryTitle: 'Summary',
    bodyText: 'text-gray-700',
    metaText: 'text-[8px] text-gray-500',
    bulletAccentClass: 'before:text-emerald-500',
    projectUrlClass: 'text-[8px] text-emerald-600',
  },
  'technical-slate': {
    accentSectionTitle: 'font-bold uppercase text-slate-700 mb-1',
    headerBorder: 'border-b-2 border-slate-600 pb-2 mb-3',
    contactRow: 'flex items-center gap-2 text-[8px] text-gray-600 mt-0.5 flex-wrap',
    skillsSectionClass: 'mb-3 grid grid-cols-2 gap-x-4 gap-y-0.5',
    skillsHeaderClass: 'font-bold uppercase text-slate-700 mb-1 col-span-2',
    summaryTitle: 'Summary',
    bodyText: 'text-gray-700',
    metaText: 'text-[8px] text-gray-500',
    bulletAccentClass: 'before:text-slate-500',
    projectUrlClass: 'text-[8px] text-slate-600',
  },
}

export function getTechnicalTheme(variantId: string): TechnicalTheme {
  if (variantId in TECHNICAL_THEMES) {
    return TECHNICAL_THEMES[variantId as TechnicalVariantId]
  }
  return TECHNICAL_THEMES.technical
}
