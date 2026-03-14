'use client'

import Link from 'next/link'
import { RESUME_TEMPLATES, TEMPLATE_COLOR_MAP } from '@resume/config/templates'

export default function ResumeTemplatesPage() {
  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Resume Templates</h1>
        <p className="text-sm text-slate-400 mt-1">
          Choose a template that matches your career stage and industry.
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {RESUME_TEMPLATES.map(t => {
          const colors = TEMPLATE_COLOR_MAP[t.color] || TEMPLATE_COLOR_MAP.indigo
          return (
            <div key={t.id} className="bg-slate-900 border border-slate-800 rounded-2xl p-6 hover:border-slate-700 transition-all group">
              <div className="flex items-start justify-between mb-3">
                <h3 className="text-lg font-semibold text-white group-hover:text-emerald-400 transition-colors">
                  {t.name}
                </h3>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${colors.bg} border ${colors.border} ${colors.text}`}>
                  {t.industries[0]}
                </span>
              </div>
              <p className="text-xs text-slate-400 mb-4">{t.desc}</p>

              <div className="mb-4">
                <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5">Sections</p>
                <div className="flex flex-wrap gap-1.5">
                  {t.sections.map(s => (
                    <span key={s} className="px-2 py-0.5 bg-slate-800 rounded text-[10px] text-slate-400">
                      {s}
                    </span>
                  ))}
                </div>
              </div>

              <Link
                href={`/resume/builder?template=${t.id}`}
                className="block w-full py-2.5 text-center text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl transition-colors"
              >
                Use This Template
              </Link>
            </div>
          )
        })}
      </div>
    </div>
  )
}
