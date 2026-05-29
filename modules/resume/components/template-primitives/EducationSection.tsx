import type { ResumeData } from '../../validators/resume'
import type { ClassicTheme } from '../../config/classicThemes'
import SectionBlock from './SectionBlock'

interface Props {
  education: NonNullable<ResumeData['education']>
  theme: ClassicTheme
  sectionTitle?: string
}

export default function EducationSection({ education, theme, sectionTitle }: Props) {
  const { education: eduTheme, metaText } = theme
  const detailClass = eduTheme.mutedDegreeDetails ? 'text-gray-500' : undefined

  return (
    <SectionBlock sectionId="education" title={sectionTitle ?? theme.sectionLabels.education} theme={theme}>
      {education.map(edu => (
        <div key={edu.id} className={eduTheme.unitGap} data-resume-section-unit>
          <div className="flex justify-between items-baseline">
            <div>
              <span className={eduTheme.titleClass}>{edu.degree}</span>
              {edu.field && (
                <span className={detailClass}> in {edu.field}</span>
              )}
              {edu.institution && (
                <span className={detailClass}> — {edu.institution}</span>
              )}
            </div>
            {edu.graduationDate && (
              <span className={`${metaText} shrink-0 ml-2`}>{edu.graduationDate}</span>
            )}
          </div>
          {(edu.gpa || edu.honors) && (
            <div className={`${metaText}${eduTheme.metaMarginTop ?? ''}`}>
              {edu.gpa && <span>GPA: {edu.gpa}</span>}
              {edu.gpa && edu.honors && <span>{eduTheme.metaSeparator}</span>}
              {edu.honors && <span>{edu.honors}</span>}
            </div>
          )}
        </div>
      ))}
    </SectionBlock>
  )
}
