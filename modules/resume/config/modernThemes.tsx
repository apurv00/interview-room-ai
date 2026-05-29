import type { ClassicTheme } from './classicThemes'

/**
 * Modern family — single-column, but visually distinct from Classic: a filled
 * accent header band (name reversed-out) and left-accent-bar section titles.
 *
 * Themes are ClassicTheme-shaped so the family reuses every shared section
 * primitive (ContactHeader, SectionBlock, Experience/Education/... lists). The
 * three variants are produced by one factory so they are geometry-identical and
 * differ only in accent color — a single parity baseline covers all three.
 */

export type ModernVariantId = 'modern-indigo' | 'modern-emerald' | 'modern-rose'

interface ModernAccent {
  /** background utility for the header band, e.g. 'bg-indigo-600' */
  band: string
  /** text-color utility for section titles, e.g. 'text-indigo-700' */
  titleText: string
  /** border-color utility for the section-title accent bar, e.g. 'border-indigo-500' */
  titleBar: string
}

function makeModernTheme(accent: ModernAccent): ClassicTheme {
  const sectionTitleClass = `font-bold uppercase tracking-wide ${accent.titleText} border-l-4 ${accent.titleBar} pl-2 mb-1`
  return {
    layoutMode: 'standard',
    rootClass: 'text-gray-900 leading-snug',
    skillsTitle: 'Skills',
    sectionLabels: {
      experience: 'Experience',
      education: 'Education',
      projects: 'Projects',
      certifications: 'Certifications',
    },
    contact: {
      wrapperClass: `${accent.band} text-white rounded-md p-3 mb-3`,
      nameClass: 'font-bold tracking-wide text-white',
      rowClass: 'flex items-center gap-2 text-[8px] text-white/85 mt-1 flex-wrap',
      usePipeSeparators: true,
      showGithub: true,
    },
    sectionGap: 'mb-3',
    sectionTitleClass,
    sectionDivider: 'underline',
    summaryTitle: 'Summary',
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
      headerClassName: sectionTitleClass,
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
  }
}

export const MODERN_THEMES: Record<ModernVariantId, ClassicTheme> = {
  'modern-indigo': makeModernTheme({ band: 'bg-indigo-600', titleText: 'text-indigo-700', titleBar: 'border-indigo-500' }),
  'modern-emerald': makeModernTheme({ band: 'bg-emerald-600', titleText: 'text-emerald-700', titleBar: 'border-emerald-500' }),
  'modern-rose': makeModernTheme({ band: 'bg-rose-600', titleText: 'text-rose-700', titleBar: 'border-rose-500' }),
}

export function getModernTheme(variantId: string): ClassicTheme {
  return MODERN_THEMES[variantId as ModernVariantId] ?? MODERN_THEMES['modern-indigo']
}
