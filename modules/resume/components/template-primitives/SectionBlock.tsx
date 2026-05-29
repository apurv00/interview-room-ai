import type { ReactNode } from 'react'
import type { ClassicTheme } from '../../config/classicThemes'

interface Props {
  sectionId: string
  title: string
  theme: ClassicTheme
  children: ReactNode
}

export default function SectionBlock({ sectionId, title, theme, children }: Props) {
  return (
    <div className={theme.sectionGap} data-resume-section={sectionId}>
      <h2 data-resume-section-header={title} className={theme.sectionTitleClass}>
        {title}
      </h2>
      {theme.sectionDivider === 'hr-below' ? (
        <hr className="border-t border-gray-100 mb-2" />
      ) : null}
      {children}
    </div>
  )
}
