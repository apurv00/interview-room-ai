import type { ComponentType } from 'react'
import type { ResumeData } from '../../validators/resume'
import ProfessionalTemplate from './ProfessionalTemplate'
import TechnicalTemplate from './TechnicalTemplate'
import CreativeTemplate from './CreativeTemplate'
import ExecutiveTemplate from './ExecutiveTemplate'
import CareerChangeTemplate from './CareerChangeTemplate'
import EntryLevelTemplate from './EntryLevelTemplate'
import MinimalistTemplate from './MinimalistTemplate'
import AcademicTemplate from './AcademicTemplate'
import FederalTemplate from './FederalTemplate'
import StartupTemplate from './StartupTemplate'

export interface TemplateProps {
  data: ResumeData
}

export const TEMPLATE_REGISTRY: Record<string, ComponentType<TemplateProps>> = {
  professional: ProfessionalTemplate,
  technical: TechnicalTemplate,
  creative: CreativeTemplate,
  executive: ExecutiveTemplate,
  'career-change': CareerChangeTemplate,
  'entry-level': EntryLevelTemplate,
  minimalist: MinimalistTemplate,
  academic: AcademicTemplate,
  federal: FederalTemplate,
  startup: StartupTemplate,
}

export function getTemplate(id: string): ComponentType<TemplateProps> {
  return TEMPLATE_REGISTRY[id] || ProfessionalTemplate
}
