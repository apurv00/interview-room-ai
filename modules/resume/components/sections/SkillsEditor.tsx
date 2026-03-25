import { useState } from 'react'
import type { ResumeSkillCategory } from '../../validators/resume'

interface Props {
  items: ResumeSkillCategory[]
  onChange: (skills: ResumeSkillCategory[]) => void
}

export default function SkillsEditor({ items, onChange }: Props) {
  const [newSkill, setNewSkill] = useState<Record<number, string>>({})

  function addCategory() {
    onChange([...items, { category: 'New Category', items: [] }])
  }

  function removeCategory(idx: number) {
    onChange(items.filter((_, i) => i !== idx))
  }

  function updateCategory(idx: number, category: string) {
    const updated = [...items]
    updated[idx] = { ...updated[idx], category }
    onChange(updated)
  }

  function addSkillToCategory(catIdx: number) {
    const skill = newSkill[catIdx]?.trim()
    if (!skill) return
    const updated = [...items]
    updated[catIdx] = { ...updated[catIdx], items: [...updated[catIdx].items, skill] }
    onChange(updated)
    setNewSkill(prev => ({ ...prev, [catIdx]: '' }))
  }

  function removeSkill(catIdx: number, skillIdx: number) {
    const updated = [...items]
    updated[catIdx] = { ...updated[catIdx], items: updated[catIdx].items.filter((_, i) => i !== skillIdx) }
    onChange(updated)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[#0f1419]">Skills</h3>
        <button onClick={addCategory} className="px-2.5 py-1 bg-[#eff3f4] hover:bg-[#e1e8ed] text-[#536471] text-[10px] rounded-lg font-medium transition-colors">
          + Add Category
        </button>
      </div>

      {items.map((cat, catIdx) => (
        <div key={catIdx} className="border border-[#e1e8ed] rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between">
            <input
              type="text"
              value={cat.category}
              onChange={e => updateCategory(catIdx, e.target.value)}
              className="text-xs font-semibold text-[#0f1419] bg-transparent border-none focus:outline-none"
              placeholder="Category name"
            />
            <button onClick={() => removeCategory(catIdx)} className="text-slate-500 hover:text-red-400 transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {cat.items.map((skill, skillIdx) => (
              <span key={skillIdx} className="inline-flex items-center gap-1 px-2 py-0.5 bg-[#eff3f4] rounded text-[11px] text-[#0f1419]">
                {skill}
                <button onClick={() => removeSkill(catIdx, skillIdx)} className="text-slate-500 hover:text-red-400">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </span>
            ))}
          </div>

          <div className="flex gap-2">
            <input
              type="text"
              value={newSkill[catIdx] || ''}
              onChange={e => setNewSkill(prev => ({ ...prev, [catIdx]: e.target.value }))}
              onKeyDown={e => e.key === 'Enter' && addSkillToCategory(catIdx)}
              placeholder="Add skill..."
              className="flex-1 px-2.5 py-1.5 bg-white border border-[#e1e8ed] rounded-lg text-xs text-[#0f1419] placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
            <button onClick={() => addSkillToCategory(catIdx)} className="px-2.5 py-1.5 bg-emerald-50 text-[#059669] text-xs rounded-lg hover:bg-emerald-100 transition-colors">
              Add
            </button>
          </div>
        </div>
      ))}

      {items.length === 0 && <p className="text-xs text-slate-500 text-center py-4">No skills added yet.</p>}
    </div>
  )
}
