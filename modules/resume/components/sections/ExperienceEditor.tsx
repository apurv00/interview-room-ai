import { useState } from 'react'
import type { ResumeExperience } from '../../validators/resume'
import SortableList from '../SortableList'
import SortableItem, { DragHandle } from '../SortableItem'
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { X, Trash2, ChevronDown } from 'lucide-react'

interface Props {
  items: ResumeExperience[]
  onAdd: (exp: ResumeExperience) => void
  onUpdate: (id: string, data: Partial<ResumeExperience>) => void
  onRemove: (id: string) => void
  onEnhanceBullets?: (expId: string) => void
  enhancingId?: string | null
  onReorder?: (activeId: string, overId: string) => void
  onReorderBullets?: (expId: string, oldIndex: number, newIndex: number) => void
}

function BulletItem({ id, value, onChange, onRemove, canRemove }: {
  id: string; value: string; onChange: (v: string) => void; onRemove: () => void; canRemove: boolean
}) {
  return (
    <SortableItem id={id}>
      {({ listeners, attributes }) => (
        <div className="flex items-start gap-2">
          <div className="pt-2.5">
            <DragHandle listeners={listeners} attributes={attributes} />
          </div>
          <textarea
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder="Describe an achievement or responsibility..."
            rows={2}
            className="flex-1 px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y"
          />
          {canRemove && (
            <button
              onClick={onRemove}
              className="text-slate-400 hover:text-red-500 mt-2 transition-colors"
            >
              <X className="w-3.5 h-3.5" strokeWidth={2} />
            </button>
          )}
        </div>
      )}
    </SortableItem>
  )
}

export default function ExperienceEditor({ items, onAdd, onUpdate, onRemove, onEnhanceBullets, enhancingId, onReorder, onReorderBullets }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(items[0]?.id || null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

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

  function handleBulletDragEnd(expId: string, event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const exp = items.find(e => e.id === expId)
    if (!exp) return
    const oldIndex = exp.bullets.findIndex((_, i) => `bullet-${i}` === active.id)
    const newIndex = exp.bullets.findIndex((_, i) => `bullet-${i}` === over.id)
    if (oldIndex !== -1 && newIndex !== -1 && onReorderBullets) {
      onReorderBullets(expId, oldIndex, newIndex)
    }
  }

  const content = (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">Work Experience</h3>
        <button
          onClick={addNew}
          className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-500 text-[10px] rounded-lg font-medium transition-colors"
        >
          + Add Role
        </button>
      </div>

      {onReorder ? (
        <SortableList items={items.map(e => e.id)} onReorder={onReorder}>
          {items.map(exp => (
            <SortableItem key={exp.id} id={exp.id}>
              {({ listeners, attributes }) => (
                <div className="mb-2">
                  <ExperienceCard
                    exp={exp}
                    expanded={expandedId === exp.id}
                    onToggle={() => setExpandedId(expandedId === exp.id ? null : exp.id)}
                    onUpdate={onUpdate}
                    onRemove={onRemove}
                    onEnhanceBullets={onEnhanceBullets}
                    enhancingId={enhancingId}
                    addBullet={addBullet}
                    updateBullet={updateBullet}
                    removeBullet={removeBullet}
                    handleBulletDragEnd={handleBulletDragEnd}
                    sensors={sensors}
                    dragListeners={listeners}
                    dragAttributes={attributes}
                  />
                </div>
              )}
            </SortableItem>
          ))}
        </SortableList>
      ) : (
        items.map(exp => (
          <ExperienceCard
            key={exp.id}
            exp={exp}
            expanded={expandedId === exp.id}
            onToggle={() => setExpandedId(expandedId === exp.id ? null : exp.id)}
            onUpdate={onUpdate}
            onRemove={onRemove}
            onEnhanceBullets={onEnhanceBullets}
            enhancingId={enhancingId}
            addBullet={addBullet}
            updateBullet={updateBullet}
            removeBullet={removeBullet}
            handleBulletDragEnd={handleBulletDragEnd}
            sensors={sensors}
          />
        ))
      )}

      {items.length === 0 && (
        <p className="text-xs text-slate-400 text-center py-4">No experience added yet. Click &quot;+ Add Role&quot; to start.</p>
      )}
    </div>
  )

  return content
}

function ExperienceCard({ exp, expanded, onToggle, onUpdate, onRemove, onEnhanceBullets, enhancingId, addBullet, updateBullet, removeBullet, handleBulletDragEnd, sensors, dragListeners, dragAttributes }: {
  exp: ResumeExperience
  expanded: boolean
  onToggle: () => void
  onUpdate: (id: string, data: Partial<ResumeExperience>) => void
  onRemove: (id: string) => void
  onEnhanceBullets?: (expId: string) => void
  enhancingId?: string | null
  addBullet: (expId: string) => void
  updateBullet: (expId: string, idx: number, value: string) => void
  removeBullet: (expId: string, idx: number) => void
  handleBulletDragEnd: (expId: string, event: DragEndEvent) => void
  sensors: ReturnType<typeof useSensors>
  dragListeners?: Record<string, Function>
  dragAttributes?: Record<string, unknown>
}) {
  const bulletIds = exp.bullets.map((_, i) => `bullet-${i}`)

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      {/* Header */}
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 bg-slate-50 hover:bg-slate-100 transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          {dragListeners && (
            <div onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
              <DragHandle listeners={dragListeners} attributes={dragAttributes} />
            </div>
          )}
          <span className="text-sm text-slate-900">
            {exp.title || exp.company
              ? `${exp.title || 'Untitled'}${exp.company ? ` at ${exp.company}` : ''}`
              : 'New Experience'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={e => { e.stopPropagation(); onRemove(exp.id) }}
            className="text-slate-400 hover:text-[#f4212e] transition-colors"
          >
            <Trash2 className="w-4 h-4" strokeWidth={2} />
          </button>
          <ChevronDown className={`w-4 h-4 text-slate-500 transition-transform ${expanded ? 'rotate-180' : ''}`} strokeWidth={2} />
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-slate-400 uppercase tracking-wider">Job Title</label>
              <input
                type="text"
                value={exp.title}
                onChange={e => onUpdate(exp.id, { title: e.target.value })}
                placeholder="Senior Software Engineer"
                className="w-full mt-1 px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
            <div>
              <label className="text-[10px] text-slate-400 uppercase tracking-wider">Company</label>
              <input
                type="text"
                value={exp.company}
                onChange={e => onUpdate(exp.id, { company: e.target.value })}
                placeholder="Google"
                className="w-full mt-1 px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
            <div>
              <label className="text-[10px] text-slate-400 uppercase tracking-wider">Location</label>
              <input
                type="text"
                value={exp.location || ''}
                onChange={e => onUpdate(exp.id, { location: e.target.value })}
                placeholder="Mountain View, CA"
                className="w-full mt-1 px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] text-slate-400 uppercase tracking-wider">Start Date</label>
                <input
                  type="text"
                  value={exp.startDate}
                  onChange={e => onUpdate(exp.id, { startDate: e.target.value })}
                  placeholder="Jan 2022"
                  className="w-full mt-1 px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label className="text-[10px] text-slate-400 uppercase tracking-wider">End Date</label>
                <input
                  type="text"
                  value={exp.endDate || ''}
                  onChange={e => onUpdate(exp.id, { endDate: e.target.value })}
                  placeholder="Present"
                  className="w-full mt-1 px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
            </div>
          </div>

          {/* Bullets with DnD */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-[10px] text-slate-400 uppercase tracking-wider">Achievements & Responsibilities</label>
              {onEnhanceBullets && (
                <button
                  onClick={() => onEnhanceBullets(exp.id)}
                  disabled={enhancingId === exp.id || exp.bullets.every(b => !b.trim())}
                  className="px-2 py-0.5 bg-emerald-50 border border-emerald-200 text-[#059669] text-[10px] rounded font-medium hover:bg-emerald-100 disabled:opacity-30 transition-colors"
                >
                  {enhancingId === exp.id ? 'Enhancing...' : 'AI Enhance'}
                </button>
              )}
            </div>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={e => handleBulletDragEnd(exp.id, e)}
            >
              <SortableContext items={bulletIds} strategy={verticalListSortingStrategy}>
                {exp.bullets.map((bullet, idx) => (
                  <BulletItem
                    key={`bullet-${idx}`}
                    id={`bullet-${idx}`}
                    value={bullet}
                    onChange={v => updateBullet(exp.id, idx, v)}
                    onRemove={() => removeBullet(exp.id, idx)}
                    canRemove={exp.bullets.length > 1}
                  />
                ))}
              </SortableContext>
            </DndContext>
            <button
              onClick={() => addBullet(exp.id)}
              className="text-[11px] text-slate-400 hover:text-slate-900 transition-colors"
            >
              + Add bullet point
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
