// ─── Resume Font Configuration ──────────────────────────────────────────────

export interface FontFamily {
  id: string
  name: string
  stack: string
  google: string | false
}

export const FONT_FAMILIES: FontFamily[] = [
  { id: 'georgia', name: 'Georgia', stack: "'Georgia', 'Times New Roman', serif", google: false },
  { id: 'times', name: 'Times New Roman', stack: "'Times New Roman', 'Times', serif", google: false },
  { id: 'garamond', name: 'Garamond', stack: "'EB Garamond', 'Garamond', serif", google: 'EB+Garamond' },
  { id: 'palatino', name: 'Palatino', stack: "'Palatino Linotype', 'Palatino', serif", google: false },
  { id: 'calibri', name: 'Calibri', stack: "'Carlito', 'Calibri', sans-serif", google: 'Carlito' },
  { id: 'helvetica', name: 'Helvetica', stack: "'Helvetica Neue', 'Helvetica', 'Arial', sans-serif", google: false },
  { id: 'lato', name: 'Lato', stack: "'Lato', 'Helvetica', sans-serif", google: 'Lato' },
  { id: 'roboto', name: 'Roboto', stack: "'Roboto', 'Arial', sans-serif", google: 'Roboto' },
]

export interface FontSizePreset {
  body: string
  title: string
  section: string
  meta: string
  bodyPt: string
  titlePt: string
  sectionPt: string
  metaPt: string
}

export const FONT_SIZES: Record<string, FontSizePreset> = {
  small:  { body: '8.5px', title: '15px', section: '8.5px', meta: '7px',  bodyPt: '8.5pt', titlePt: '15pt', sectionPt: '8.5pt', metaPt: '7pt' },
  medium: { body: '9px',   title: '18px', section: '9px',   meta: '8px',  bodyPt: '9pt',   titlePt: '18pt', sectionPt: '9pt',   metaPt: '8pt' },
  large:  { body: '10px',  title: '20px', section: '10px',  meta: '8.5px', bodyPt: '10pt',  titlePt: '20pt', sectionPt: '10pt',  metaPt: '8.5pt' },
}

export function getFontStack(fontId?: string): string {
  const font = FONT_FAMILIES.find(f => f.id === fontId)
  return font?.stack || FONT_FAMILIES[0].stack
}

export function getGoogleFontUrl(fontId?: string): string | null {
  const font = FONT_FAMILIES.find(f => f.id === fontId)
  if (!font?.google) return null
  return `https://fonts.googleapis.com/css2?family=${font.google}:wght@400;600;700&display=swap`
}

export function getFontSizes(preset?: string): FontSizePreset {
  return FONT_SIZES[preset || 'medium'] || FONT_SIZES.medium
}

/** Build font sizes from custom numeric heading/body values */
export function getCustomFontSizes(headingSize: number, bodySize: number): FontSizePreset {
  const metaSize = Math.max(7, bodySize - 1)
  return {
    title: `${headingSize}px`,
    body: `${bodySize}px`,
    section: `${bodySize}px`,
    meta: `${metaSize}px`,
    titlePt: `${headingSize}pt`,
    bodyPt: `${bodySize}pt`,
    sectionPt: `${bodySize}pt`,
    metaPt: `${metaSize}pt`,
  }
}

export const DEFAULT_HEADING_SIZE = 18
export const DEFAULT_BODY_SIZE = 9
