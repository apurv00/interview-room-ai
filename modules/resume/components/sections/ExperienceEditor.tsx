import { useState } from 'react'
import type { ResumeExperience } from '../../validators/resume'

interface Props {
  items: ResumeExperience[]
  onAdd: (exp: ResumeExperience) => void
  onUpdate: (id: string, data: Partial<ResumeExperience>) => void
  onRemove: (id: string) => void
  onEnhanceBullets?: (expId: string) => void
  enhancingId?: string | null
}

export default function ExperienceEditor({ items, onAdd, onUpdate, onRemove, onEnhanceBullets, enhancingId }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(items[0]?.id || null)

  function addNew() {
    const exp: ResumeExperience = {
      id: crypto.randomUUID(),
      company: '',
      title: '',
      startDate: '',
      bullets: [''],
    }
    onAdd(exp)
    setExpandedId(exp.id)
  }

  function addBullet(expId: string) {
    const exp = items.find(e => e.id === expId)
    if (exp) {
      onUpdate(expId, { bullets: [...exp.bullets, ''] })
    }
  }

  function updateBullet(expId: string, idx: number, value: string) {
    const exp = items.find(e => e.id === expId)
    if (exp) {
      const bullets = [...exp.bullets]
      bullets[idx] = value
      onUpdate(expId, { bullets })
    }
  }

  function removeBullet(expId: string, idx: number) {
    const exp = items.find(e => e.id === expId)
    if (exp && exp.bullets.length > 1) {
      onUpdate(expId, { bullets: exp.bullets.filter((_, i) => i !== idx) })
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Work Experience</h3>
        <button
          onClick={addNew}
          className="px-2.5 py-1 bg-slate-700 hover:bg-slate-600 text-slate-300 text-[10px] rounded-lg font-medium transition-colors"
        >
          + Add Role
        </button>
      </div>

      {items.map(exp => (
        <div key={exp.id} className="border border-slate-700 rounded-xl overflow-hidden">
          {/* Header */}
          <button
            onClick={() => setExpandedId(expandedId === exp.id ? null : exp.id)}
            className="w-full flex items-center justify-between px-4 py-3 bg-slate-800/50 hover:bg-slate-800 transition-colors text-left"
          >
            <span className="text-sm text-white">
              {exp.title || exp.company
                ? `${exp.title || 'Untitled'}${exp.company ? ` at ${exp.company}` : ''}`
                : 'New Experience'}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={e => { e.stopPropagation(); onRemove(exp.id) }}
                className="text-slate-500 hover:text-red-400 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
              <svg className={`w-4 h-4 text-slate-400 transition-transform ${expandedId === exp.id ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          </button>

          {/* Expanded content */}
          {expandedId === exp.id && (
            <div className="p-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] text-slate-500 uppercase tracking-wider">Job Title</label>
                  <input
                    type="text"
                    value={exp.title}
                    onChange={e => onUpdate(exp.id, { title: e.target.value })}
                    placeholder="Senior Software Engineer"
                    className="w-full mt-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-slate-500 uppercase tracking-wider">Company</label>
                  <input
                    type="text"
                    value={exp.company}
                    onChange={e => onUpdate(exp.id, { company: e.target.value })}
                    placeholder="Google"
                    className="w-full mt-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-slate-500 uppercase tracking-wider">Location</label>
                  <input
                    type="text"
                    value={exp.location || ''}
                    onChange={e => onUpdate(exp.id, { location: e.target.value })}
                    placeholder="Mountain View, CA"
                    className="w-full mt-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-slate-500 uppercase tracking-wider">Start Date</label>
                    <input
                      type="text"
                      value={exp.startDate}
                      onChange={e => onUpdate(exp.id, { startDate: e.target.value })}
                      placeholder="Jan 2022"
                      className="w-full mt-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-500 uppercase tracking-wider">End Date</label>
                    <input
                      type="text"
                      value={exp.endDate || ''}
                      onChange={e => onUpdate(exp.id, { endDate: e.target.value })}
                      placeholder="Present"
                      className="w-full mt-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    />
                  </div>
                </div>
              </div>

              {/* Bullets */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] text-slate-500 uppercase tracking-wider">Achievements & Responsibilities</label>
                  {onEnhanceBullets && (
                    <button
                      onClick={() => onEnhanceBullets(exp.id)}
                      disabled={enhancingId === exp.id || exp.bullets.every(b => !b.trim())}
                      className="px-2 py-0.5 bg-emerald-600/10 border border-emerald-500/20 text-emerald-400 text-[10px] rounded font-medium hover:bg-emerald-600/20 disabled:opacity-30 transition-colors"
                    >
                      {enhancingId === exp.id ? 'Enhancing...' : 'AI Enhance'}
                    </button>
                  )}
                </div>
                {exp.bullets.map((bullet, idx) => (
                  <div key={idx} className="flex items-start gap-2">
                    <span className="text-slate-600 text-sm mt-2">-</span>
                    <textarea
                      value={bullet}
                      onChange={e => updateBullet(exp.id, idx, e.target.value)}
                      placeholder="Describe an achievement or responsibility..."
                      rows={2}
                      className="flex-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y"
                    />
                    {exp.bullets.length > 1 && (
                      <button
                        onClick={() => removeBullet(exp.id, idx)}
                        className="text-slate-600 hover:text-red-400 mt-2 transition-colors"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    )}
                  </div>
                ))}
                <button
                  onClick={() => addBullet(exp.id)}
                  className="text-[11px] text-slate-500 hover:text-slate-300 transition-colors"
                >
                  + Add bullet point
                </button>
              </div>
            </div>
          )}
        </div>
      ))}

      {items.length === 0 && (
        <p className="text-xs text-slate-500 text-center py-4">No experience added yet. Click &quot;+ Add Role&quot; to start.</p>
      )}
    </div>
  )
}
