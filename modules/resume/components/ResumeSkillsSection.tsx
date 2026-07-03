// IMPORTANT: this component must stay server-renderable. It is rendered via
// renderToStaticMarkup in the PDF/print path (services/pdfService.ts), so it
// must NOT be 'use client' and must NOT import any value from a 'use client'
// module — in the Next production build that turns it (or the hook) into a
// client *reference* that renderToStaticMarkup can't render ("Element type is
// invalid... got: undefined"), which silently broke PDF export for every resume.
// Truncation cues therefore arrive as a PROP (the preview passes its context
// value down) rather than via useContext. The `import type` below is erased at
// build time, so it creates no runtime dependency on the client context module.
import type { ReactNode } from 'react'
import type { ResumeData } from '../validators/resume'
import { omittedSkillItemCount, sliceSkillCategory } from '../lib/skillCategoryTruncation'
import type { ResumePreviewPageContextValue } from './ResumePreviewPageContext'

type SkillCategory = NonNullable<ResumeData['skills']>[number]

interface Props {
  skills: NonNullable<ResumeData['skills']>
  title: string
  sectionClassName?: string
  headerClassName?: string
  /** Override default &lt;h2&gt; (e.g. minimalist template adds an &lt;hr&gt;) */
  renderHeader?: () => ReactNode
  renderCategory: (cat: SkillCategory, index: number) => ReactNode
  /** Per-page truncation cues. Supplied by the preview; absent in the PDF/print
   *  render, where it safely defaults to "no truncation" (renders all items). */
  pageContext?: ResumePreviewPageContextValue
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
  pageContext,
}: Props) {
  const previewPage = pageContext
  const headerItemClassName = extractGridSpanClass(headerClassName)

  if (!skills.length) return null

  return (
    <div data-resume-section="skills" className={sectionClassName}>
      <div
        data-resume-skills-header={title}
        className={[headerItemClassName, 'pb-1'].filter(Boolean).join(' ')}
      >
        {renderHeader ? renderHeader() : <h2 className={headerClassName}>{title}</h2>}
      </div>
      {skills.map((cat, index) => {
        const ratio = previewPage?.truncatedSkillCategoryRatios?.[index] ?? 1
        // Prefer the count carried on the (already-truncated) DATA — it is the
        // only source that survives server rendering (renderToStaticMarkup can't
        // read the client pageContext). Fall back to the context / ratio for the
        // live preview's re-slice path.
        const dataOmitted = (cat as { omittedCount?: number }).omittedCount
        const omittedCount =
          dataOmitted
          ?? previewPage?.truncatedSkillCategoryOmittedCounts?.[index]
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
