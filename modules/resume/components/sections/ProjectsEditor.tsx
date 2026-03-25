import { useState } from 'react'
import type { ResumeProject } from '../../validators/resume'
import SortableList from '../SortableList'
import SortableItem, { DragHandle } from '../SortableItem'

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
      <div className="border border-[#e1e8ed] rounded-xl overflow-hidden">
        <button
          onClick={() => setExpandedId(expandedId === proj.id ? null : proj.id)}
          className="w-full flex items-center justify-between px-4 py-3 bg-[#f7f9f9] hover:bg-[#eff3f4] transition-colors text-left"
        >
          <div className="flex items-center gap-2">
            {dragListeners && (
              <div onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
                <DragHandle listeners={dragListeners} attributes={dragAttributes} />
              </div>
            )}
            <span className="text-sm text-[#0f1419]">{proj.name || 'New Project'}</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={e => { e.stopPropagation(); onRemove(proj.id) }} className="text-[#8b98a5] hover:text-red-400 transition-colors">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
            </button>
            <svg className={`w-4 h-4 text-[#536471] transition-transform ${expandedId === proj.id ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
          </div>
        </button>

        {expandedId === proj.id && (
          <div className="p-4 space-y-3">
            <div>
              <label className="text-[10px] text-[#8b98a5] uppercase tracking-wider">Project Name</label>
              <input type="text" value={proj.name} onChange={e => onUpdate(proj.id, { name: e.target.value })} placeholder="AI Chat Application" className="w-full mt-1 px-3 py-2 bg-white border border-[#e1e8ed] rounded-lg text-sm text-[#0f1419] placeholder-[#8b98a5] focus:outline-none focus:ring-2 focus:ring-emerald-500" />
            </div>
            <div>
              <label className="text-[10px] text-[#8b98a5] uppercase tracking-wider">Description</label>
              <textarea value={proj.description} onChange={e => onUpdate(proj.id, { description: e.target.value })} placeholder="Describe the project..." rows={3} className="w-full mt-1 px-3 py-2 bg-white border border-[#e1e8ed] rounded-lg text-sm text-[#0f1419] placeholder-[#8b98a5] focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y" />
            </div>
            <div>
              <label className="text-[10px] text-[#8b98a5] uppercase tracking-wider">Technologies (comma-separated)</label>
              <input type="text" value={proj.technologies?.join(', ') || ''} onChange={e => updateTechs(proj.id, e.target.value)} placeholder="React, Node.js, PostgreSQL" className="w-full mt-1 px-3 py-2 bg-white border border-[#e1e8ed] rounded-lg text-sm text-[#0f1419] placeholder-[#8b98a5] focus:outline-none focus:ring-2 focus:ring-emerald-500" />
            </div>
            <div>
              <label className="text-[10px] text-[#8b98a5] uppercase tracking-wider">URL (optional)</label>
              <input type="text" value={proj.url || ''} onChange={e => onUpdate(proj.id, { url: e.target.value })} placeholder="https://github.com/..." className="w-full mt-1 px-3 py-2 bg-white border border-[#e1e8ed] rounded-lg text-sm text-[#0f1419] placeholder-[#8b98a5] focus:outline-none focus:ring-2 focus:ring-emerald-500" />
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[#0f1419]">Projects</h3>
        <button onClick={addNew} className="px-2.5 py-1 bg-[#eff3f4] hover:bg-[#e1e8ed] text-[#536471] text-[10px] rounded-lg font-medium transition-colors">
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

      {items.length === 0 && <p className="text-xs text-[#8b98a5] text-center py-4">No projects added yet.</p>}
    </div>
  )
}
