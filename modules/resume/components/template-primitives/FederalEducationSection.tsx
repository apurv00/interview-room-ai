import type { ResumeData } from '../../validators/resume'
import type { ClassicTheme } from '../../config/classicThemes'
import SectionBlock from './SectionBlock'

interface Props {
  education: NonNullable<ResumeData['education']>
  theme: ClassicTheme
  sectionTitle: string
}

export default function FederalEducationSection({ education, theme, sectionTitle }: Props) {
  const { metaText } = theme

  return (
    <SectionBlock sectionId="education" title={sectionTitle} theme={theme}>
      {education.map(edu => (
        <div key={edu.id} className="mb-1" data-resume-section-unit>
          <div>
            <span className="font-bold">{edu.degree}</span>
            {edu.field && <span> in {edu.field}</span>}
          </div>
          {edu.institution && <div>{edu.institution}</div>}
          {edu.graduationDate && (
            <div className={metaText}>Graduated: {edu.graduationDate}</div>
          )}
          {(edu.gpa || edu.honors) && (
            <div className={metaText}>
              {edu.gpa && <span>GPA: {edu.gpa}</span>}
              {edu.gpa && edu.honors && <span> | </span>}
              {edu.honors && <span>{edu.honors}</span>}
            </div>
          )}
        </div>
      ))}
    </SectionBlock>
  )
}
