'use client'

import { useMemo } from 'react'
import type { ResumeData } from '../validators/resume'
import { getTemplate } from './templates'

interface Props {
  data: ResumeData
  templateId?: string
}

export default function ResumePreview({ data, templateId = 'professional' }: Props) {
  const TemplateComponent = useMemo(() => getTemplate(templateId), [templateId])

  return (
    <div id="resume-preview-container" className="bg-white rounded-lg shadow-lg overflow-hidden" style={{ aspectRatio: '8.5/11' }}>
      <div className="p-6 h-full overflow-y-auto" style={{ transform: 'scale(1)', transformOrigin: 'top left' }}>
        <TemplateComponent data={data} />
      </div>
    </div>
  )
}
