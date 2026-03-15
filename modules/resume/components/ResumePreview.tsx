'use client'

import { useMemo, useEffect } from 'react'
import type { ResumeData } from '../validators/resume'
import { getTemplate } from './templates'
import { getFontStack, getFontSizes, getCustomFontSizes, getGoogleFontUrl, DEFAULT_HEADING_SIZE, DEFAULT_BODY_SIZE } from '../config/fontConfig'

interface Props {
  data: ResumeData
  templateId?: string
}

export default function ResumePreview({ data, templateId = 'professional' }: Props) {
  const TemplateComponent = useMemo(() => getTemplate(templateId), [templateId])

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

  return (
    <div id="resume-preview-container" className="bg-white rounded-lg shadow-lg overflow-hidden" style={{ aspectRatio: '8.5/11' }}>
      <div className="p-6 h-full overflow-y-auto" style={{ ...wrapperStyle, transform: 'scale(1)', transformOrigin: 'top left' }}>
        <TemplateComponent data={data} />
      </div>
    </div>
  )
}
