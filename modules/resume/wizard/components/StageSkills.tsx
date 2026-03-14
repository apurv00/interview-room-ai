'use client'

import { useState, useCallback, type KeyboardEvent } from 'react'

interface Props {
  skills: { hard: string[]; soft: string[]; technical: string[] }
  onChange: (skills: { hard: string[]; soft: string[]; technical: string[] }) => void
}

type Category = 'hard' | 'soft' | 'technical'

const CATEGORIES: Array<{ key: Category; label: string; placeholder: string }> = [
  { key: 'hard', label: 'Hard Skills', placeholder: 'e.g., Data Analysis, Project Management, Financial Modeling' },
  { key: 'soft', label: 'Soft Skills', placeholder: 'e.g., Communication, Leadership, Problem Solving' },
  { key: 'technical', label: 'Technical Skills', placeholder: 'e.g., Python, SQL, AWS, Figma' },
]

function TagInput({ label, placeholder, tags, onAdd, onRemove }: {
  label: string
  placeholder: string
  tags: string[]
  onAdd: (tag: string) => void
  onRemove: (index: number) => void
}) {
  const [input, setInput] = useState('')

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.key === 'Enter' || e.key === ',') && input.trim()) {
      e.preventDefault()
      onAdd(input.trim())
      setInput('')
    } else if (e.key === 'Backspace' && !input && tags.length > 0) {
      onRemove(tags.length - 1)
    }
  }, [input, tags.length, onAdd, onRemove])

  return (
    <div className="space-y-2">
      <label className="text-caption text-[#b0b8c4]">{label}</label>
      <div className="min-h-[44px] bg-surface border border-[rgba(255,255,255,0.10)] rounded-[6px] p-2 flex flex-wrap gap-1.5 focus-within:border-[#6366f1] focus-within:ring-1 focus-within:ring-[rgba(99,102,241,0.15)] transition-all duration-[120ms]">
        {tags.map((tag, i) => (
          <span
            key={`${tag}-${i}`}
            className="inline-flex items-center gap-1 px-2 py-0.5 bg-[#6366f1]/10 border border-[#6366f1]/20 rounded text-xs text-[#a5b4fc]"
          >
            {tag}
            <button
              onClick={() => onRemove(i)}
              className="text-[#6366f1] hover:text-white transition-colors"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </span>
        ))}
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={tags.length === 0 ? placeholder : 'Add more...'}
          className="flex-1 min-w-[120px] bg-transparent text-sm text-[#f0f2f5] placeholder-[#4b5563] outline-none"
        />
      </div>
      <p className="text-[10px] text-[#4b5563]">Press Enter or comma to add</p>
    </div>
  )
}

export default function StageSkills({ skills, onChange }: Props) {
  const addSkill = useCallback((category: Category, skill: string) => {
    if (skills[category].includes(skill)) return
    onChange({ ...skills, [category]: [...skills[category], skill] })
  }, [skills, onChange])

  const removeSkill = useCallback((category: Category, index: number) => {
    onChange({ ...skills, [category]: skills[category].filter((_, i) => i !== index) })
  }, [skills, onChange])

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-xl font-bold text-white">Skills</h2>
        <p className="text-sm text-[#6b7280]">Add your key skills across categories</p>
      </div>

      {CATEGORIES.map(cat => (
        <TagInput
          key={cat.key}
          label={cat.label}
          placeholder={cat.placeholder}
          tags={skills[cat.key]}
          onAdd={(tag) => addSkill(cat.key, tag)}
          onRemove={(i) => removeSkill(cat.key, i)}
        />
      ))}
    </div>
  )
}
