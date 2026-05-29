import type { ResumeData } from '../../validators/resume'
import type { ClassicTheme } from '../../config/classicThemes'
import SectionBlock from './SectionBlock'

interface Props {
  experience: NonNullable<ResumeData['experience']>
  theme: ClassicTheme
  sectionTitle: string
}

export default function FederalExperienceSection({ experience, theme, sectionTitle }: Props) {
  const { metaText } = theme

  return (
    <SectionBlock sectionId="experience" title={sectionTitle} theme={theme}>
      {experience.map(exp => (
        <div key={exp.id} className="mb-2" data-resume-section-unit>
          <div className="font-bold uppercase">{exp.title}</div>
          {exp.company && <div>{exp.company}</div>}
          {exp.location && <div className={metaText}>{exp.location}</div>}
          <div className={metaText}>
            {exp.startDate} - {exp.endDate || 'Present'} | Hours per week: 40
          </div>
          {exp.bullets.filter(b => b.trim()).length > 0 && (
            <ul className="mt-0.5 space-y-0.5">
              {exp.bullets.filter(b => b.trim()).map((bullet, i) => (
                <li key={i} className="text-gray-800 pl-3 relative">
                  <span className="absolute left-0 top-0">-</span>
                  <span>{bullet}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </SectionBlock>
  )
}
