import type { ResumeData } from '../../validators/resume'
import type { ClassicTheme } from '../../config/classicThemes'
import ResumeSkillsSection from '../ResumeSkillsSection'

interface Props {
  skills: NonNullable<ResumeData['skills']>
  theme: ClassicTheme
  title?: string
}

export default function ClassicSkillsBlock({ skills, theme, title }: Props) {
  const { skills: skillsTheme } = theme

  return (
    <ResumeSkillsSection
      skills={skills}
      title={title ?? theme.skillsTitle}
      sectionClassName={skillsTheme.sectionClassName}
      headerClassName={skillsTheme.headerClassName}
      renderHeader={skillsTheme.renderHeader}
      renderCategory={(cat) =>
        skillsTheme.renderCategory === 'inline-colon' ? (
          <div className="mb-0.5">
            <span className={skillsTheme.categoryTitleClass}>{cat.category}:</span>{' '}
            <span className={skillsTheme.categoryItemsClass}>{cat.items.join(', ')}</span>
          </div>
        ) : (
          <div className="mb-1">
            <span className={skillsTheme.categoryTitleClass}>{cat.category}</span>
            <span className={skillsTheme.categoryItemsClass}>{cat.items.join(', ')}</span>
          </div>
        )
      }
    />
  )
}
