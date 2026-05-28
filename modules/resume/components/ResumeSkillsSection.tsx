'use client'

import type { ReactNode } from 'react'
import type { ResumeData } from '../validators/resume'
import { omittedSkillItemCount, sliceSkillCategory } from '../lib/skillCategoryTruncation'
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

function extractGridSpanClass(className?: string): string | undefined {
  if (!className) return undefined
  const spans = className
    .split(/\s+/)
    .filter(token => token.startsWith('col-span-') || token.startsWith('md:col-span-') || token.startsWith('lg:col-span-'))
  return spans.length > 0 ? spans.join(' ') : undefined
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
  const previewPage = useResumePreviewPage()
  const headerItemClassName = extractGridSpanClass(headerClassName)

  if (!skills.length) return null

  return (
    <div data-resume-section="skills" className={sectionClassName}>
      <div data-resume-skills-header={title} className={headerItemClassName}>
        {renderHeader ? renderHeader() : <h2 className={headerClassName}>{title}</h2>}
      </div>
      {skills.map((cat, index) => {
        const ratio = previewPage?.truncatedSkillCategoryRatios?.[index] ?? 1
        const omittedCount =
          previewPage?.truncatedSkillCategoryOmittedCounts?.[index]
          ?? omittedSkillItemCount(cat.items.length, ratio)
        // Re-slice the items only when a ratio < 1 is supplied (visible pages
        // and PDF export). The hidden measurer passes already-truncated items
        // with ratio = 1 plus a real omitted count, so it must render the same
        // "+N more" row WITHOUT slicing again — otherwise the measured
        // coordinate space is shorter than what is actually rendered and breaks
        // can clip/duplicate content (Codex r3320046388 / r3319666174).
        const renderedCat = ratio < 1 ? sliceSkillCategory(cat, ratio) : cat
        const shouldAnnotate = omittedCount > 0

        return (
        <div
          key={`${cat.category}-${index}`}
          data-resume-section-unit
          data-resume-skills-category
          data-category-index={index}
        >
          {renderCategory(renderedCat, index)}
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
