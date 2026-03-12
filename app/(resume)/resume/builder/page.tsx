'use client'

import { useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import FileDropzone from '@/components/FileDropzone'

interface ResumeSection {
  id: string
  type: 'summary' | 'experience' | 'education' | 'skills' | 'projects' | 'certifications' | 'custom'
  title: string
  content: string
  aiSuggestion?: string
}

const DEFAULT_SECTIONS: ResumeSection[] = [
  { id: 'summary', type: 'summary', title: 'Professional Summary', content: '' },
  { id: 'experience', type: 'experience', title: 'Work Experience', content: '' },
  { id: 'education', type: 'education', title: 'Education', content: '' },
  { id: 'skills', type: 'skills', title: 'Skills', content: '' },
  { id: 'projects', type: 'projects', title: 'Projects', content: '' },
]

export default function ResumeBuilderPage() {
  const router = useRouter()
  const { status: authStatus } = useSession()
  const [sections, setSections] = useState<ResumeSection[]>(DEFAULT_SECTIONS)
  const [resumeName, setResumeName] = useState('My Resume')
  const [targetRole, setTargetRole] = useState('')
  const [targetCompany, setTargetCompany] = useState('')
  const [generating, setGenerating] = useState(false)
  const [enhancingId, setEnhancingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (authStatus === 'unauthenticated') router.push('/signin')
  }, [authStatus, router])

  async function handleResumeUpload(file: File) {
    setUploadError('')
    setUploading(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('docType', 'resume')
      const res = await fetch('/api/documents/upload', { method: 'POST', body: formData })
      const data = await res.json()
      if (!res.ok) { setUploadError(data.error || 'Upload failed'); return }

      // Parse the resume text into sections
      const text = data.text as string
      const newSections = [...DEFAULT_SECTIONS]
      // Auto-populate experience section with the full resume text
      const expIdx = newSections.findIndex(s => s.type === 'experience')
      if (expIdx >= 0) {
        newSections[expIdx].content = text
      }
      setSections(newSections)
    } catch { setUploadError('Upload failed') }
    finally { setUploading(false) }
  }

  async function enhanceSection(sectionId: string) {
    const section = sections.find(s => s.id === sectionId)
    if (!section || !section.content.trim()) return

    setEnhancingId(sectionId)
    try {
      const res = await fetch('/api/resume/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'enhance',
          sectionType: section.type,
          currentContent: section.content,
          targetRole,
          targetCompany,
        }),
      })
      const data = await res.json()
      if (data.enhanced) {
        setSections(prev => prev.map(s =>
          s.id === sectionId ? { ...s, aiSuggestion: data.enhanced } : s
        ))
      }
    } catch { /* ignore */ }
    setEnhancingId(null)
  }

  function acceptSuggestion(sectionId: string) {
    setSections(prev => prev.map(s =>
      s.id === sectionId && s.aiSuggestion
        ? { ...s, content: s.aiSuggestion, aiSuggestion: undefined }
        : s
    ))
  }

  function addSection() {
    const id = `custom-${Date.now()}`
    setSections(prev => [...prev, { id, type: 'custom', title: 'Custom Section', content: '' }])
  }

  function removeSection(id: string) {
    setSections(prev => prev.filter(s => s.id !== id))
  }

  async function handleSave() {
    setSaving(true)
    try {
      await fetch('/api/resume/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: resumeName,
          targetRole,
          targetCompany,
          sections: sections.map(s => ({ type: s.type, title: s.title, content: s.content })),
        }),
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch { /* ignore */ }
    setSaving(false)
  }

  async function generateFull() {
    if (!targetRole) return
    setGenerating(true)
    try {
      const res = await fetch('/api/resume/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'generate_full',
          targetRole,
          targetCompany,
          currentSections: sections.filter(s => s.content.trim()).map(s => ({
            type: s.type, content: s.content,
          })),
        }),
      })
      const data = await res.json()
      if (data.sections) {
        setSections(prev => prev.map(s => {
          const generated = data.sections.find((g: { type: string; content: string }) => g.type === s.type)
          return generated ? { ...s, aiSuggestion: generated.content } : s
        }))
      }
    } catch { /* ignore */ }
    setGenerating(false)
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Resume Builder</h1>
        <div className="flex gap-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm rounded-xl font-medium transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Resume'}
          </button>
        </div>
      </div>

      {/* Upload existing resume */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <h2 className="text-sm font-semibold text-slate-300 mb-3">Start from existing resume</h2>
        <FileDropzone
          label="Upload Resume"
          isUploading={uploading}
          onFileSelect={handleResumeUpload}
          onRemove={() => {}}
          onError={setUploadError}
        />
        {uploadError && <p className="text-xs text-red-400 mt-2">{uploadError}</p>}
      </div>

      {/* Resume metadata */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
        <div className="grid md:grid-cols-3 gap-4">
          <div className="space-y-1.5">
            <label className="text-[10px] text-slate-500 uppercase tracking-wider">Resume Name</label>
            <input
              type="text"
              value={resumeName}
              onChange={e => setResumeName(e.target.value)}
              className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-[10px] text-slate-500 uppercase tracking-wider">Target Role</label>
            <input
              type="text"
              value={targetRole}
              onChange={e => setTargetRole(e.target.value)}
              placeholder="e.g. Senior Product Manager"
              className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-[10px] text-slate-500 uppercase tracking-wider">Target Company</label>
            <input
              type="text"
              value={targetCompany}
              onChange={e => setTargetCompany(e.target.value)}
              placeholder="e.g. Google"
              className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>
        </div>

        {targetRole && (
          <button
            onClick={generateFull}
            disabled={generating}
            className="px-4 py-2 bg-indigo-600/20 border border-indigo-500/30 hover:bg-indigo-600/30 text-indigo-400 text-xs rounded-lg font-medium transition-colors disabled:opacity-50"
          >
            {generating ? 'Generating...' : 'AI: Generate suggestions for all sections'}
          </button>
        )}
      </div>

      {/* Resume sections */}
      <div className="space-y-4">
        {sections.map(section => (
          <div key={section.id} className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
            <div className="flex items-center justify-between">
              <input
                type="text"
                value={section.title}
                onChange={e => setSections(prev => prev.map(s =>
                  s.id === section.id ? { ...s, title: e.target.value } : s
                ))}
                className="text-sm font-semibold text-white bg-transparent border-none focus:outline-none"
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={() => enhanceSection(section.id)}
                  disabled={enhancingId === section.id || !section.content.trim()}
                  className="px-2.5 py-1 bg-emerald-600/10 border border-emerald-500/20 text-emerald-400 text-[10px] rounded-lg font-medium transition-colors hover:bg-emerald-600/20 disabled:opacity-30"
                >
                  {enhancingId === section.id ? 'Enhancing...' : 'AI Enhance'}
                </button>
                {section.type === 'custom' && (
                  <button onClick={() => removeSection(section.id)} className="text-slate-500 hover:text-red-400 transition-colors">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            </div>

            <textarea
              value={section.content}
              onChange={e => setSections(prev => prev.map(s =>
                s.id === section.id ? { ...s, content: e.target.value } : s
              ))}
              placeholder={`Enter your ${section.title.toLowerCase()} here...`}
              rows={4}
              className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y"
            />

            {section.aiSuggestion && (
              <div className="bg-emerald-500/5 border border-emerald-500/15 rounded-xl p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-emerald-400 font-semibold uppercase tracking-wider">AI Suggestion</span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => acceptSuggestion(section.id)}
                      className="px-2 py-1 bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] rounded-lg font-medium transition-colors"
                    >
                      Accept
                    </button>
                    <button
                      onClick={() => setSections(prev => prev.map(s =>
                        s.id === section.id ? { ...s, aiSuggestion: undefined } : s
                      ))}
                      className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-300 text-[10px] rounded-lg font-medium transition-colors"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
                <p className="text-xs text-slate-300 whitespace-pre-wrap">{section.aiSuggestion}</p>
              </div>
            )}
          </div>
        ))}

        <button
          onClick={addSection}
          className="w-full py-3 border border-dashed border-slate-700 rounded-2xl text-sm text-slate-500 hover:text-slate-300 hover:border-slate-600 transition-colors"
        >
          + Add Section
        </button>
      </div>
    </div>
  )
}
