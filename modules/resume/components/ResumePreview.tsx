'use client'

import { useMemo, useEffect, useRef, useState, useCallback } from 'react'
import type { ResumeData } from '../validators/resume'
import { getTemplate } from './templates'
import { getFontStack, getFontSizes, getCustomFontSizes, getGoogleFontUrl, DEFAULT_HEADING_SIZE, DEFAULT_BODY_SIZE } from '../config/fontConfig'

// A4 at 72dpi: 595 × 842 px
const PAGE_WIDTH = 595
const PAGE_HEIGHT = 842
const PAGE_PADDING = 24

interface Props {
  data: ResumeData
  templateId?: string
}

export default function ResumePreview({ data, templateId = 'professional' }: Props) {
  const TemplateComponent = useMemo(() => getTemplate(templateId), [templateId])
  const contentRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [pageCount, setPageCount] = useState(1)
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

  const usableHeight = PAGE_HEIGHT - PAGE_PADDING * 2

  // Measure content height and container width
  const measure = useCallback(() => {
    if (contentRef.current) {
      const contentHeight = contentRef.current.scrollHeight
      setPageCount(Math.max(1, Math.ceil(contentHeight / usableHeight)))
    }
    if (containerRef.current) {
      const containerWidth = containerRef.current.clientWidth
      setScale(containerWidth / PAGE_WIDTH)
    }
  }, [usableHeight])

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
        {/* Hidden measurer at real page width */}
        <div
          aria-hidden
          style={{
            position: 'absolute',
            visibility: 'hidden',
            pointerEvents: 'none',
            width: PAGE_WIDTH,
            padding: PAGE_PADDING,
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
              <div
                className="bg-white rounded-lg shadow-lg overflow-hidden"
                style={{
                  width: '100%',
                  height: PAGE_HEIGHT * scale,
                }}
              >
                <div
                  className="overflow-hidden"
                  style={{
                    width: PAGE_WIDTH,
                    height: PAGE_HEIGHT,
                    transform: `scale(${scale})`,
                    transformOrigin: 'top left',
                  }}
                >
                  <div
                    style={{
                      ...wrapperStyle,
                      padding: PAGE_PADDING,
                      width: PAGE_WIDTH,
                      marginTop: -(pageIndex * usableHeight),
                    }}
                  >
                    <TemplateComponent data={data} />
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
