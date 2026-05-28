'use client'

import { useMemo, useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import type { ResumeData } from '../validators/resume'
import { getTemplate } from './templates'
import { getFontStack, getFontSizes, getCustomFontSizes, getGoogleFontUrl, DEFAULT_HEADING_SIZE, DEFAULT_BODY_SIZE } from '../config/fontConfig'
import { computePageLayoutPlan } from '../lib/resumePageBreaks'
import {
  measureResumeSections,
  readSkillsHeaderMetrics,
} from '../lib/measureResumeSections'
import { ResumePreviewPageProvider } from './ResumePreviewPageContext'
import {
  applySkillsTruncationToData,
  computeOmittedSkillCounts,
  computeSkillCategoryRatios,
  isFullSkillsMeasure,
  refineSkillRatiosIfStillOversized,
  skillsMatchTruncationRatios,
} from '../lib/skillCategoryTruncation'

// A4 at 72dpi: 595 × 842 px
const PAGE_WIDTH = 595
const PAGE_HEIGHT = 842
const PAGE_PADDING = 24

// ─── Component ──────────────────────────────────────────────────────────────

interface Props {
  data: ResumeData
  templateId?: string
}

export default function ResumePreview({ data, templateId = 'professional' }: Props) {
  const TemplateComponent = useMemo(() => getTemplate(templateId), [templateId])
  const [measureData, setMeasureData] = useState(data)
  const stableSkillRatiosRef = useRef<Record<number, number>>({})
  const contentRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [pageBreaks, setPageBreaks] = useState<number[]>([0])
  const [skillsContinuationHeader, setSkillsContinuationHeader] = useState<boolean[]>([false])
  const [truncatedSkillCategoryIndices, setTruncatedSkillCategoryIndices] = useState<number[]>([])
  const [truncatedSkillCategoryRatios, setTruncatedSkillCategoryRatios] = useState<Record<number, number>>({})
  const [truncatedSkillCategoryOmittedCounts, setTruncatedSkillCategoryOmittedCounts] = useState<Record<number, number>>({})
  const [skillsHeaderHeight, setSkillsHeaderHeight] = useState(0)
  const [skillsHeaderLeft, setSkillsHeaderLeft] = useState(0)
  const [skillsHeaderWidth, setSkillsHeaderWidth] = useState(0)
  const [skillsHeaderHtml, setSkillsHeaderHtml] = useState('<h2>Skills</h2>')
  const [skillsSectionTitle, setSkillsSectionTitle] = useState('Skills')
  const [scale, setScale] = useState(1)

  const fontFamily = data.styling?.fontFamily
  const fontSize = data.styling?.fontSize

  // Inject Google Font stylesheet when needed
  useEffect(() => {
    const url = getGoogleFontUrl(fontFamily)
    if (!url) return

    const linkId = `resume-font-${fontFamily}`
    if (document.getElementById(linkId)) return

    const link = document.createElement('link')
    link.id = linkId
    link.rel = 'stylesheet'
    link.href = url
    document.head.appendChild(link)

    return () => {
      const el = document.getElementById(linkId)
      if (el) el.remove()
    }
  }, [fontFamily])

  const headingSize = data.styling?.headingSize ?? DEFAULT_HEADING_SIZE
  const bodySize = data.styling?.bodySize ?? DEFAULT_BODY_SIZE
  const hasCustomSizes = data.styling?.headingSize != null || data.styling?.bodySize != null
  const sizes = hasCustomSizes ? getCustomFontSizes(headingSize, bodySize) : getFontSizes(fontSize)
  const wrapperStyle = {
    fontFamily: getFontStack(fontFamily),
    '--r-title': sizes.title,
    '--r-body': sizes.body,
    '--r-section': sizes.section,
    '--r-meta': sizes.meta,
  } as React.CSSProperties

  // Usable content area per page (inside padding)
  const contentWidth = PAGE_WIDTH - PAGE_PADDING * 2
  const contentHeight = PAGE_HEIGHT - PAGE_PADDING * 2

  useEffect(() => {
    stableSkillRatiosRef.current = {}
    setMeasureData(data)
  }, [data, templateId])

  // Convergent layout: ratios from full DOM only; refine by item count if truncated DOM is still tall.
  const measureLayout = useCallback(() => {
    if (contentRef.current) {
      const templateRoot = contentRef.current.firstElementChild as HTMLElement | null
      if (templateRoot) {
        const sections = measureResumeSections(templateRoot)
        const skillsSection = sections.find(section => section.kind === 'skills')
        const measuringFull = isFullSkillsMeasure(measureData.skills, data.skills)

        let ratios = stableSkillRatiosRef.current

        if (measuringFull && skillsSection?.kind === 'skills') {
          ratios = computeSkillCategoryRatios(skillsSection, contentHeight)
          stableSkillRatiosRef.current = ratios
        } else if (
          skillsSection?.kind === 'skills'
          && data.skills?.length
          && measureData.skills?.length
        ) {
          const refined = refineSkillRatiosIfStillOversized(
            skillsSection,
            contentHeight,
            ratios,
            data.skills,
            measureData.skills,
          )
          if (refined) {
            stableSkillRatiosRef.current = refined
            setMeasureData(applySkillsTruncationToData(data, refined))
            return
          }
        }

        const needsTruncation = Object.keys(ratios).length > 0
        const targetMeasureData = needsTruncation
          ? applySkillsTruncationToData(data, ratios)
          : data

        if (needsTruncation && !skillsMatchTruncationRatios(measureData.skills, ratios, data.skills)) {
          setMeasureData(targetMeasureData)
          return
        }

        if (!needsTruncation && !measuringFull) {
          setMeasureData(data)
          return
        }

        const plan = computePageLayoutPlan(sections, contentHeight)
        setPageBreaks(plan.breaks)
        setSkillsContinuationHeader(plan.skillsContinuationHeader)
        setTruncatedSkillCategoryIndices(plan.truncatedSkillCategoryIndices)
        setTruncatedSkillCategoryRatios(ratios)
        setTruncatedSkillCategoryOmittedCounts(
          computeOmittedSkillCounts(data.skills || [], ratios),
        )

        const metrics = readSkillsHeaderMetrics(templateRoot)
        setSkillsHeaderHeight(metrics.height)
        setSkillsHeaderLeft(metrics.left)
        setSkillsHeaderWidth(metrics.width || contentWidth)
        setSkillsHeaderHtml(metrics.html)
        setSkillsSectionTitle(metrics.title)
      }
    }
    if (containerRef.current) {
      setScale(containerRef.current.clientWidth / PAGE_WIDTH)
    }
  }, [contentHeight, contentWidth, data, measureData])

  useLayoutEffect(() => {
    measureLayout()
  }, [data, measureData, templateId, headingSize, bodySize, fontFamily, fontSize, measureLayout])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(() => measureLayout())
    observer.observe(el)
    return () => observer.disconnect()
  }, [measureLayout])

  const pageCount = pageBreaks.length
  const pages = Array.from({ length: pageCount }, (_, i) => i)

  return (
    <div className="space-y-2">
      {/* Page count indicator */}
      <div className="flex items-center justify-between">
        <span className={`text-[10px] font-medium ${pageCount > 1 ? 'text-amber-600' : 'text-[#059669]'}`}>
          {pageCount === 1 ? '1 page' : `${pageCount} pages`}
        </span>
        {pageCount > 1 && (
          <span className="text-[10px] text-amber-600/70">
            Reduce content to fit 1 page
          </span>
        )}
      </div>

      <div id="resume-preview-container" ref={containerRef}>
        {/* Hidden measurer — renders at exact content-area width to measure section positions */}
        <div
          aria-hidden
          style={{
            position: 'absolute',
            visibility: 'hidden',
            pointerEvents: 'none',
            width: contentWidth,
          }}
        >
          <div ref={contentRef} style={wrapperStyle}>
            <TemplateComponent data={measureData} />
          </div>
        </div>

        {/* Visible pages */}
        <div className="flex flex-col gap-3">
          {pages.map((pageIndex) => (
            <div key={pageIndex}>
              {/* Page number badge */}
              {pageCount > 1 && (
                <div className="flex justify-end mb-1">
                  <span className="text-[9px] text-slate-400">
                    Page {pageIndex + 1} of {pageCount}
                  </span>
                </div>
              )}
              {/* A4 page */}
              <div
                className="bg-white rounded-lg shadow-lg overflow-hidden"
                style={{
                  width: '100%',
                  height: PAGE_HEIGHT * scale,
                }}
              >
                {/* Scale transform: render at PAGE_WIDTH, scale down to container */}
                <div
                  className="overflow-hidden"
                  style={{
                    width: PAGE_WIDTH,
                    height: PAGE_HEIGHT,
                    transform: `scale(${scale})`,
                    transformOrigin: 'top left',
                  }}
                >
                  {/* Page padding — applied per page */}
                  <div style={{ padding: PAGE_PADDING }}>
                    {/* Content viewport — clips to usable area */}
                    <div
                      className="relative"
                      style={{
                        width: contentWidth,
                        height: contentHeight,
                        overflow: 'hidden',
                      }}
                    >
                      {skillsContinuationHeader[pageIndex] && (
                        <div
                          className="absolute z-10"
                          style={{
                            top: 0,
                            left: skillsHeaderLeft,
                            width: skillsHeaderWidth || contentWidth,
                            height: skillsHeaderHeight,
                          }}
                        >
                          <div
                            dangerouslySetInnerHTML={{ __html: skillsHeaderHtml || `<h2>${skillsSectionTitle}</h2>` }}
                          />
                        </div>
                      )}
                      <div
                        style={{
                          ...wrapperStyle,
                          width: contentWidth,
                          marginTop:
                            -pageBreaks[pageIndex] +
                            (skillsContinuationHeader[pageIndex] ? skillsHeaderHeight : 0),
                        }}
                      >
                        <ResumePreviewPageProvider
                          value={{
                            skillsContinuationHeader: skillsContinuationHeader[pageIndex] ?? false,
                            truncatedSkillCategoryIndices,
                            truncatedSkillCategoryRatios,
                            truncatedSkillCategoryOmittedCounts,
                          }}
                        >
                          <TemplateComponent data={data} />
                        </ResumePreviewPageProvider>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Page break indicator */}
              {pageIndex < pageCount - 1 && (
                <div className="flex items-center gap-2 mt-2 mb-1">
                  <div className="flex-1 border-t border-dashed border-red-500/30" />
                  <span className="text-[9px] text-red-400/60 shrink-0">page break</span>
                  <div className="flex-1 border-t border-dashed border-red-500/30" />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
