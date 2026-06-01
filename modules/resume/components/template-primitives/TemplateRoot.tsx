import type { ReactNode } from 'react'

interface Props {
  className: string
  children: ReactNode
}

export default function TemplateRoot({ className, children }: Props) {
  return (
    <div className={className} style={{ fontSize: 'var(--r-body, 9px)' }}>
      {/* Padding-based gap below section underlines — margin-bottom on h2 collapses
          with the first body unit in several templates, pulling content into the
          border band (previewBuilderGap e2e: gapToMarginPx ≈ -0.2 on direct h2). */}
      <style
        dangerouslySetInnerHTML={{
          __html: `[data-resume-section-header],[data-resume-skills-header] h2{margin-bottom:0!important;padding-bottom:0.375rem}[data-resume-section]>[data-resume-section-header]+*,[data-resume-skills-header]+[data-resume-section-unit]{margin-top:0.375rem}`,
        }}
      />
      {children}
    </div>
  )
}
