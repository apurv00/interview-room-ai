import type { ResumeCustomSection } from '../../validators/resume'
import SortableList from '../SortableList'
import SortableItem, { DragHandle } from '../SortableItem'
import { X } from 'lucide-react'

interface Props {
  items: ResumeCustomSection[]
  onAdd: (section: ResumeCustomSection) => void
  onUpdate: (id: string, data: Partial<ResumeCustomSection>) => void
  onRemove: (id: string) => void
  onReorder?: (activeId: string, overId: string) => void
}

export default function CustomSectionEditor({ items, onAdd, onUpdate, onRemove, onReorder }: Props) {
  function addNew() {
    onAdd({ id: crypto.randomUUID(), title: 'Custom Section', content: '' })
  }

  function renderCard(section: ResumeCustomSection, dragListeners?: Record<string, Function>, dragAttributes?: Record<string, unknown>) {
    return (
      <div className="border border-slate-200 rounded-xl p-4 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {dragListeners && (
              <DragHandle listeners={dragListeners} attributes={dragAttributes} />
            )}
            <input
              type="text"
              value={section.title}
              onChange={e => onUpdate(section.id, { title: e.target.value })}
              className="text-sm font-semibold text-slate-900 bg-transparent border-none focus:outline-none"
              placeholder="Section Title"
            />
          </div>
          <button onClick={() => onRemove(section.id)} className="text-slate-400 hover:text-[#f4212e] transition-colors">
            <X className="w-4 h-4" strokeWidth={2} />
          </button>
        </div>
        <textarea
          value={section.content}
          onChange={e => onUpdate(section.id, { content: e.target.value })}
          placeholder="Section content..."
          rows={3}
          className="w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y"
        />
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {onReorder ? (
        <SortableList items={items.map(s => s.id)} onReorder={onReorder}>
          {items.map(section => (
            <SortableItem key={section.id} id={section.id}>
              {({ listeners, attributes }) => (
                <div className="mb-2">{renderCard(section, listeners, attributes)}</div>
              )}
            </SortableItem>
          ))}
        </SortableList>
      ) : (
        items.map(section => <div key={section.id}>{renderCard(section)}</div>)
      )}

      <button
        onClick={addNew}
        className="w-full py-3 border border-dashed border-slate-200 rounded-xl text-sm text-slate-400 hover:text-slate-900 hover:border-slate-400 transition-colors"
      >
        + Add Custom Section
      </button>
    </div>
  )
}
