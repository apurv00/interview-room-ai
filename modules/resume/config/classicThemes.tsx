import type { ReactNode } from 'react'

export type ClassicVariantId = 'professional' | 'minimalist' | 'federal' | 'classic-navy'

export interface ClassicTheme {
  layoutMode: 'standard' | 'federal'
  rootClass: string
  skillsTitle: string
  sectionLabels: {
    experience: string
    education: string
    projects: string
    certifications: string
  }
  contact: {
    wrapperClass: string
    nameClass: string
    rowClass: string
    usePipeSeparators: boolean
    showGithub: boolean
    trailingHr?: boolean
  }
  sectionGap: string
  sectionTitleClass: string
  /** Minimalist draws an hr under section titles; professional uses border on h2 */
  sectionDivider: 'underline' | 'hr-below'
  summaryTitle: string
  bodyText: string
  metaText: string
  experience: {
    unitGap: string
    titleClass: string
    companyJoiner: 'em-dash' | 'at'
    bulletStyle: 'dot' | 'dash'
    bulletText: string
  }
  education: {
    unitGap: string
    titleClass: string
    mutedDegreeDetails: boolean
    metaSeparator: string
    metaMarginTop?: string
  }
  skills: {
    sectionClassName?: string
    headerClassName?: string
    renderHeader?: () => ReactNode
    renderCategory: 'inline-colon' | 'stacked'
    categoryTitleClass: string
    categoryItemsClass: string
  }
  projects: {
    unitGap: string
    nameClass: string
    techStyle: 'parens' | 'suffix'
    descriptionClass: string
    /** Override for the parenthesised tech list color (legacy Federal uses gray-600). */
    techParensClass?: string
  }
  certifications: {
    unitGap: string
    nameClass: string
    /** Override for the non-minimal date color (legacy Federal uses gray-600). */
    dateClass?: string
  }
  custom: {
    contentClass: string
  }
}

const professionalSectionTitle =
  'font-bold uppercase tracking-widest border-b border-gray-300 pb-0.5 mb-1'

const minimalistSectionTitle =
  'font-medium uppercase tracking-widest text-gray-400 mb-1.5'

const minimalistSectionHr = <hr className="border-t border-gray-100 mb-2" />

const federalSectionTitle = 'font-bold uppercase border-b border-gray-300 pb-0.5 mb-1'

export const CLASSIC_THEMES: Record<ClassicVariantId, ClassicTheme> = {
  professional: {
    layoutMode: 'standard',
    skillsTitle: 'Skills',
    sectionLabels: {
      experience: 'Experience',
      education: 'Education',
      projects: 'Projects',
      certifications: 'Certifications',
    },
    rootClass: 'text-gray-900 leading-snug',
    contact: {
      wrapperClass: 'text-center border-b-2 border-gray-800 pb-2 mb-3',
      nameClass: 'font-bold tracking-wide uppercase',
      rowClass: 'flex items-center justify-center gap-2 text-[8px] text-gray-600 mt-1 flex-wrap',
      usePipeSeparators: true,
      showGithub: false,
    },
    sectionGap: 'mb-3',
    sectionTitleClass: professionalSectionTitle,
    sectionDivider: 'underline',
    summaryTitle: 'Professional Summary',
    bodyText: 'text-gray-700 leading-relaxed',
    metaText: 'text-[8px] text-gray-500',
    experience: {
      unitGap: 'mb-2',
      titleClass: 'font-bold',
      companyJoiner: 'em-dash',
      bulletStyle: 'dot',
      bulletText: 'text-gray-700',
    },
    education: {
      unitGap: 'mb-1.5',
      titleClass: 'font-bold',
      mutedDegreeDetails: false,
      metaSeparator: ' | ',
    },
    skills: {
      headerClassName: professionalSectionTitle,
      renderCategory: 'inline-colon',
      categoryTitleClass: 'font-semibold',
      categoryItemsClass: 'text-gray-700',
    },
    projects: {
      unitGap: 'mb-1.5',
      nameClass: 'font-bold',
      techStyle: 'parens',
      descriptionClass: 'text-gray-700',
    },
    certifications: {
      unitGap: 'mb-0.5',
      nameClass: 'font-semibold',
    },
    custom: {
      contentClass: 'text-gray-700 whitespace-pre-wrap',
    },
  },
  minimalist: {
    layoutMode: 'standard',
    skillsTitle: 'Skills',
    sectionLabels: {
      experience: 'Experience',
      education: 'Education',
      projects: 'Projects',
      certifications: 'Certifications',
    },
    rootClass: 'text-gray-900 leading-relaxed',
    contact: {
      wrapperClass: 'mb-4',
      nameClass: 'font-light tracking-wide',
      rowClass: 'flex items-center gap-3 text-[8px] text-gray-500 mt-1 flex-wrap',
      usePipeSeparators: false,
      showGithub: true,
      trailingHr: true,
    },
    sectionGap: 'mb-4',
    sectionTitleClass: minimalistSectionTitle,
    sectionDivider: 'hr-below',
    summaryTitle: 'Summary',
    bodyText: 'text-gray-600 leading-relaxed',
    metaText: 'text-[8px] text-gray-400',
    experience: {
      unitGap: 'mb-3',
      titleClass: 'font-medium',
      companyJoiner: 'at',
      bulletStyle: 'dash',
      bulletText: 'text-gray-600',
    },
    education: {
      unitGap: 'mb-2',
      titleClass: 'font-medium',
      mutedDegreeDetails: true,
      metaSeparator: ' · ',
      metaMarginTop: ' mt-0.5',
    },
    skills: {
      sectionClassName: 'mb-4',
      renderHeader: () => (
        <>
          <h2
            data-resume-section-header="Skills"
            className={minimalistSectionTitle}
          >
            Skills
          </h2>
          {minimalistSectionHr}
        </>
      ),
      renderCategory: 'stacked',
      categoryTitleClass: 'font-medium',
      categoryItemsClass: 'text-gray-500 ml-2',
    },
    projects: {
      unitGap: 'mb-2',
      nameClass: 'font-medium',
      techStyle: 'suffix',
      descriptionClass: 'text-gray-600',
    },
    certifications: {
      unitGap: 'mb-1',
      nameClass: 'font-medium',
    },
    custom: {
      contentClass: 'text-gray-600 whitespace-pre-wrap',
    },
  },
  federal: {
    layoutMode: 'federal',
    skillsTitle: 'Job-Related Skills',
    sectionLabels: {
      experience: 'Work Experience',
      education: 'Education',
      projects: 'Projects',
      certifications: 'Certifications & Licenses',
    },
    rootClass: 'text-gray-900 leading-snug',
    contact: {
      wrapperClass: 'border-b border-gray-400 pb-1.5 mb-2',
      nameClass: 'font-bold uppercase',
      rowClass: 'text-[8px] text-gray-700 mt-0.5 space-y-0.5',
      usePipeSeparators: false,
      showGithub: true,
      trailingHr: false,
    },
    sectionGap: 'mb-2',
    sectionTitleClass: federalSectionTitle,
    sectionDivider: 'underline',
    summaryTitle: 'Summary of Qualifications',
    bodyText: 'text-gray-800 leading-relaxed',
    metaText: 'text-[8px] text-gray-600',
    experience: {
      unitGap: 'mb-2',
      titleClass: 'font-bold',
      companyJoiner: 'em-dash',
      bulletStyle: 'dash',
      bulletText: 'text-gray-800',
    },
    education: {
      unitGap: 'mb-1',
      titleClass: 'font-bold',
      mutedDegreeDetails: false,
      metaSeparator: ' | ',
    },
    skills: {
      sectionClassName: 'mb-2',
      headerClassName: federalSectionTitle,
      renderCategory: 'inline-colon',
      categoryTitleClass: 'font-semibold',
      categoryItemsClass: 'text-gray-800',
    },
    projects: {
      unitGap: 'mb-1',
      nameClass: 'font-bold',
      techStyle: 'parens',
      descriptionClass: 'text-gray-800',
      techParensClass: 'text-[8px] text-gray-600',
    },
    certifications: {
      unitGap: 'mb-0.5',
      nameClass: 'font-semibold',
      dateClass: 'text-gray-600',
    },
    custom: {
      contentClass: 'text-gray-800 whitespace-pre-wrap',
    },
  },
  'classic-navy': {
    layoutMode: 'standard',
    skillsTitle: 'Skills',
    sectionLabels: {
      experience: 'Experience',
      education: 'Education',
      projects: 'Projects',
      certifications: 'Certifications',
    },
    rootClass: 'text-gray-900 leading-snug',
    contact: {
      wrapperClass: 'text-center border-b-2 border-slate-900 pb-2 mb-3',
      nameClass: 'font-bold tracking-wide uppercase text-slate-900',
      rowClass: 'flex items-center justify-center gap-2 text-[8px] text-slate-600 mt-1 flex-wrap',
      usePipeSeparators: true,
      showGithub: false,
    },
    sectionGap: 'mb-3',
    sectionTitleClass: 'font-bold uppercase tracking-widest border-b border-slate-300 pb-0.5 mb-1',
    sectionDivider: 'underline',
    summaryTitle: 'Professional Summary',
    bodyText: 'text-slate-700 leading-relaxed',
    metaText: 'text-[8px] text-slate-500',
    experience: {
      unitGap: 'mb-2',
      titleClass: 'font-bold',
      companyJoiner: 'em-dash',
      bulletStyle: 'dot',
      bulletText: 'text-slate-700',
    },
    education: {
      unitGap: 'mb-1.5',
      titleClass: 'font-bold',
      mutedDegreeDetails: false,
      metaSeparator: ' | ',
    },
    skills: {
      headerClassName: 'font-bold uppercase tracking-widest border-b border-slate-300 pb-0.5 mb-1',
      renderCategory: 'inline-colon',
      categoryTitleClass: 'font-semibold',
      categoryItemsClass: 'text-slate-700',
    },
    projects: {
      unitGap: 'mb-1.5',
      nameClass: 'font-bold',
      techStyle: 'parens',
      descriptionClass: 'text-slate-700',
    },
    certifications: {
      unitGap: 'mb-0.5',
      nameClass: 'font-semibold',
    },
    custom: {
      contentClass: 'text-slate-700 whitespace-pre-wrap',
    },
  },
}

export function getClassicTheme(variantId: string): ClassicTheme {
  if (variantId in CLASSIC_THEMES) {
    return CLASSIC_THEMES[variantId as ClassicVariantId]
  }
  return CLASSIC_THEMES.professional
}
