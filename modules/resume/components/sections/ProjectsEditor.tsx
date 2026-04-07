import { useState } from 'react'
import type { ResumeProject } from '../../validators/resume'
import SortableList from '../SortableList'
import SortableItem, { DragHandle } from '../SortableItem'
import { Trash2, ChevronDown } from 'lucide-react'

interface Props {
  items: ResumeProject[]
  onAdd: (proj: ResumeProject) => void
  onUpdate: (id: string, data: Partial<ResumeProject>) => void
  onRemove: (id: string) => void
  onReorder?: (activeId: string, overId: string) => void
}

export default function ProjectsEditor({ items, onAdd, onUpdate, onRemove, onReorder }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(items[0]?.id || null)

  function addNew() {
    const proj: ResumeProject = { id: crypto.randomUUID(), name: '', description: '' }
    onAdd(proj)
    setExpandedId(proj.id)
  }

  function updateTechs(projId: string, techStr: string) {
    onUpdate(projId, { technologies: techStr.split(',').map(t => t.trim()).filter(Boolean) })
  }

  function renderCard(proj: ResumeProject, dragListeners?: Record<string, Function>, dragAttributes?: Record<string, unknown>) {
    return (
      <div className="border border-slate-200 rounded-xl overflow-hidden">
        <button
          onClick={() => setExpandedId(expandedId === proj.id ? null : proj.id)}
          className="w-full flex items-center justify-between px-4 py-3 bg-slate-50 hover:bg-slate-100 transition-colors text-left"
        >
          <div className="flex items-center gap-2">
            {dragListeners && (
              <div onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
                <DragHandle listeners={dragListeners} attributes={dragAttributes} />
              </div>
            )}
            <span className="text-sm text-slate-900">{proj.name || 'New Project'}</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={e => { e.stopPropagation(); onRemove(proj.id) }} className="text-slate-400 hover:text-[#f4212e] transition-colors">
              <Trash2 className="w-4 h-4" strokeWidth={2} />
            </button>
            <ChevronDown className={`w-4 h-4 text-slate-500 transition-transform ${expandedId === proj.id ? 'rotate-180' : ''}`} strokeWidth={2} />
          </div>
        </button>

        {expandedId === proj.id && (
          <div className="p-4 space-y-3">
            <div>
              <label className="text-[10px] text-slate-400 uppercase tracking-wider">Project Name</label>
              <input type="text" value={proj.name} onChange={e => onUpdate(proj.id, { name: e.target.value })} placeholder="AI Chat Application" className="w-full mt-1 px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500" />
            </div>
            <div>
              <label className="text-[10px] text-slate-400 uppercase tracking-wider">Description</label>
              <textarea value={proj.description} onChange={e => onUpdate(proj.id, { description: e.target.value })} placeholder="Describe the project..." rows={3} className="w-full mt-1 px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y" />
            </div>
            <div>
              <label className="text-[10px] text-slate-400 uppercase tracking-wider">Technologies (comma-separated)</label>
              <input type="text" value={proj.technologies?.join(', ') || ''} onChange={e => updateTechs(proj.id, e.target.value)} placeholder="React, Node.js, PostgreSQL" className="w-full mt-1 px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500" />
            </div>
            <div>
              <label className="text-[10px] text-slate-400 uppercase tracking-wider">URL (optional)</label>
              <input type="text" value={proj.url || ''} onChange={e => onUpdate(proj.id, { url: e.target.value })} placeholder="https://github.com/..." className="w-full mt-1 px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500" />
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">Projects</h3>
        <button onClick={addNew} className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-500 text-[10px] rounded-lg font-medium transition-colors">
          + Add Project
        </button>
      </div>

      {onReorder ? (
        <SortableList items={items.map(p => p.id)} onReorder={onReorder}>
          {items.map(proj => (
            <SortableItem key={proj.id} id={proj.id}>
              {({ listeners, attributes }) => (
                <div className="mb-2">{renderCard(proj, listeners, attributes)}</div>
              )}
            </SortableItem>
          ))}
        </SortableList>
      ) : (
        items.map(proj => <div key={proj.id}>{renderCard(proj)}</div>)
      )}

      {items.length === 0 && <p className="text-xs text-slate-400 text-center py-4">No projects added yet.</p>}
    </div>
  )
}
