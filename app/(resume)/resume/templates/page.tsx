'use client'

import Link from 'next/link'

const RESUME_TEMPLATES = [
  {
    id: 'professional',
    name: 'Professional',
    desc: 'Clean, traditional layout perfect for corporate roles.',
    sections: ['Summary', 'Experience', 'Education', 'Skills'],
    industries: ['Finance', 'Consulting', 'Enterprise'],
    color: 'indigo',
  },
  {
    id: 'technical',
    name: 'Technical',
    desc: 'Skills-forward layout ideal for engineering roles.',
    sections: ['Technical Skills', 'Experience', 'Projects', 'Education'],
    industries: ['Tech', 'Engineering', 'Data Science'],
    color: 'emerald',
  },
  {
    id: 'creative',
    name: 'Creative',
    desc: 'Modern layout with visual hierarchy for design roles.',
    sections: ['Portfolio', 'Experience', 'Skills', 'Education'],
    industries: ['Design', 'Marketing', 'Media'],
    color: 'violet',
  },
  {
    id: 'executive',
    name: 'Executive',
    desc: 'Leadership-focused layout for senior positions.',
    sections: ['Executive Summary', 'Key Achievements', 'Experience', 'Board & Advisory'],
    industries: ['C-Suite', 'VP+', 'Director'],
    color: 'amber',
  },
  {
    id: 'career-change',
    name: 'Career Change',
    desc: 'Skills-based format that emphasizes transferable abilities.',
    sections: ['Objective', 'Core Competencies', 'Relevant Experience', 'Education'],
    industries: ['All Industries'],
    color: 'cyan',
  },
  {
    id: 'entry-level',
    name: 'Entry Level',
    desc: 'Education-forward for new graduates and early career.',
    sections: ['Education', 'Projects', 'Internships', 'Skills', 'Activities'],
    industries: ['All Industries'],
    color: 'rose',
  },
]

const COLOR_MAP: Record<string, { bg: string; border: string; text: string }> = {
  indigo: { bg: 'bg-indigo-500/10', border: 'border-indigo-500/20', text: 'text-indigo-400' },
  emerald: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', text: 'text-emerald-400' },
  violet: { bg: 'bg-violet-500/10', border: 'border-violet-500/20', text: 'text-violet-400' },
  amber: { bg: 'bg-amber-500/10', border: 'border-amber-500/20', text: 'text-amber-400' },
  cyan: { bg: 'bg-cyan-500/10', border: 'border-cyan-500/20', text: 'text-cyan-400' },
  rose: { bg: 'bg-rose-500/10', border: 'border-rose-500/20', text: 'text-rose-400' },
}

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
          const colors = COLOR_MAP[t.color] || COLOR_MAP.indigo
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
