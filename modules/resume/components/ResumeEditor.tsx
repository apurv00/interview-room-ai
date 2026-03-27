'use client'

import { useState } from 'react'
import type { ResumeData } from '../validators/resume'
import { useResume, DEFAULT_SECTION_ORDER } from '../hooks/useResume'
import { RESUME_TEMPLATES } from '../config/templates'
import ResumePreview from './ResumePreview'
import ContactInfoEditor from './sections/ContactInfoEditor'
import SummaryEditor from './sections/SummaryEditor'
import ExperienceEditor from './sections/ExperienceEditor'
import EducationEditor from './sections/EducationEditor'
import SkillsEditor from './sections/SkillsEditor'
import ProjectsEditor from './sections/ProjectsEditor'
import CertificationsEditor from './sections/CertificationsEditor'
import CustomSectionEditor from './sections/CustomSectionEditor'
import FileDropzone from '@interview/components/FileDropzone'
import FontStyleControls from './FontStyleControls'
import SortableList from './SortableList'
import SortableItem, { DragHandle } from './SortableItem'

interface Props {
  initialData?: Partial<ResumeData>
  resumeId?: string
  onSave: (data: ResumeData) => Promise<{ id?: string; error?: string; code?: string }>
}

export default function ResumeEditor({ initialData, resumeId, onSave }: Props) {
  const {
    resume, isDirty, update, setContactInfo,
    addExperience, updateExperience, removeExperience,
    addEducation, updateEducation, removeEducation,
    setSkills,
    addProject, updateProject, removeProject,
    setCertifications,
    addCustomSection, updateCustomSection, removeCustomSection,
    reorderExperience, reorderEducation, reorderProjects, reorderCustomSections,
    reorderBullets, reorderSections,
    loadResume, markClean,
  } = useResume(initialData)

  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [enhancingSection, setEnhancingSection] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [mobileTab, setMobileTab] = useState<'edit' | 'preview'>('edit')
  const [downloading, setDownloading] = useState(false)

  async function handleSave() {
    setSaving(true)
    setError('')
    const result = await onSave({ ...resume, id: resumeId })
    if (result.error) {
      setError(result.error)
    } else {
      setSaved(true)
      markClean()
      setTimeout(() => setSaved(false), 3000)
    }
    setSaving(false)
  }

  async function handleEnhanceSummary() {
    if (!resume.summary?.trim()) return
    setEnhancingSection('summary')
    try {
      const res = await fetch('/api/resume/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'enhance',
          sectionType: 'summary',
          currentContent: resume.summary,
          targetRole: resume.targetRole,
          targetCompany: resume.targetCompany,
        }),
      })
      const data = await res.json()
      if (data.enhanced) update('summary', data.enhanced)
    } catch { /* ignore */ }
    setEnhancingSection(null)
  }

  async function handleEnhanceBullets(expId: string) {
    const exp = resume.experience?.find(e => e.id === expId)
    if (!exp || exp.bullets.every(b => !b.trim())) return
    setEnhancingSection(expId)
    try {
      const res = await fetch('/api/resume/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'enhance_bullets',
          bullets: exp.bullets.filter(b => b.trim()),
          context: { role: exp.title, company: exp.company, targetRole: resume.targetRole },
        }),
      })
      const data = await res.json()
      if (data.bullets) updateExperience(expId, { bullets: data.bullets })
    } catch { /* ignore */ }
    setEnhancingSection(null)
  }

  async function handleUpload(file: File) {
    setUploading(true)
    setError('')
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('docType', 'resume')
      const uploadRes = await fetch('/api/documents/upload', { method: 'POST', body: formData })
      const uploadData = await uploadRes.json()
      if (!uploadRes.ok) { setError(uploadData.error || 'Upload failed'); setUploading(false); return }

      // Parse into structured data
      const parseRes = await fetch('/api/resume/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: uploadData.text }),
      })
      const parsed = await parseRes.json()
      if (parseRes.ok && parsed.contactInfo) {
        loadResume(parsed)
      } else {
        setError('Could not parse resume structure. Please fill in sections manually.')
      }
    } catch { setError('Upload failed') }
    setUploading(false)
  }

  async function handleImportProfile() {
    try {
      const res = await fetch('/api/resume/profile')
      const data = await res.json()
      if (res.ok && data) {
        loadResume(data)
      }
    } catch { /* ignore */ }
  }

  async function handleGenerateFull() {
    if (!resume.targetRole) return
    setEnhancingSection('full')
    try {
      const res = await fetch('/api/resume/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'generate_full',
          targetRole: resume.targetRole,
          targetCompany: resume.targetCompany,
          currentSections: [
            { type: 'summary', content: resume.summary || '' },
            ...(resume.experience || []).map(e => ({ type: 'experience', content: `${e.title} at ${e.company}: ${e.bullets.join('. ')}` })),
          ],
        }),
      })
      const data = await res.json()
      if (data.sections) {
        for (const s of data.sections) {
          if (s.type === 'summary' && s.content) update('summary', s.content)
        }
      }
    } catch { /* ignore */ }
    setEnhancingSection(null)
  }

  function handlePrintPDF() {
    // Client-side PDF via browser print dialog
    const previewEl = document.getElementById('resume-preview-container')
    if (!previewEl) { setError('Preview not found'); return }

    const printWindow = window.open('', '_blank')
    if (!printWindow) { setError('Pop-up blocked. Please allow pop-ups and try again.'); return }

    // Clone the preview content and render in a print-friendly window
    const content = previewEl.innerHTML
    printWindow.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${resume.name || 'Resume'}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    @page { size: A4; margin: 0; }
    body {
      font-family: 'Georgia', 'Times New Roman', serif;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .resume-print-wrapper {
      width: 210mm;
      min-height: 297mm;
      padding: 12mm 14mm;
      background: white;
    }
    @media print {
      body { margin: 0; }
      .resume-print-wrapper { padding: 10mm 12mm; }
    }
  </style>
</head>
<body>
  <div class="resume-print-wrapper">${content}</div>
  <script>
    window.onload = function() {
      setTimeout(function() { window.print(); window.close(); }, 300);
    };
  </script>
</body>
</html>`)
    printWindow.document.close()
  }

  async function handleDownloadPDF() {
    setDownloading(true)
    try {
      const res = await fetch('/api/resume/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resumeData: resume,
          templateId: resume.template || 'professional',
        }),
      })
      if (res.ok) {
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${resume.name || 'resume'}.pdf`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      } else {
        // Fallback to browser print
        handlePrintPDF()
      }
    } catch {
      // Fallback to browser print
      handlePrintPDF()
    }
    setDownloading(false)
  }

  return (
    <div className="h-full">
      {/* Mobile tab toggle */}
      <div className="md:hidden flex border-b border-[#e1e8ed] mb-4">
        <button
          onClick={() => setMobileTab('edit')}
          className={`flex-1 py-2 text-sm font-medium transition-colors ${mobileTab === 'edit' ? 'text-[#059669] border-b-2 border-[#059669]' : 'text-[#536471]'}`}
        >Edit</button>
        <button
          onClick={() => setMobileTab('preview')}
          className={`flex-1 py-2 text-sm font-medium transition-colors ${mobileTab === 'preview' ? 'text-[#059669] border-b-2 border-[#059669]' : 'text-[#536471]'}`}
        >Preview</button>
      </div>

      <div className="flex gap-6 h-full">
        {/* Editor Panel - 50% */}
        <div className={`w-1/2 shrink-0 overflow-y-auto space-y-5 pr-2 ${mobileTab === 'preview' ? 'hidden md:block' : ''}`}>
          {/* Top bar: name, actions */}
          <div className="flex items-center justify-between">
            <input
              type="text"
              value={resume.name}
              onChange={e => update('name', e.target.value)}
              className="text-xl font-bold text-[#0f1419] bg-transparent border-none focus:outline-none"
              placeholder="Resume Name"
            />
            <div className="flex gap-2">
              <button
                onClick={handlePrintPDF}
                className="px-3 py-1.5 bg-[#eff3f4] border border-[#e1e8ed] text-[#536471] text-xs rounded-lg font-medium hover:bg-[#e1e8ed] transition-colors"
              >
                Print PDF
              </button>
              <button
                onClick={handleDownloadPDF}
                disabled={downloading}
                className="px-3 py-1.5 bg-indigo-50 border border-indigo-200 text-indigo-600 text-xs rounded-lg font-medium hover:bg-indigo-100 transition-colors disabled:opacity-50"
              >
                {downloading ? 'Generating...' : 'Download PDF'}
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs rounded-lg font-medium transition-colors disabled:opacity-50"
              >
                {saving ? 'Saving...' : saved ? 'Saved!' : isDirty ? 'Save*' : 'Save'}
              </button>
            </div>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-2.5 text-xs text-red-600">
              {error}
            </div>
          )}

          {/* Upload / Import */}
          <div className="bg-[#f7f9f9] border border-[#e1e8ed] rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-[#536471]">Quick Start</h3>
              <button
                onClick={handleImportProfile}
                className="px-2.5 py-1 bg-[#eff3f4] hover:bg-[#e1e8ed] text-[#536471] text-[10px] rounded-lg font-medium transition-colors"
              >
                Import from Profile
              </button>
            </div>
            <FileDropzone
              label="Upload Resume (PDF, DOCX, TXT)"
              isUploading={uploading}
              onFileSelect={handleUpload}
              onRemove={() => {}}
              onError={setError}
            />
          </div>

          {/* Meta: target role, company, template */}
          <div className="bg-[#f7f9f9] border border-[#e1e8ed] rounded-2xl p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] text-[#8b98a5] uppercase tracking-wider">Target Role</label>
                <input
                  type="text"
                  value={resume.targetRole || ''}
                  onChange={e => update('targetRole', e.target.value)}
                  placeholder="e.g. Senior Product Manager"
                  className="w-full mt-1 px-3 py-2 bg-white border border-[#e1e8ed] rounded-lg text-sm text-[#0f1419] placeholder-[#8b98a5] focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label className="text-[10px] text-[#8b98a5] uppercase tracking-wider">Target Company</label>
                <input
                  type="text"
                  value={resume.targetCompany || ''}
                  onChange={e => update('targetCompany', e.target.value)}
                  placeholder="e.g. Google"
                  className="w-full mt-1 px-3 py-2 bg-white border border-[#e1e8ed] rounded-lg text-sm text-[#0f1419] placeholder-[#8b98a5] focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
            </div>

            {/* Template selector */}
            <div>
              <label className="text-[10px] text-[#8b98a5] uppercase tracking-wider">Template</label>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {RESUME_TEMPLATES.map(t => (
                  <button
                    key={t.id}
                    onClick={() => update('template', t.id)}
                    className={`px-2.5 py-1 rounded-lg text-[10px] font-medium transition-colors ${
                      resume.template === t.id
                        ? 'bg-emerald-600 text-white'
                        : 'bg-[#eff3f4] text-[#536471] hover:text-[#0f1419]'
                    }`}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            </div>

            {/* Font & Size */}
            <FontStyleControls
              fontFamily={resume.styling?.fontFamily || 'georgia'}
              headingSize={resume.styling?.headingSize ?? 18}
              bodySize={resume.styling?.bodySize ?? 9}
              onFontFamilyChange={f => update('styling', { ...resume.styling, fontFamily: f as 'georgia' | 'times' | 'garamond' | 'palatino' | 'calibri' | 'helvetica' | 'lato' | 'roboto' })}
              onHeadingSizeChange={s => update('styling', { ...resume.styling, headingSize: s })}
              onBodySizeChange={s => update('styling', { ...resume.styling, bodySize: s })}
            />

            {resume.targetRole && (
              <button
                onClick={handleGenerateFull}
                disabled={enhancingSection === 'full'}
                className="px-3 py-1.5 bg-indigo-50 border border-indigo-200 text-indigo-600 text-[10px] rounded-lg font-medium hover:bg-indigo-100 transition-colors disabled:opacity-50"
              >
                {enhancingSection === 'full' ? 'Generating...' : 'AI: Generate suggestions for all sections'}
              </button>
            )}
          </div>

          {/* Section editors — drag to reorder */}
          <SortableList
            items={resume.sectionOrder || DEFAULT_SECTION_ORDER}
            onReorder={reorderSections}
          >
            <div className="space-y-5">
              {(resume.sectionOrder || DEFAULT_SECTION_ORDER).map(sectionId => (
                <SortableItem key={sectionId} id={sectionId}>
                  {({ listeners, attributes }) => (
                    <div className="bg-[#f7f9f9] border border-[#e1e8ed] rounded-2xl p-4">
                      <div className="flex items-start gap-2">
                        <div className="pt-1">
                          <DragHandle listeners={listeners} attributes={attributes} />
                        </div>
                        <div className="flex-1 min-w-0">
                          {sectionId === 'contactInfo' && (
                            <ContactInfoEditor
                              data={resume.contactInfo || { fullName: '', email: '' }}
                              onChange={setContactInfo}
                            />
                          )}
                          {sectionId === 'summary' && (
                            <SummaryEditor
                              value={resume.summary || ''}
                              onChange={v => update('summary', v)}
                              onEnhance={handleEnhanceSummary}
                              enhancing={enhancingSection === 'summary'}
                            />
                          )}
                          {sectionId === 'experience' && (
                            <ExperienceEditor
                              items={resume.experience || []}
                              onAdd={addExperience}
                              onUpdate={updateExperience}
                              onRemove={removeExperience}
                              onEnhanceBullets={handleEnhanceBullets}
                              enhancingId={enhancingSection}
                              onReorder={reorderExperience}
                              onReorderBullets={reorderBullets}
                            />
                          )}
                          {sectionId === 'education' && (
                            <EducationEditor
                              items={resume.education || []}
                              onAdd={addEducation}
                              onUpdate={updateEducation}
                              onRemove={removeEducation}
                              onReorder={reorderEducation}
                            />
                          )}
                          {sectionId === 'skills' && (
                            <SkillsEditor
                              items={resume.skills || []}
                              onChange={setSkills}
                            />
                          )}
                          {sectionId === 'projects' && (
                            <ProjectsEditor
                              items={resume.projects || []}
                              onAdd={addProject}
                              onUpdate={updateProject}
                              onRemove={removeProject}
                              onReorder={reorderProjects}
                            />
                          )}
                          {sectionId === 'certifications' && (
                            <CertificationsEditor
                              items={resume.certifications || []}
                              onChange={setCertifications}
                            />
                          )}
                          {sectionId === 'customSections' && (
                            <CustomSectionEditor
                              items={resume.customSections || []}
                              onAdd={addCustomSection}
                              onUpdate={updateCustomSection}
                              onRemove={removeCustomSection}
                              onReorder={reorderCustomSections}
                            />
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </SortableItem>
              ))}
            </div>
          </SortableList>
        </div>

        {/* Preview Panel - 50% */}
        <div className={`w-1/2 shrink-0 sticky top-0 h-fit ${mobileTab === 'edit' ? 'hidden md:block' : ''}`}>
          <div className="text-[10px] text-[#8b98a5] uppercase tracking-wider mb-2 font-semibold">Live Preview</div>
          <ResumePreview data={resume} templateId={resume.template || 'professional'} />
        </div>
      </div>
    </div>
  )
}
