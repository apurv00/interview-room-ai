import type { ResumeData } from '../../validators/resume'
import type { ClassicTheme } from '../../config/classicThemes'
import SectionBlock from './SectionBlock'

interface Props {
  projects: NonNullable<ResumeData['projects']>
  theme: ClassicTheme
  sectionTitle?: string
}

export default function ProjectsSection({ projects, theme, sectionTitle }: Props) {
  const { projects: projTheme } = theme

  return (
    <SectionBlock sectionId="projects" title={sectionTitle ?? theme.sectionLabels.projects} theme={theme}>
      {projects.map(proj => (
        <div key={proj.id} className={projTheme.unitGap} data-resume-section-unit>
          <span className={projTheme.nameClass}>{proj.name}</span>
          {proj.technologies?.length ? (
            projTheme.techStyle === 'parens' ? (
              <span className="text-[8px] text-gray-500"> ({proj.technologies.join(', ')})</span>
            ) : (
              <span className="text-[8px] text-gray-400 ml-1">{proj.technologies.join(', ')}</span>
            )
          ) : null}
          <p className={projTheme.descriptionClass}>{proj.description}</p>
        </div>
      ))}
    </SectionBlock>
  )
}
