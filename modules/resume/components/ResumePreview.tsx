'use client'

import { useMemo, useEffect, useRef, useState, useCallback } from 'react'
import type { ResumeData } from '../validators/resume'
import { getTemplate } from './templates'
import { getFontStack, getFontSizes, getCustomFontSizes, getGoogleFontUrl, DEFAULT_HEADING_SIZE, DEFAULT_BODY_SIZE } from '../config/fontConfig'

// A4 at 72dpi: 595 × 842 px
const PAGE_WIDTH = 595
const PAGE_HEIGHT = 842
const PAGE_PADDING = 24

// ─── Section-aware page break algorithm ─────────────────────────────────────
// Simulates CSS break-inside:avoid by measuring each top-level section's
// position and pushing sections that don't fit entirely to the next page.

interface ChildMeasurement {
  offsetTop: number
  offsetHeight: number
}

function computePageBreaks(children: ChildMeasurement[], pageHeight: number): number[] {
  if (children.length === 0) return [0]

  const breaks: number[] = [0] // Page 1 always starts at offset 0
  let currentPageStart = 0

  for (const child of children) {
    const childBottom = child.offsetTop + child.offsetHeight
    const currentPageBottom = currentPageStart + pageHeight

    // Child fits entirely within current page — no break needed
    if (childBottom <= currentPageBottom) continue

    // Child is taller than a full page — let it start fresh, then
    // add breaks at pageHeight intervals (unavoidable split)
    if (child.offsetHeight > pageHeight) {
      if (child.offsetTop > currentPageStart) {
        currentPageStart = child.offsetTop
        breaks.push(child.offsetTop)
      }
      let next = currentPageStart + pageHeight
      while (next < childBottom) {
        breaks.push(next)
        currentPageStart = next
        next += pageHeight
      }
      continue
    }

    // Normal child that doesn't fit — push entire section to next page
    // This leaves whitespace at the bottom of the current page (correct behavior)
    currentPageStart = child.offsetTop
    breaks.push(child.offsetTop)
  }

  return breaks
}

// ─── Component ──────────────────────────────────────────────────────────────

interface Props {
  data: ResumeData
  templateId?: string
}

export default function ResumePreview({ data, templateId = 'professional' }: Props) {
  const TemplateComponent = useMemo(() => getTemplate(templateId), [templateId])
  const contentRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [pageBreaks, setPageBreaks] = useState<number[]>([0])
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

  // Measure section positions and compute natural page breaks
  const measure = useCallback(() => {
    if (contentRef.current) {
      const children = Array.from(contentRef.current.children) as HTMLElement[]
      const measurements: ChildMeasurement[] = children.map(child => ({
        offsetTop: child.offsetTop,
        offsetHeight: child.offsetHeight,
      }))
      setPageBreaks(computePageBreaks(measurements, contentHeight))
    }
    if (containerRef.current) {
      setScale(containerRef.current.clientWidth / PAGE_WIDTH)
    }
  }, [contentHeight])

  useEffect(() => {
    measure()
  }, [data, templateId, headingSize, bodySize, fontFamily, fontSize, measure])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(() => measure())
    observer.observe(el)
    return () => observer.disconnect()
  }, [measure])

  const pageCount = pageBreaks.length
  const pages = Array.from({ length: pageCount }, (_, i) => i)

  return (
    <div className="space-y-2">
      {/* Page count indicator */}
      <div className="flex items-center justify-between">
        <span className={`text-[10px] font-medium ${pageCount > 1 ? 'text-amber-400' : 'text-emerald-400'}`}>
          {pageCount === 1 ? '1 page' : `${pageCount} pages`}
        </span>
        {pageCount > 1 && (
          <span className="text-[10px] text-amber-400/70">
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
            <TemplateComponent data={data} />
          </div>
        </div>

        {/* Visible pages */}
        <div className="flex flex-col gap-3">
          {pages.map((pageIndex) => (
            <div key={pageIndex}>
              {/* Page number badge */}
              {pageCount > 1 && (
                <div className="flex justify-end mb-1">
                  <span className="text-[9px] text-slate-500">
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
                      style={{
                        width: contentWidth,
                        height: contentHeight,
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          ...wrapperStyle,
                          width: contentWidth,
                          // Shift content to the break position for this page
                          marginTop: -pageBreaks[pageIndex],
                        }}
                      >
                        <TemplateComponent data={data} />
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
