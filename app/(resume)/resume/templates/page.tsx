'use client'

import { useState } from 'react'
import Link from 'next/link'
import { RESUME_TEMPLATES, TEMPLATE_COLOR_MAP, SAMPLE_RESUME_DATA } from '@resume/config/templates'
import ResumePreview from '@resume/components/ResumePreview'
import type { ResumeData } from '@resume/validators/resume'

export default function ResumeTemplatesPage() {
  const [selectedId, setSelectedId] = useState(RESUME_TEMPLATES[0].id)
  const selected = RESUME_TEMPLATES.find(t => t.id === selectedId) || RESUME_TEMPLATES[0]
  const colors = TEMPLATE_COLOR_MAP[selected.color] || TEMPLATE_COLOR_MAP.blue

  const sampleData: ResumeData = {
    ...SAMPLE_RESUME_DATA,
    template: selectedId,
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#0f1419]">Resume Templates</h1>
        <p className="text-sm text-[#536471] mt-1">
          Choose a template that matches your career stage and industry. Click any template to preview it.
        </p>
      </div>

      <div className="flex gap-6">
        {/* Template list - left side */}
        <div className="w-[340px] shrink-0 space-y-2 overflow-y-auto max-h-[calc(100vh-180px)] pr-1">
          {RESUME_TEMPLATES.map(t => {
            const tColors = TEMPLATE_COLOR_MAP[t.color] || TEMPLATE_COLOR_MAP.blue
            const isSelected = t.id === selectedId
            return (
              <button
                key={t.id}
                onClick={() => setSelectedId(t.id)}
                className={`w-full text-left p-4 rounded-xl border transition-all ${
                  isSelected
                    ? `bg-[#f8fafc] border-emerald-500/40 ring-1 ring-emerald-500/20`
                    : 'bg-white border-[#e1e8ed] hover:border-[#536471]'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <h3 className={`text-sm font-semibold ${isSelected ? 'text-emerald-600' : 'text-[#0f1419]'}`}>
                    {t.name}
                  </h3>
                  <span className={`px-2 py-0.5 rounded-full text-[9px] font-semibold ${tColors.bg} border ${tColors.border} ${tColors.text}`}>
                    {t.industries[0]}
                  </span>
                </div>
                <p className="text-[11px] text-[#536471] leading-relaxed">{t.desc}</p>
                <div className="flex flex-wrap gap-1 mt-2">
                  {t.sections.slice(0, 4).map(s => (
                    <span key={s} className="px-1.5 py-0.5 bg-[#f8fafc] rounded text-[9px] text-[#71767b]">
                      {s}
                    </span>
                  ))}
                </div>
              </button>
            )
          })}
        </div>

        {/* Preview - right side */}
        <div className="flex-1 min-w-0">
          <div className="sticky top-4">
            {/* Template info header */}
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-semibold text-[#0f1419]">{selected.name}</h2>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${colors.bg} border ${colors.border} ${colors.text}`}>
                  {selected.industries.join(', ')}
                </span>
              </div>
              <Link
                href={`/resume/builder?template=${selected.id}`}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm rounded-xl font-medium transition-colors"
              >
                Use This Template
              </Link>
            </div>

            {/* Live preview */}
            <div className="max-w-[520px] mx-auto">
              <ResumePreview data={sampleData} templateId={selectedId} />
            </div>

            <p className="text-center text-[10px] text-[#8b98a5] mt-3">
              Preview uses sample data. Your content will replace this when you build your resume.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
