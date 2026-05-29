import type { ResumeData } from '../../validators/resume'
import type { ClassicTheme } from '../../config/classicThemes'
import SectionBlock from './SectionBlock'

interface Props {
  experience: NonNullable<ResumeData['experience']>
  theme: ClassicTheme
  sectionTitle?: string
}

export default function ExperienceSection({ experience, theme, sectionTitle }: Props) {
  const { experience: expTheme, metaText } = theme

  return (
    <SectionBlock sectionId="experience" title={sectionTitle ?? theme.sectionLabels.experience} theme={theme}>
      {experience.map(exp => (
        <div key={exp.id} className={expTheme.unitGap} data-resume-section-unit>
          <div className="flex justify-between items-baseline">
            <div>
              <span className={expTheme.titleClass}>{exp.title}</span>
              {exp.company && (
                expTheme.companyJoiner === 'at' ? (
                  <span className="text-gray-500"> at {exp.company}</span>
                ) : (
                  <span> — {exp.company}</span>
                )
              )}
            </div>
            <span className={`${metaText} shrink-0 ml-2`}>
              {exp.startDate} - {exp.endDate || 'Present'}
            </span>
          </div>
          {exp.location && <div className={metaText}>{exp.location}</div>}
          {exp.bullets.filter(b => b.trim()).length > 0 && (
            <ul className={expTheme.bulletStyle === 'dash' ? 'mt-1 space-y-1' : 'mt-0.5 space-y-0.5'}>
              {exp.bullets.filter(b => b.trim()).map((bullet, i) => (
                <li
                  key={i}
                  className={
                    expTheme.bulletStyle === 'dash'
                      ? `${expTheme.bulletText} pl-3 relative`
                      : `${expTheme.bulletText} flex items-start gap-1`
                  }
                >
                  {expTheme.bulletStyle === 'dash' ? (
                    <span className="absolute left-0 top-0">-</span>
                  ) : (
                    <span className="shrink-0 mt-[3px] w-1 h-1 bg-gray-400 rounded-full" />
                  )}
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
