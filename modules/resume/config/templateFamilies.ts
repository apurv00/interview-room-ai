export type ResumeTemplateFamilyId =
  | 'classic'
  | 'modern'
  | 'technical'
  | 'sidebar'
  | 'executive'
  | 'early-career'
  | 'career-change'

export interface TemplateFamilyConfig {
  id: ResumeTemplateFamilyId
  label: string
  description: string
}

export interface TemplateVariantConfig {
  id: string
  familyId: ResumeTemplateFamilyId
  variantLabel: string
  isLegacyTemplateId: boolean
}

export const TEMPLATE_FAMILIES: TemplateFamilyConfig[] = [
  {
    id: 'classic',
    label: 'Classic',
    description: 'Single-column, corporate-first layouts.',
  },
  {
    id: 'modern',
    label: 'Modern',
    description: 'Single-column with an accent header band and bold section bars.',
  },
  {
    id: 'technical',
    label: 'Technical',
    description: 'Skills-forward layouts for engineering roles.',
  },
  {
    id: 'sidebar',
    label: 'Sidebar',
    description: 'Two-column layouts with an atomic sidebar region.',
  },
  {
    id: 'executive',
    label: 'Executive',
    description: 'Leadership and impact-forward layouts.',
  },
  {
    id: 'early-career',
    label: 'Early Career',
    description: 'Education/projects-focused graduate layouts.',
  },
  {
    id: 'career-change',
    label: 'Career Change',
    description: 'Transferable-skills-focused layouts.',
  },
]

/**
 * Phase 1 bootstrap map.
 *
 * These are the current template IDs already persisted in user resumes.
 * Keep them stable while we migrate rendering to family composers.
 */
export const TEMPLATE_VARIANTS: Record<string, TemplateVariantConfig> = {
  professional: {
    id: 'professional',
    familyId: 'classic',
    variantLabel: 'Professional',
    isLegacyTemplateId: true,
  },
  'classic-navy': {
    id: 'classic-navy',
    familyId: 'classic',
    variantLabel: 'Classic Navy',
    isLegacyTemplateId: false,
  },
  'modern-indigo': {
    id: 'modern-indigo',
    familyId: 'modern',
    variantLabel: 'Modern Indigo',
    isLegacyTemplateId: false,
  },
  'modern-emerald': {
    id: 'modern-emerald',
    familyId: 'modern',
    variantLabel: 'Modern Emerald',
    isLegacyTemplateId: false,
  },
  'modern-rose': {
    id: 'modern-rose',
    familyId: 'modern',
    variantLabel: 'Modern Rose',
    isLegacyTemplateId: false,
  },
  technical: {
    id: 'technical',
    familyId: 'technical',
    variantLabel: 'Technical',
    isLegacyTemplateId: true,
  },
  creative: {
    id: 'creative',
    familyId: 'sidebar',
    variantLabel: 'Creative',
    isLegacyTemplateId: true,
  },
  'sidebar-slate': {
    id: 'sidebar-slate',
    familyId: 'sidebar',
    variantLabel: 'Sidebar Slate',
    isLegacyTemplateId: false,
  },
  executive: {
    id: 'executive',
    familyId: 'executive',
    variantLabel: 'Executive',
    isLegacyTemplateId: true,
  },
  'career-change': {
    id: 'career-change',
    familyId: 'career-change',
    variantLabel: 'Career Change',
    isLegacyTemplateId: true,
  },
  'entry-level': {
    id: 'entry-level',
    familyId: 'early-career',
    variantLabel: 'Entry Level',
    isLegacyTemplateId: true,
  },
  minimalist: {
    id: 'minimalist',
    familyId: 'classic',
    variantLabel: 'Minimalist',
    isLegacyTemplateId: true,
  },
  academic: {
    id: 'academic',
    familyId: 'early-career',
    variantLabel: 'Academic',
    isLegacyTemplateId: true,
  },
  federal: {
    id: 'federal',
    familyId: 'classic',
    variantLabel: 'Federal',
    isLegacyTemplateId: true,
  },
  startup: {
    id: 'startup',
    familyId: 'technical',
    variantLabel: 'Startup',
    isLegacyTemplateId: true,
  },
  'technical-slate': {
    id: 'technical-slate',
    familyId: 'technical',
    variantLabel: 'Technical Slate',
    isLegacyTemplateId: false,
  },
  'sidebar-violet': {
    id: 'sidebar-violet',
    familyId: 'sidebar',
    variantLabel: 'Sidebar Violet',
    isLegacyTemplateId: false,
  },
  'executive-gold': {
    id: 'executive-gold',
    familyId: 'executive',
    variantLabel: 'Executive Gold',
    isLegacyTemplateId: false,
  },
}

export function getTemplateFamilyConfig(templateId: string): TemplateFamilyConfig | null {
  const variant = TEMPLATE_VARIANTS[templateId]
  if (!variant) return null
  return TEMPLATE_FAMILIES.find(family => family.id === variant.familyId) ?? null
}
