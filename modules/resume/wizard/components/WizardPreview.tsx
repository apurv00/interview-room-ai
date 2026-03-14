'use client'

import { useMemo } from 'react'
import ResumePreview from '@resume/components/ResumePreview'
import type { ResumeData } from '@resume/validators/resume'
import type { WizardState } from '../hooks/useWizard'

interface Props {
  state: WizardState
}

export default function WizardPreview({ state }: Props) {
  const resumeData: ResumeData = useMemo(() => ({
    name: `Resume - ${state.contactInfo.fullName || 'Draft'}`,
    template: state.selectedTemplate,
    contactInfo: {
      fullName: state.contactInfo.fullName || '',
      email: state.contactInfo.email || '',
      phone: state.contactInfo.phone,
      location: state.contactInfo.city,
      linkedin: state.contactInfo.linkedInUrl,
    },
    summary: state.finalSummary || state.generatedSummary || undefined,
    experience: state.roles.map(r => ({
      id: r.id,
      company: r.company,
      title: r.title,
      location: r.location,
      startDate: r.startDate,
      endDate: r.endDate,
      bullets: r.finalBullets.length > 0
        ? r.finalBullets
        : r.enhancedBullets.length > 0
          ? r.enhancedBullets
          : r.rawBullets.filter(b => b.trim()),
    })),
    education: state.education.map(e => ({
      id: e.id,
      institution: e.institution,
      degree: e.degree,
      field: e.field,
      graduationDate: e.graduationDate,
      gpa: e.gpa,
      honors: e.honors,
    })),
    skills: [
      ...(state.skills.hard.length > 0 ? [{ category: 'Hard Skills', items: state.skills.hard }] : []),
      ...(state.skills.soft.length > 0 ? [{ category: 'Soft Skills', items: state.skills.soft }] : []),
      ...(state.skills.technical.length > 0 ? [{ category: 'Technical Skills', items: state.skills.technical }] : []),
    ],
    projects: state.projects.filter(p => p.name.trim()).map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      technologies: p.technologies,
      url: p.url,
    })),
    certifications: state.certifications.filter(c => c.name.trim()).map(c => ({
      name: c.name,
      issuer: c.issuer,
      date: c.date,
    })),
    styling: {
      fontFamily: state.fontFamily as 'georgia' | 'times' | 'garamond' | 'palatino' | 'calibri' | 'helvetica' | 'lato' | 'roboto',
      fontSize: state.fontSize as 'small' | 'medium' | 'large',
    },
  }), [state])

  return <ResumePreview data={resumeData} templateId={state.selectedTemplate} />
}
