import type { ResumeData } from '../../validators/resume'
import type { ClassicVariantId } from '../../config/classicThemes'
import { getClassicTheme } from '../../config/classicThemes'
import TemplateRoot from '../template-primitives/TemplateRoot'
import ClassicContactHeader from '../template-primitives/ClassicContactHeader'
import FederalContactHeader from '../template-primitives/FederalContactHeader'
import SectionBlock from '../template-primitives/SectionBlock'
import ExperienceSection from '../template-primitives/ExperienceSection'
import FederalExperienceSection from '../template-primitives/FederalExperienceSection'
import EducationSection from '../template-primitives/EducationSection'
import FederalEducationSection from '../template-primitives/FederalEducationSection'
import ClassicSkillsBlock from '../template-primitives/ClassicSkillsBlock'
import ProjectsSection from '../template-primitives/ProjectsSection'
import CertificationsSection from '../template-primitives/CertificationsSection'
import CustomSections from '../template-primitives/CustomSections'

interface Props {
  data: ResumeData
  variantId: ClassicVariantId
}

export default function ClassicLayout({ data, variantId }: Props) {
  const theme = getClassicTheme(variantId)
  const contact = data.contactInfo || { fullName: '', email: '' }
  const isFederal = theme.layoutMode === 'federal'

  return (
    <TemplateRoot className={theme.rootClass}>
      {isFederal ? (
        <FederalContactHeader contact={contact} theme={theme} />
      ) : (
        <ClassicContactHeader contact={contact} theme={theme} />
      )}

      {data.summary && (
        <SectionBlock sectionId="summary" title={theme.summaryTitle} theme={theme} hideDivider>
          <p className={theme.bodyText}>{data.summary}</p>
        </SectionBlock>
      )}

      {data.experience && data.experience.length > 0 && (
        isFederal ? (
          <FederalExperienceSection
            experience={data.experience}
            theme={theme}
            sectionTitle={theme.sectionLabels.experience}
          />
        ) : (
          <ExperienceSection experience={data.experience} theme={theme} />
        )
      )}

      {data.education && data.education.length > 0 && (
        isFederal ? (
          <FederalEducationSection
            education={data.education}
            theme={theme}
            sectionTitle={theme.sectionLabels.education}
          />
        ) : (
          <EducationSection education={data.education} theme={theme} />
        )
      )}

      {data.skills && data.skills.length > 0 && (
        <ClassicSkillsBlock skills={data.skills} theme={theme} />
      )}

      {data.projects && data.projects.length > 0 && (
        <ProjectsSection projects={data.projects} theme={theme} />
      )}

      {data.certifications && data.certifications.length > 0 && (
        <CertificationsSection certifications={data.certifications} theme={theme} />
      )}

      {data.customSections && data.customSections.length > 0 && (
        <CustomSections sections={data.customSections} theme={theme} />
      )}
    </TemplateRoot>
  )
}
