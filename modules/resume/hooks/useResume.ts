import { useState, useCallback, useMemo } from 'react'
import type { ResumeData, ResumeContactInfo, ResumeExperience, ResumeEducation, ResumeSkillCategory, ResumeProject, ResumeCertification, ResumeCustomSection } from '../validators/resume'

const DEFAULT_RESUME: ResumeData = {
  name: 'My Resume',
  template: 'professional',
  targetRole: '',
  targetCompany: '',
  contactInfo: { fullName: '', email: '' },
  summary: '',
  experience: [],
  education: [],
  skills: [],
  projects: [],
  certifications: [],
  customSections: [],
}

export function useResume(initial?: Partial<ResumeData>) {
  const [resume, setResume] = useState<ResumeData>({ ...DEFAULT_RESUME, ...initial })
  const [isDirty, setDirty] = useState(false)

  const update = useCallback(<K extends keyof ResumeData>(key: K, value: ResumeData[K]) => {
    setResume(prev => ({ ...prev, [key]: value }))
    setDirty(true)
  }, [])

  const setContactInfo = useCallback((info: Partial<ResumeContactInfo>) => {
    setResume(prev => ({
      ...prev,
      contactInfo: { ...(prev.contactInfo || { fullName: '', email: '' }), ...info },
    }))
    setDirty(true)
  }, [])

  // Experience CRUD
  const addExperience = useCallback((exp: ResumeExperience) => {
    setResume(prev => ({ ...prev, experience: [...(prev.experience || []), exp] }))
    setDirty(true)
  }, [])

  const updateExperience = useCallback((id: string, data: Partial<ResumeExperience>) => {
    setResume(prev => ({
      ...prev,
      experience: (prev.experience || []).map(e => e.id === id ? { ...e, ...data } : e),
    }))
    setDirty(true)
  }, [])

  const removeExperience = useCallback((id: string) => {
    setResume(prev => ({
      ...prev,
      experience: (prev.experience || []).filter(e => e.id !== id),
    }))
    setDirty(true)
  }, [])

  // Education CRUD
  const addEducation = useCallback((edu: ResumeEducation) => {
    setResume(prev => ({ ...prev, education: [...(prev.education || []), edu] }))
    setDirty(true)
  }, [])

  const updateEducation = useCallback((id: string, data: Partial<ResumeEducation>) => {
    setResume(prev => ({
      ...prev,
      education: (prev.education || []).map(e => e.id === id ? { ...e, ...data } : e),
    }))
    setDirty(true)
  }, [])

  const removeEducation = useCallback((id: string) => {
    setResume(prev => ({
      ...prev,
      education: (prev.education || []).filter(e => e.id !== id),
    }))
    setDirty(true)
  }, [])

  // Skills
  const setSkills = useCallback((skills: ResumeSkillCategory[]) => {
    setResume(prev => ({ ...prev, skills }))
    setDirty(true)
  }, [])

  // Projects CRUD
  const addProject = useCallback((proj: ResumeProject) => {
    setResume(prev => ({ ...prev, projects: [...(prev.projects || []), proj] }))
    setDirty(true)
  }, [])

  const updateProject = useCallback((id: string, data: Partial<ResumeProject>) => {
    setResume(prev => ({
      ...prev,
      projects: (prev.projects || []).map(p => p.id === id ? { ...p, ...data } : p),
    }))
    setDirty(true)
  }, [])

  const removeProject = useCallback((id: string) => {
    setResume(prev => ({
      ...prev,
      projects: (prev.projects || []).filter(p => p.id !== id),
    }))
    setDirty(true)
  }, [])

  // Certifications
  const setCertifications = useCallback((certs: ResumeCertification[]) => {
    setResume(prev => ({ ...prev, certifications: certs }))
    setDirty(true)
  }, [])

  // Custom sections
  const addCustomSection = useCallback((section: ResumeCustomSection) => {
    setResume(prev => ({ ...prev, customSections: [...(prev.customSections || []), section] }))
    setDirty(true)
  }, [])

  const updateCustomSection = useCallback((id: string, data: Partial<ResumeCustomSection>) => {
    setResume(prev => ({
      ...prev,
      customSections: (prev.customSections || []).map(s => s.id === id ? { ...s, ...data } : s),
    }))
    setDirty(true)
  }, [])

  const removeCustomSection = useCallback((id: string) => {
    setResume(prev => ({
      ...prev,
      customSections: (prev.customSections || []).filter(s => s.id !== id),
    }))
    setDirty(true)
  }, [])

  // Load full resume (e.g., from API or profile import)
  const loadResume = useCallback((data: Partial<ResumeData>) => {
    setResume(prev => ({ ...prev, ...data }))
    setDirty(false)
  }, [])

  const markClean = useCallback(() => setDirty(false), [])

  // Check if resume has any content
  const hasContent = useMemo(() => {
    return !!(
      resume.summary ||
      (resume.experience?.length) ||
      (resume.education?.length) ||
      (resume.skills?.length) ||
      (resume.projects?.length) ||
      (resume.certifications?.length) ||
      (resume.customSections?.length)
    )
  }, [resume])

  return {
    resume,
    isDirty,
    hasContent,
    update,
    setContactInfo,
    addExperience, updateExperience, removeExperience,
    addEducation, updateEducation, removeEducation,
    setSkills,
    addProject, updateProject, removeProject,
    setCertifications,
    addCustomSection, updateCustomSection, removeCustomSection,
    loadResume,
    markClean,
  }
}
