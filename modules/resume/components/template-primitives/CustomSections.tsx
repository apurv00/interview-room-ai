import type { ResumeData } from '../../validators/resume'
import type { ClassicTheme } from '../../config/classicThemes'
import SectionBlock from './SectionBlock'

interface Props {
  sections: NonNullable<ResumeData['customSections']>
  theme: ClassicTheme
}

export default function CustomSections({ sections, theme }: Props) {
  return (
    <>
      {sections.map(section => (
        <SectionBlock
          key={section.id}
          sectionId={`custom-${section.id}`}
          title={section.title}
          theme={theme}
        >
          <p className={theme.custom.contentClass}>{section.content}</p>
        </SectionBlock>
      ))}
    </>
  )
}
