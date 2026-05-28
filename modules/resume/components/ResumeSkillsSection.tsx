'use client'

import type { ReactNode } from 'react'
import type { ResumeData } from '../validators/resume'
import { useResumePreviewPage } from './ResumePreviewPageContext'

type SkillCategory = NonNullable<ResumeData['skills']>[number]

interface Props {
  skills: NonNullable<ResumeData['skills']>
  title: string
  sectionClassName?: string
  headerClassName?: string
  /** Override default &lt;h2&gt; (e.g. minimalist template adds an &lt;hr&gt;) */
  renderHeader?: () => ReactNode
  renderCategory: (cat: SkillCategory, index: number) => ReactNode
}

/**
 * Measurable Skills block for resume pagination.
 * Each category is a separate break unit; the header is measured independently.
 */
export default function ResumeSkillsSection({
  skills,
  title,
  sectionClassName = 'mb-3',
  headerClassName,
  renderHeader,
  renderCategory,
}: Props) {
  if (!skills.length) return null
  const previewPage = useResumePreviewPage()

  return (
    <div data-resume-section="skills" className={sectionClassName}>
      <div data-resume-skills-header={title}>
        {renderHeader ? renderHeader() : <h2 className={headerClassName}>{title}</h2>}
      </div>
      {skills.map((cat, index) => {
        const omittedCount = previewPage?.truncatedSkillCategoryOmittedCounts?.[index] ?? 0
        const shouldAnnotate = omittedCount > 0 && cat.items.includes('…')

        return (
        <div
          key={`${cat.category}-${index}`}
          data-resume-skills-category
          data-category-index={index}
        >
          {renderCategory(cat, index)}
          {shouldAnnotate && (
            <div className="text-[7px] text-slate-400 mt-0.5">
              +{omittedCount} more
            </div>
          )}
        </div>
        )
      })}
    </div>
  )
}
