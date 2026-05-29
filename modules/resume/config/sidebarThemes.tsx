export type SidebarVariantId = 'creative' | 'sidebar-slate' | 'sidebar-violet'

export interface SidebarTheme {
  sidebarWidth: string
  mainWidth: string
  sidebarBg: string
  sidebarHeaderClass: string
  sidebarItemClass: string
  sidebarMutedClass: string
  sidebarFaintClass: string
  /** Tailwind text-color class for the name + company accent (kept as a class so it ships in the precompiled PDF CSS). */
  accentClass: string
  mainSectionTitleClass: string
  summaryTitle: string
  companyJoiner: 'pipe' | 'at'
  bulletDotClass: string
  projectUrlClass: string
}

export const SIDEBAR_THEMES: Record<SidebarVariantId, SidebarTheme> = {
  creative: {
    sidebarWidth: 'w-[20%]',
    mainWidth: 'w-[80%]',
    sidebarBg: 'bg-[#2563eb] text-white',
    sidebarHeaderClass:
      'font-bold uppercase tracking-widest border-b border-white/30 pb-0.5 mb-1',
    sidebarItemClass: 'text-[8px] mb-0.5',
    sidebarMutedClass: 'text-white/80',
    sidebarFaintClass: 'text-white/60',
    accentClass: 'text-[#2563eb]',
    mainSectionTitleClass:
      'font-bold uppercase tracking-widest text-[#2563eb] border-b border-gray-200 pb-0.5 mb-1',
    summaryTitle: 'About Me',
    companyJoiner: 'pipe',
    bulletDotClass: 'bg-[#2563eb]',
    projectUrlClass: 'text-[8px] text-[#2563eb] ml-1',
  },
  'sidebar-slate': {
    sidebarWidth: 'w-[22%]',
    mainWidth: 'w-[78%]',
    sidebarBg: 'bg-slate-800 text-white',
    sidebarHeaderClass:
      'font-bold uppercase tracking-widest border-b border-white/20 pb-0.5 mb-1',
    sidebarItemClass: 'text-[8px] mb-0.5',
    sidebarMutedClass: 'text-slate-300',
    sidebarFaintClass: 'text-slate-400',
    accentClass: 'text-slate-700',
    mainSectionTitleClass:
      'font-bold uppercase tracking-widest text-slate-700 border-b border-slate-200 pb-0.5 mb-1',
    summaryTitle: 'Profile',
    companyJoiner: 'pipe',
    bulletDotClass: 'bg-slate-600',
    projectUrlClass: 'text-[8px] text-slate-600 ml-1',
  },
  'sidebar-violet': {
    sidebarWidth: 'w-[22%]',
    mainWidth: 'w-[78%]',
    sidebarBg: 'bg-violet-700 text-white',
    sidebarHeaderClass:
      'font-bold uppercase tracking-widest border-b border-white/20 pb-0.5 mb-1',
    sidebarItemClass: 'text-[8px] mb-0.5',
    sidebarMutedClass: 'text-violet-100',
    sidebarFaintClass: 'text-violet-200',
    accentClass: 'text-violet-700',
    mainSectionTitleClass:
      'font-bold uppercase tracking-widest text-violet-700 border-b border-violet-200 pb-0.5 mb-1',
    summaryTitle: 'Profile',
    companyJoiner: 'pipe',
    bulletDotClass: 'bg-violet-600',
    projectUrlClass: 'text-[8px] text-violet-600 ml-1',
  },
}

export function getSidebarTheme(variantId: string): SidebarTheme {
  if (variantId in SIDEBAR_THEMES) {
    return SIDEBAR_THEMES[variantId as SidebarVariantId]
  }
  return SIDEBAR_THEMES.creative
}
