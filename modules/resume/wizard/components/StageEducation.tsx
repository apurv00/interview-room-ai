'use client'

import { useCallback } from 'react'
import Input from '@shared/ui/Input'
import Button from '@shared/ui/Button'
import type { WizardEducation } from '../hooks/useWizard'

interface Props {
  education: WizardEducation[]
  onChange: (education: WizardEducation[]) => void
}

function createEmptyEdu(): WizardEducation {
  return {
    id: `edu_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    institution: '',
    degree: '',
  }
}

export default function StageEducation({ education, onChange }: Props) {
  const addEntry = useCallback(() => {
    onChange([...education, createEmptyEdu()])
  }, [education, onChange])

  const updateEntry = useCallback((id: string, field: keyof WizardEducation, value: string) => {
    onChange(education.map(e => e.id === id ? { ...e, [field]: value } : e))
  }, [education, onChange])

  const removeEntry = useCallback((id: string) => {
    onChange(education.filter(e => e.id !== id))
  }, [education, onChange])

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-xl font-bold text-white">Education</h2>
        <p className="text-sm text-[#6b7280]">Add your educational background</p>
      </div>

      {education.length === 0 && (
        <div className="text-center py-8">
          <p className="text-sm text-[#4b5563] mb-3">No education added yet</p>
          <Button variant="primary" size="sm" onClick={addEntry}>Add Education</Button>
        </div>
      )}

      {education.map((entry, i) => (
        <div
          key={entry.id}
          className="bg-surface border border-[rgba(255,255,255,0.06)] rounded-xl p-4 space-y-3"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[#6366f1]">Education {i + 1}</span>
            {education.length > 1 && (
              <button onClick={() => removeEntry(entry.id)} className="text-xs text-[#4b5563] hover:text-[#f87171] transition-colors">
                Remove
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label="Institution"
              value={entry.institution}
              onChange={e => updateEntry(entry.id, 'institution', e.target.value)}
              placeholder="University of California"
            />
            <Input
              label="Degree"
              value={entry.degree}
              onChange={e => updateEntry(entry.id, 'degree', e.target.value)}
              placeholder="Bachelor of Science"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Input
              label="Field of Study"
              value={entry.field || ''}
              onChange={e => updateEntry(entry.id, 'field', e.target.value)}
              placeholder="Computer Science"
            />
            <Input
              label="Graduation Date"
              value={entry.graduationDate || ''}
              onChange={e => updateEntry(entry.id, 'graduationDate', e.target.value)}
              placeholder="May 2023"
            />
            <Input
              label="GPA (optional)"
              value={entry.gpa || ''}
              onChange={e => updateEntry(entry.id, 'gpa', e.target.value)}
              placeholder="3.8"
            />
          </div>

          <Input
            label="Honors / Awards (optional)"
            value={entry.honors || ''}
            onChange={e => updateEntry(entry.id, 'honors', e.target.value)}
            placeholder="Dean's List, Magna Cum Laude"
          />
        </div>
      ))}

      {education.length > 0 && education.length < 5 && (
        <Button variant="secondary" size="sm" onClick={addEntry} isFullWidth>
          + Add Another Degree
        </Button>
      )}
    </div>
  )
}
