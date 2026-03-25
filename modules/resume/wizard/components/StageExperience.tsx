'use client'

import { useCallback } from 'react'
import Input from '@shared/ui/Input'
import Button from '@shared/ui/Button'
import type { WizardRole } from '../hooks/useWizard'

interface Props {
  roles: WizardRole[]
  onAddRole: (role: WizardRole) => void
  onUpdateRole: (roleId: string, data: Partial<WizardRole>) => void
  onRemoveRole: (roleId: string) => void
}

function createEmptyRole(): WizardRole {
  return {
    id: `role_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    company: '',
    title: '',
    startDate: '',
    rawBullets: [''],
    followUpQuestions: [],
    enhancedBullets: [],
    bulletDecisions: [],
    finalBullets: [],
  }
}

export default function StageExperience({ roles, onAddRole, onUpdateRole, onRemoveRole }: Props) {
  const addRole = useCallback(() => {
    onAddRole(createEmptyRole())
  }, [onAddRole])

  const updateBullet = useCallback((roleId: string, index: number, value: string, currentBullets: string[]) => {
    const updated = [...currentBullets]
    updated[index] = value
    onUpdateRole(roleId, { rawBullets: updated })
  }, [onUpdateRole])

  const addBullet = useCallback((roleId: string, currentBullets: string[]) => {
    onUpdateRole(roleId, { rawBullets: [...currentBullets, ''] })
  }, [onUpdateRole])

  const removeBullet = useCallback((roleId: string, index: number, currentBullets: string[]) => {
    if (currentBullets.length <= 1) return
    onUpdateRole(roleId, { rawBullets: currentBullets.filter((_, i) => i !== index) })
  }, [onUpdateRole])

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-xl font-bold text-[#0f1419]">Work Experience</h2>
        <p className="text-sm text-[#6b7280]">Add your roles — we&apos;ll help you write powerful bullet points</p>
      </div>

      {roles.length === 0 && (
        <div className="text-center py-8">
          <p className="text-sm text-[#8b98a5] mb-3">No roles added yet</p>
          <Button variant="primary" size="sm" onClick={addRole}>Add Your First Role</Button>
        </div>
      )}

      {roles.map((role, roleIndex) => (
        <div
          key={role.id}
          className="bg-surface border border-[#e1e8ed] rounded-xl p-4 space-y-3"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[#6366f1]">Role {roleIndex + 1}</span>
            {roles.length > 1 && (
              <button
                onClick={() => onRemoveRole(role.id)}
                className="text-xs text-[#8b98a5] hover:text-[#f87171] transition-colors"
              >
                Remove
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label="Job Title"
              value={role.title}
              onChange={e => onUpdateRole(role.id, { title: e.target.value })}
              placeholder="Software Engineer"
            />
            <Input
              label="Company"
              value={role.company}
              onChange={e => onUpdateRole(role.id, { company: e.target.value })}
              placeholder="Acme Inc."
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Input
              label="Location"
              value={role.location || ''}
              onChange={e => onUpdateRole(role.id, { location: e.target.value })}
              placeholder="San Francisco, CA"
            />
            <Input
              label="Start Date"
              value={role.startDate}
              onChange={e => onUpdateRole(role.id, { startDate: e.target.value })}
              placeholder="Jan 2023"
            />
            <Input
              label="End Date"
              value={role.endDate || ''}
              onChange={e => onUpdateRole(role.id, { endDate: e.target.value })}
              placeholder="Present"
            />
          </div>

          <div className="space-y-2">
            <label className="text-caption text-[#536471]">What did you do? (one point per line)</label>
            {role.rawBullets.map((bullet, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="text-[10px] text-[#8b98a5] mt-2.5 shrink-0">
                  {i + 1}.
                </span>
                <textarea
                  value={bullet}
                  onChange={e => updateBullet(role.id, i, e.target.value, role.rawBullets)}
                  placeholder="Describe what you did — we'll polish it later"
                  rows={2}
                  className="flex-1 bg-surface text-sm text-[#0f1419] placeholder-[#8b98a5] border border-[#e1e8ed] rounded-[6px] px-3 py-2 focus:outline-none focus:border-[#6366f1] focus:ring-1 focus:ring-[rgba(99,102,241,0.15)] transition-all duration-[120ms] resize-none"
                />
                {role.rawBullets.length > 1 && (
                  <button
                    onClick={() => removeBullet(role.id, i, role.rawBullets)}
                    className="text-[#8b98a5] hover:text-[#f87171] mt-2 transition-colors shrink-0"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            ))}
            <button
              onClick={() => addBullet(role.id, role.rawBullets)}
              className="text-xs text-[#6366f1] hover:text-[#6366f1] transition-colors"
            >
              + Add another point
            </button>
          </div>
        </div>
      ))}

      {roles.length > 0 && roles.length < 10 && (
        <Button variant="secondary" size="sm" onClick={addRole} isFullWidth>
          + Add Another Role
        </Button>
      )}
    </div>
  )
}
