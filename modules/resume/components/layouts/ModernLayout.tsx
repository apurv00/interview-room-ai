import { Fragment, type ReactNode } from 'react'
import type { ResumeData } from '../../validators/resume'
import type { ModernVariantId } from '../../config/modernThemes'
import { getModernTheme } from '../../config/modernThemes'
import { CLASSIC_ORDER, resolveSectionOrder, type BodySectionId } from '../../config/sectionOrders'
import TemplateRoot from '../template-primitives/TemplateRoot'
import ClassicContactHeader from '../template-primitives/ClassicContactHeader'
import SectionBlock from '../template-primitives/SectionBlock'
import ExperienceSection from '../template-primitives/ExperienceSection'
import EducationSection from '../template-primitives/EducationSection'
import ClassicSkillsBlock from '../template-primitives/ClassicSkillsBlock'
import ProjectsSection from '../template-primitives/ProjectsSection'
import CertificationsSection from '../template-primitives/CertificationsSection'
import CustomSections from '../template-primitives/CustomSections'

interface Props {
  data: ResumeData
  variantId: ModernVariantId
}

/**
 * Modern family layout. Single-column like Classic, so it reuses every shared
 * section primitive and the standard section order — the distinct look (accent
 * header band + left-bar section titles) is entirely in the theme.
 */
export default function ModernLayout({ data, variantId }: Props) {
  const theme = getModernTheme(variantId)
  const contact = data.contactInfo || { fullName: '', email: '' }

  const blocks: Partial<Record<BodySectionId, ReactNode>> = {
    summary: data.summary ? (
      <SectionBlock sectionId="summary" title={theme.summaryTitle} theme={theme}>
        <p className={theme.bodyText}>{data.summary}</p>
      </SectionBlock>
    ) : undefined,
    experience:
      data.experience && data.experience.length > 0
        ? <ExperienceSection experience={data.experience} theme={theme} />
        : undefined,
    education:
      data.education && data.education.length > 0
        ? <EducationSection education={data.education} theme={theme} />
        : undefined,
    skills:
      data.skills && data.skills.length > 0
        ? <ClassicSkillsBlock skills={data.skills} theme={theme} />
        : undefined,
    projects:
      data.projects && data.projects.length > 0
        ? <ProjectsSection projects={data.projects} theme={theme} />
        : undefined,
    certifications:
      data.certifications && data.certifications.length > 0
        ? <CertificationsSection certifications={data.certifications} theme={theme} />
        : undefined,
    customSections:
      data.customSections && data.customSections.length > 0
        ? <CustomSections sections={data.customSections} theme={theme} />
        : undefined,
  }

  const order = resolveSectionOrder(data.sectionOrder, CLASSIC_ORDER)

  return (
    <TemplateRoot className={theme.rootClass}>
      <ClassicContactHeader contact={contact} theme={theme} />
      {order.map(id => (blocks[id] ? <Fragment key={id}>{blocks[id]}</Fragment> : null))}
    </TemplateRoot>
  )
}
