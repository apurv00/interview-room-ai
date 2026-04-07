import { useState } from 'react'
import type { ResumeEducation } from '../../validators/resume'
import SortableList from '../SortableList'
import SortableItem, { DragHandle } from '../SortableItem'
import { Trash2, ChevronDown } from 'lucide-react'

interface Props {
  items: ResumeEducation[]
  onAdd: (edu: ResumeEducation) => void
  onUpdate: (id: string, data: Partial<ResumeEducation>) => void
  onRemove: (id: string) => void
  onReorder?: (activeId: string, overId: string) => void
}

export default function EducationEditor({ items, onAdd, onUpdate, onRemove, onReorder }: Props) {
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

  function renderCard(edu: ResumeEducation, dragListeners?: Record<string, Function>, dragAttributes?: Record<string, unknown>) {
    return (
      <div className="border border-slate-200 rounded-xl overflow-hidden">
        <button
          onClick={() => setExpandedId(expandedId === edu.id ? null : edu.id)}
          className="w-full flex items-center justify-between px-4 py-3 bg-slate-50 hover:bg-slate-100 transition-colors text-left"
        >
          <div className="flex items-center gap-2">
            {dragListeners && (
              <div onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
                <DragHandle listeners={dragListeners} attributes={dragAttributes} />
              </div>
            )}
            <span className="text-sm text-slate-900">
              {edu.degree || edu.institution ? `${edu.degree || 'Degree'}${edu.institution ? ` - ${edu.institution}` : ''}` : 'New Education'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={e => { e.stopPropagation(); onRemove(edu.id) }} className="text-slate-400 hover:text-[#f4212e] transition-colors">
              <Trash2 className="w-4 h-4" strokeWidth={2} />
            </button>
            <ChevronDown className={`w-4 h-4 text-slate-500 transition-transform ${expandedId === edu.id ? 'rotate-180' : ''}`} strokeWidth={2} />
          </div>
        </button>

        {expandedId === edu.id && (
          <div className="p-4 grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="text-[10px] text-slate-400 uppercase tracking-wider">Institution</label>
              <input type="text" value={edu.institution} onChange={e => onUpdate(edu.id, { institution: e.target.value })} placeholder="MIT" className="w-full mt-1 px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500" />
            </div>
            <div>
              <label className="text-[10px] text-slate-400 uppercase tracking-wider">Degree</label>
              <input type="text" value={edu.degree} onChange={e => onUpdate(edu.id, { degree: e.target.value })} placeholder="B.S. Computer Science" className="w-full mt-1 px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500" />
            </div>
            <div>
              <label className="text-[10px] text-slate-400 uppercase tracking-wider">Field of Study</label>
              <input type="text" value={edu.field || ''} onChange={e => onUpdate(edu.id, { field: e.target.value })} placeholder="Computer Science" className="w-full mt-1 px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500" />
            </div>
            <div>
              <label className="text-[10px] text-slate-400 uppercase tracking-wider">Graduation Date</label>
              <input type="text" value={edu.graduationDate || ''} onChange={e => onUpdate(edu.id, { graduationDate: e.target.value })} placeholder="May 2020" className="w-full mt-1 px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500" />
            </div>
            <div>
              <label className="text-[10px] text-slate-400 uppercase tracking-wider">GPA (optional)</label>
              <input type="text" value={edu.gpa || ''} onChange={e => onUpdate(edu.id, { gpa: e.target.value })} placeholder="3.8/4.0" className="w-full mt-1 px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500" />
            </div>
            <div className="col-span-2">
              <label className="text-[10px] text-slate-400 uppercase tracking-wider">Honors (optional)</label>
              <input type="text" value={edu.honors || ''} onChange={e => onUpdate(edu.id, { honors: e.target.value })} placeholder="Magna Cum Laude, Dean's List" className="w-full mt-1 px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500" />
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">Education</h3>
        <button onClick={addNew} className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-500 text-[10px] rounded-lg font-medium transition-colors">
          + Add Education
        </button>
      </div>

      {onReorder ? (
        <SortableList items={items.map(e => e.id)} onReorder={onReorder}>
          {items.map(edu => (
            <SortableItem key={edu.id} id={edu.id}>
              {({ listeners, attributes }) => (
                <div className="mb-2">{renderCard(edu, listeners, attributes)}</div>
              )}
            </SortableItem>
          ))}
        </SortableList>
      ) : (
        items.map(edu => <div key={edu.id}>{renderCard(edu)}</div>)
      )}

      {items.length === 0 && <p className="text-xs text-slate-400 text-center py-4">No education added yet.</p>}
    </div>
  )
}
