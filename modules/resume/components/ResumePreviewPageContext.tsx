'use client'

import { createContext, useContext } from 'react'

export interface ResumePreviewPageContextValue {
  /** When true, show a duplicate Skills heading at the top of the page viewport */
  skillsContinuationHeader: boolean
  /** Category indices that were truncated to avoid splitting text across pages */
  truncatedSkillCategoryIndices: number[]
  /** Height ratio (0..1) for categories that must be truncated */
  truncatedSkillCategoryRatios: Record<number, number>
  /** Number of omitted items per skills category index (preview-only cue). */
  truncatedSkillCategoryOmittedCounts: Record<number, number>
}

const ResumePreviewPageContext = createContext<ResumePreviewPageContextValue | null>(null)

export function ResumePreviewPageProvider({
  value,
  children,
}: {
  value: ResumePreviewPageContextValue
  children: React.ReactNode
}) {
  return (
    <ResumePreviewPageContext.Provider value={value}>
      {children}
    </ResumePreviewPageContext.Provider>
  )
}

export function useResumePreviewPage(): ResumePreviewPageContextValue | null {
  return useContext(ResumePreviewPageContext)
}
