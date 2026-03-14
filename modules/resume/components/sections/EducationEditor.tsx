import { useState } from 'react'
import type { ResumeEducation } from '../../validators/resume'

interface Props {
  items: ResumeEducation[]
  onAdd: (edu: ResumeEducation) => void
  onUpdate: (id: string, data: Partial<ResumeEducation>) => void
  onRemove: (id: string) => void
}

export default function EducationEditor({ items, onAdd, onUpdate, onRemove }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(items[0]?.id || null)

  function addNew() {
    const edu: ResumeEducation = {
      id: crypto.randomUUID(),
      institution: '',
      degree: '',
    }
    onAdd(edu)
    setExpandedId(edu.id)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Education</h3>
        <button onClick={addNew} className="px-2.5 py-1 bg-slate-700 hover:bg-slate-600 text-slate-300 text-[10px] rounded-lg font-medium transition-colors">
          + Add Education
        </button>
      </div>

      {items.map(edu => (
        <div key={edu.id} className="border border-slate-700 rounded-xl overflow-hidden">
          <button
            onClick={() => setExpandedId(expandedId === edu.id ? null : edu.id)}
            className="w-full flex items-center justify-between px-4 py-3 bg-slate-800/50 hover:bg-slate-800 transition-colors text-left"
          >
            <span className="text-sm text-white">
              {edu.degree || edu.institution ? `${edu.degree || 'Degree'}${edu.institution ? ` - ${edu.institution}` : ''}` : 'New Education'}
            </span>
            <div className="flex items-center gap-2">
              <button onClick={e => { e.stopPropagation(); onRemove(edu.id) }} className="text-slate-500 hover:text-red-400 transition-colors">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
              </button>
              <svg className={`w-4 h-4 text-slate-400 transition-transform ${expandedId === edu.id ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
            </div>
          </button>

          {expandedId === edu.id && (
            <div className="p-4 grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="text-[10px] text-slate-500 uppercase tracking-wider">Institution</label>
                <input type="text" value={edu.institution} onChange={e => onUpdate(edu.id, { institution: e.target.value })} placeholder="MIT" className="w-full mt-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500" />
              </div>
              <div>
                <label className="text-[10px] text-slate-500 uppercase tracking-wider">Degree</label>
                <input type="text" value={edu.degree} onChange={e => onUpdate(edu.id, { degree: e.target.value })} placeholder="B.S. Computer Science" className="w-full mt-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500" />
              </div>
              <div>
                <label className="text-[10px] text-slate-500 uppercase tracking-wider">Field of Study</label>
                <input type="text" value={edu.field || ''} onChange={e => onUpdate(edu.id, { field: e.target.value })} placeholder="Computer Science" className="w-full mt-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500" />
              </div>
              <div>
                <label className="text-[10px] text-slate-500 uppercase tracking-wider">Graduation Date</label>
                <input type="text" value={edu.graduationDate || ''} onChange={e => onUpdate(edu.id, { graduationDate: e.target.value })} placeholder="May 2020" className="w-full mt-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500" />
              </div>
              <div>
                <label className="text-[10px] text-slate-500 uppercase tracking-wider">GPA (optional)</label>
                <input type="text" value={edu.gpa || ''} onChange={e => onUpdate(edu.id, { gpa: e.target.value })} placeholder="3.8/4.0" className="w-full mt-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500" />
              </div>
              <div className="col-span-2">
                <label className="text-[10px] text-slate-500 uppercase tracking-wider">Honors (optional)</label>
                <input type="text" value={edu.honors || ''} onChange={e => onUpdate(edu.id, { honors: e.target.value })} placeholder="Magna Cum Laude, Dean's List" className="w-full mt-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500" />
              </div>
            </div>
          )}
        </div>
      ))}

      {items.length === 0 && <p className="text-xs text-slate-500 text-center py-4">No education added yet.</p>}
    </div>
  )
}
