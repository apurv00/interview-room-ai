'use client'

import { useCallback } from 'react'
import Input from '@shared/ui/Input'
import Button from '@shared/ui/Button'
import type { WizardProject, WizardCertification } from '../hooks/useWizard'

interface Props {
  projects: WizardProject[]
  certifications: WizardCertification[]
  onProjectsChange: (projects: WizardProject[]) => void
  onCertificationsChange: (certs: WizardCertification[]) => void
}

export default function StageExtras({ projects, certifications, onProjectsChange, onCertificationsChange }: Props) {
  const addProject = useCallback(() => {
    onProjectsChange([...projects, {
      id: `proj_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: '',
      description: '',
    }])
  }, [projects, onProjectsChange])

  const updateProject = useCallback((id: string, field: keyof WizardProject, value: string | string[]) => {
    onProjectsChange(projects.map(p => p.id === id ? { ...p, [field]: value } : p))
  }, [projects, onProjectsChange])

  const removeProject = useCallback((id: string) => {
    onProjectsChange(projects.filter(p => p.id !== id))
  }, [projects, onProjectsChange])

  const addCert = useCallback(() => {
    onCertificationsChange([...certifications, { name: '', issuer: '' }])
  }, [certifications, onCertificationsChange])

  const updateCert = useCallback((index: number, field: keyof WizardCertification, value: string) => {
    onCertificationsChange(certifications.map((c, i) => i === index ? { ...c, [field]: value } : c))
  }, [certifications, onCertificationsChange])

  const removeCert = useCallback((index: number) => {
    onCertificationsChange(certifications.filter((_, i) => i !== index))
  }, [certifications, onCertificationsChange])

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h2 className="text-xl font-bold text-[#0f1419]">Projects & Certifications</h2>
        <p className="text-sm text-[#6b7280]">Optional but adds strength to your resume</p>
      </div>

      {/* Projects */}
      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-[#536471]">Projects</h3>
        {projects.map((proj, i) => (
          <div key={proj.id} className="bg-surface border border-[#e1e8ed] rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-[#6366f1]">Project {i + 1}</span>
              <button onClick={() => removeProject(proj.id)} className="text-xs text-[#8b98a5] hover:text-[#f87171] transition-colors">
                Remove
              </button>
            </div>
            <Input
              label="Project Name"
              value={proj.name}
              onChange={e => updateProject(proj.id, 'name', e.target.value)}
              placeholder="E-commerce Platform"
            />
            <div>
              <label className="text-caption text-[#536471]">Description</label>
              <textarea
                value={proj.description}
                onChange={e => updateProject(proj.id, 'description', e.target.value)}
                placeholder="Brief description of the project and your contribution"
                rows={2}
                className="w-full mt-1.5 bg-surface text-sm text-[#0f1419] placeholder-[#8b98a5] border border-[#e1e8ed] rounded-[6px] px-3 py-2 focus:outline-none focus:border-[#6366f1] focus:ring-1 focus:ring-[rgba(99,102,241,0.15)] transition-all duration-[120ms] resize-none"
              />
            </div>
            <Input
              label="URL (optional)"
              value={proj.url || ''}
              onChange={e => updateProject(proj.id, 'url', e.target.value)}
              placeholder="https://github.com/..."
            />
          </div>
        ))}
        <Button variant="secondary" size="sm" onClick={addProject}>
          + Add Project
        </Button>
      </div>

      {/* Certifications */}
      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-[#536471]">Certifications</h3>
        {certifications.map((cert, i) => (
          <div key={i} className="bg-surface border border-[#e1e8ed] rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-[#6366f1]">Certification {i + 1}</span>
              <button onClick={() => removeCert(i)} className="text-xs text-[#8b98a5] hover:text-[#f87171] transition-colors">
                Remove
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input
                label="Name"
                value={cert.name}
                onChange={e => updateCert(i, 'name', e.target.value)}
                placeholder="AWS Solutions Architect"
              />
              <Input
                label="Issuer"
                value={cert.issuer}
                onChange={e => updateCert(i, 'issuer', e.target.value)}
                placeholder="Amazon Web Services"
              />
            </div>
            <Input
              label="Date (optional)"
              value={cert.date || ''}
              onChange={e => updateCert(i, 'date', e.target.value)}
              placeholder="Mar 2024"
            />
          </div>
        ))}
        <Button variant="secondary" size="sm" onClick={addCert}>
          + Add Certification
        </Button>
      </div>
    </div>
  )
}
