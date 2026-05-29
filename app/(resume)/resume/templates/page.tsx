'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { RESUME_TEMPLATES, TEMPLATE_COLOR_MAP, SAMPLE_RESUME_DATA } from '@resume/config/templates'
import {
  TEMPLATE_FAMILIES,
  TEMPLATE_VARIANTS,
  getTemplateFamilyConfig,
} from '@resume/config/templateFamilies'
import ResumePreview from '@resume/components/ResumePreview'
import type { ResumeData } from '@resume/validators/resume'

type FamilyFilter = 'all' | string

export default function ResumeTemplatesPage() {
  const [selectedId, setSelectedId] = useState(RESUME_TEMPLATES[0].id)
  const [familyFilter, setFamilyFilter] = useState<FamilyFilter>('all')
  const selected = RESUME_TEMPLATES.find(t => t.id === selectedId) || RESUME_TEMPLATES[0]
  const colors = TEMPLATE_COLOR_MAP[selected.color] || TEMPLATE_COLOR_MAP.blue
  const selectedFamily = getTemplateFamilyConfig(selectedId)

  // Only show family tabs that actually have at least one template mapped to them.
  const visibleFamilies = useMemo(
    () =>
      TEMPLATE_FAMILIES.filter(family =>
        RESUME_TEMPLATES.some(t => TEMPLATE_VARIANTS[t.id]?.familyId === family.id),
      ),
    [],
  )

  const filteredTemplates = useMemo(
    () =>
      familyFilter === 'all'
        ? RESUME_TEMPLATES
        : RESUME_TEMPLATES.filter(t => TEMPLATE_VARIANTS[t.id]?.familyId === familyFilter),
    [familyFilter],
  )

  // Changing the family tab must keep the previewed/selected template inside the
  // visible list — otherwise the preview + "Use This Template" CTA point at a
  // hidden template from another family (Codex r3325416604).
  const selectFamily = (filter: FamilyFilter) => {
    setFamilyFilter(filter)
    if (filter === 'all') return
    const inFamily = RESUME_TEMPLATES.filter(t => TEMPLATE_VARIANTS[t.id]?.familyId === filter)
    if (inFamily.length > 0 && !inFamily.some(t => t.id === selectedId)) {
      setSelectedId(inFamily[0].id)
    }
  }

  const sampleData: ResumeData = {
    ...SAMPLE_RESUME_DATA,
    template: selectedId,
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Resume Templates</h1>
        <p className="text-sm text-slate-500 mt-1">
          Choose a template that matches your career stage and industry. Click any template to preview it.
        </p>
      </div>

      {/* Family filter tabs */}
      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={() => selectFamily('all')}
          className={`px-3 py-1 rounded-full text-[11px] font-medium transition-colors ${
            familyFilter === 'all'
              ? 'bg-slate-900 text-white'
              : 'bg-slate-100 text-slate-500 hover:text-slate-900'
          }`}
        >
          All
        </button>
        {visibleFamilies.map(family => (
          <button
            key={family.id}
            onClick={() => selectFamily(family.id)}
            title={family.description}
            className={`px-3 py-1 rounded-full text-[11px] font-medium transition-colors ${
              familyFilter === family.id
                ? 'bg-slate-900 text-white'
                : 'bg-slate-100 text-slate-500 hover:text-slate-900'
            }`}
          >
            {family.label}
          </button>
        ))}
      </div>

      <div className="flex gap-6">
        {/* Template list - left side */}
        <div className="w-[340px] shrink-0 space-y-2 overflow-y-auto max-h-[calc(100vh-180px)] pr-1">
          {filteredTemplates.map(t => {
            const tColors = TEMPLATE_COLOR_MAP[t.color] || TEMPLATE_COLOR_MAP.blue
            const isSelected = t.id === selectedId
            const family = getTemplateFamilyConfig(t.id)
            return (
              <button
                key={t.id}
                onClick={() => setSelectedId(t.id)}
                className={`w-full text-left p-4 rounded-xl border transition-all ${
                  isSelected
                    ? `bg-slate-50 border-emerald-500/40 ring-1 ring-emerald-500/20`
                    : 'bg-white border-slate-200 hover:border-slate-400'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <h3 className={`text-sm font-semibold ${isSelected ? 'text-emerald-600' : 'text-slate-900'}`}>
                    {t.name}
                  </h3>
                  <span className={`px-2 py-0.5 rounded-full text-[9px] font-semibold ${tColors.bg} border ${tColors.border} ${tColors.text}`}>
                    {t.industries[0]}
                  </span>
                </div>
                {family && (
                  <span className="inline-block mb-1 text-[9px] font-medium text-slate-400 uppercase tracking-wider">
                    {family.label} family
                  </span>
                )}
                <p className="text-[11px] text-slate-500 leading-relaxed">{t.desc}</p>
                <div className="flex flex-wrap gap-1 mt-2">
                  {t.sections.slice(0, 4).map(s => (
                    <span key={s} className="px-1.5 py-0.5 bg-slate-50 rounded text-[9px] text-slate-500">
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
                <h2 className="text-lg font-semibold text-slate-900">{selected.name}</h2>
                {selectedFamily && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-100 text-slate-500">
                    {selectedFamily.label} family
                  </span>
                )}
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

            <p className="text-center text-[10px] text-slate-400 mt-3">
              Preview uses sample data. Your content will replace this when you build your resume.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
