import type { ComponentType } from 'react'
import type { ResumeData } from '../../validators/resume'
import ProfessionalTemplate from './ProfessionalTemplate'
import ClassicNavyTemplate from './ClassicNavyTemplate'
import ModernIndigoTemplate from './ModernIndigoTemplate'
import ModernEmeraldTemplate from './ModernEmeraldTemplate'
import ModernRoseTemplate from './ModernRoseTemplate'
import TechnicalTemplate from './TechnicalTemplate'
import CreativeTemplate from './CreativeTemplate'
import SidebarSlateTemplate from './SidebarSlateTemplate'
import ExecutiveTemplate from './ExecutiveTemplate'
import CareerChangeTemplate from './CareerChangeTemplate'
import EntryLevelTemplate from './EntryLevelTemplate'
import MinimalistTemplate from './MinimalistTemplate'
import AcademicTemplate from './AcademicTemplate'
import FederalTemplate from './FederalTemplate'
import StartupTemplate from './StartupTemplate'
import ExecutiveGoldTemplate from './ExecutiveGoldTemplate'
import TechnicalSlateTemplate from './TechnicalSlateTemplate'
import SidebarVioletTemplate from './SidebarVioletTemplate'
import EarlyCareerTealTemplate from './EarlyCareerTealTemplate'
import CareerChangeEmeraldTemplate from './CareerChangeEmeraldTemplate'

export interface TemplateProps {
  data: ResumeData
}

export const TEMPLATE_REGISTRY: Record<string, ComponentType<TemplateProps>> = {
  professional: ProfessionalTemplate,
  'classic-navy': ClassicNavyTemplate,
  'modern-indigo': ModernIndigoTemplate,
  'modern-emerald': ModernEmeraldTemplate,
  'modern-rose': ModernRoseTemplate,
  technical: TechnicalTemplate,
  'technical-slate': TechnicalSlateTemplate,
  creative: CreativeTemplate,
  'sidebar-slate': SidebarSlateTemplate,
  'sidebar-violet': SidebarVioletTemplate,
  executive: ExecutiveTemplate,
  'executive-gold': ExecutiveGoldTemplate,
  'career-change': CareerChangeTemplate,
  'career-change-emerald': CareerChangeEmeraldTemplate,
  'entry-level': EntryLevelTemplate,
  'early-career-teal': EarlyCareerTealTemplate,
  minimalist: MinimalistTemplate,
  academic: AcademicTemplate,
  federal: FederalTemplate,
  startup: StartupTemplate,
}

export function getTemplate(id: string): ComponentType<TemplateProps> {
  return TEMPLATE_REGISTRY[id] || ProfessionalTemplate
}
