'use client'

import { useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import FileDropzone from '@interview/components/FileDropzone'

interface SavedResume {
  id: string
  name: string
  targetRole: string
}

interface ATSResult {
  score: number
  issues: Array<{ category: string; severity: 'critical' | 'warning' | 'info'; message: string; fix: string }>
  keywords: { found: string[]; missing: string[]; total: number }
  formatting: { score: number; issues: string[] }
  sections: { found: string[]; missing: string[]; recommended: string[] }
  summary: string
}

export default function ATSCheckPage() {
  const router = useRouter()
  const { status: authStatus } = useSession()
  const [savedResumes, setSavedResumes] = useState<SavedResume[]>([])
  const [resumeText, setResumeText] = useState('')
  const [resumeSource, setResumeSource] = useState<'upload' | 'saved'>('upload')
  const [resumeFileName, setResumeFileName] = useState('')
  const [jobDescription, setJobDescription] = useState('')
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<ATSResult | null>(null)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)

  useEffect(() => {
    if (authStatus === 'unauthenticated') router.push('/signin')
    if (authStatus === 'authenticated') {
      fetch('/api/resume/save')
        .then(r => r.json())
        .then(data => setSavedResumes(data.resumes || []))
        .catch(() => {})
    }
  }, [authStatus, router])

  async function handleSelectSaved(id: string) {
    const resume = savedResumes.find(r => r.id === id)
    if (!resume) return
    try {
      const res = await fetch(`/api/resume/save?id=${id}`)
      const data = await res.json()
      if (data.fullText) {
        setResumeText(data.fullText)
        setResumeFileName(resume.name)
        setResumeSource('saved')
      }
    } catch { /* ignore */ }
  }

  async function handleUpload(file: File) {
    setUploading(true)
    setError('')
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('docType', 'resume')
      const res = await fetch('/api/documents/upload', { method: 'POST', body: formData })
      const data = await res.json()
      if (res.ok) {
        setResumeText(data.text)
        setResumeFileName(data.fileName)
        setResumeSource('upload')
      } else setError(data.error || 'Upload failed')
    } catch { setError('Upload failed') }
    setUploading(false)
  }

  async function handleCheck() {
    if (!resumeText) { setError('Upload a resume or select a saved one first'); return }
    setError('')
    setChecking(true)
    try {
      const res = await fetch('/api/resume/ats-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resumeText, jobDescription: jobDescription || undefined }),
      })
      const data = await res.json()
      if (res.ok) setResult(data)
      else setError(data.error || 'Check failed')
    } catch { setError('Network error') }
    setChecking(false)
  }

  const severityStyles = {
    critical: { bg: 'bg-red-500/10', border: 'border-red-500/20', text: 'text-red-400' },
    warning: { bg: 'bg-amber-500/10', border: 'border-amber-500/20', text: 'text-amber-400' },
    info: { bg: 'bg-blue-500/10', border: 'border-blue-500/20', text: 'text-[#2563eb]' },
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-[#0f1419]">ATS Compatibility Check</h1>
      <p className="text-sm text-[#536471]">
        Score your resume against Applicant Tracking System parsers and get specific fixes.
      </p>

      {!result ? (
        <div className="space-y-6">
          <div className="bg-white border border-[#e1e8ed] rounded-2xl p-5 space-y-3">
            <h2 className="text-sm font-semibold text-[#536471]">Select Resume</h2>

            {/* Saved resumes dropdown */}
            {savedResumes.length > 0 && (
              <div>
                <label className="text-[10px] text-[#71767b] uppercase tracking-wider">From Saved Resumes</label>
                <select
                  onChange={e => e.target.value && handleSelectSaved(e.target.value)}
                  className="w-full mt-1 px-3 py-2.5 bg-[#f8fafc] border border-[#e1e8ed] rounded-xl text-sm text-[#0f1419] focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  defaultValue=""
                >
                  <option value="">Choose a saved resume...</option>
                  {savedResumes.map(r => (
                    <option key={r.id} value={r.id}>{r.name}{r.targetRole ? ` — ${r.targetRole}` : ''}</option>
                  ))}
                </select>
              </div>
            )}

            {savedResumes.length > 0 && <div className="text-center text-[10px] text-[#8b98a5]">or</div>}

            {!resumeText ? (
              <FileDropzone label="Upload Resume" isUploading={uploading} onFileSelect={handleUpload} onRemove={() => {}} onError={setError} />
            ) : (
              <div className="flex items-center justify-between bg-emerald-500/5 border border-emerald-500/15 rounded-xl px-4 py-3">
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-[#059669]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  <span className="text-sm text-[#059669]">{resumeFileName || 'Resume loaded'}</span>
                  <span className="text-[10px] text-[#71767b]">({resumeSource === 'saved' ? 'saved' : 'uploaded'})</span>
                </div>
                <button onClick={() => { setResumeText(''); setResumeFileName('') }} className="text-xs text-[#71767b] hover:text-[#536471]">
                  Remove
                </button>
              </div>
            )}
          </div>

          <div className="bg-white border border-[#e1e8ed] rounded-2xl p-5 space-y-3">
            <h2 className="text-sm font-semibold text-[#536471]">Job Description (optional, improves keyword analysis)</h2>
            <textarea
              value={jobDescription}
              onChange={e => setJobDescription(e.target.value)}
              placeholder="Paste job description for keyword matching..."
              rows={5}
              className="w-full px-3 py-2.5 bg-[#f8fafc] border border-[#e1e8ed] rounded-xl text-sm text-[#0f1419] placeholder-[#8b98a5] focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y"
            />
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <button
            onClick={handleCheck}
            disabled={checking || !resumeText}
            className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-medium transition-colors disabled:opacity-50"
          >
            {checking ? 'Analyzing...' : 'Run ATS Check'}
          </button>
        </div>
      ) : (
        <div className="space-y-6 animate-fade-in">
          <div className="bg-white border border-[#e1e8ed] rounded-2xl p-6 text-center">
            <p className="text-sm text-[#536471] mb-2">ATS Compatibility Score</p>
            <p className={`text-5xl font-bold ${result.score >= 80 ? 'text-[#059669]' : result.score >= 60 ? 'text-amber-400' : 'text-red-400'}`}>
              {result.score}
            </p>
            <p className="text-xs text-[#71767b] mt-2">{result.summary}</p>
          </div>

          {result.issues.length > 0 && (
            <div className="bg-white border border-[#e1e8ed] rounded-2xl p-5 space-y-3">
              <h3 className="text-sm font-semibold text-[#536471]">Issues Found ({result.issues.length})</h3>
              {result.issues.map((issue, i) => {
                const style = severityStyles[issue.severity]
                return (
                  <div key={i} className={`${style.bg} border ${style.border} rounded-xl p-3`}>
                    <div className="flex items-start gap-2">
                      <span className={`text-[10px] font-bold ${style.text} uppercase mt-0.5`}>{issue.severity}</span>
                      <div>
                        <p className="text-xs text-[#536471]">{issue.message}</p>
                        <p className="text-[11px] text-[#71767b] mt-1">Fix: {issue.fix}</p>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          <div className="bg-white border border-[#e1e8ed] rounded-2xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-[#536471]">Formatting</h3>
              <span className={`text-sm font-bold ${result.formatting.score >= 80 ? 'text-[#059669]' : 'text-amber-400'}`}>
                {result.formatting.score}/100
              </span>
            </div>
            {result.formatting.issues.length > 0 && (
              <ul className="space-y-1">
                {result.formatting.issues.map((issue, i) => (
                  <li key={i} className="text-xs text-[#536471] flex items-start gap-1.5">
                    <span className="text-amber-400 mt-0.5">-</span> {issue}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <div className="bg-white border border-[#e1e8ed] rounded-2xl p-5">
              <h3 className="text-xs font-semibold text-[#059669] uppercase tracking-wider mb-2">Sections Found</h3>
              <div className="flex flex-wrap gap-1.5">
                {result.sections.found.map((s, i) => (
                  <span key={i} className="px-2 py-0.5 bg-emerald-500/10 border border-emerald-500/20 rounded text-[10px] text-[#059669]">{s}</span>
                ))}
              </div>
            </div>
            <div className="bg-white border border-[#e1e8ed] rounded-2xl p-5">
              <h3 className="text-xs font-semibold text-amber-400 uppercase tracking-wider mb-2">Recommended Sections</h3>
              <div className="flex flex-wrap gap-1.5">
                {result.sections.recommended.map((s, i) => (
                  <span key={i} className="px-2 py-0.5 bg-amber-500/10 border border-amber-500/20 rounded text-[10px] text-amber-400">{s}</span>
                ))}
              </div>
            </div>
          </div>

          <button onClick={() => setResult(null)} className="text-sm text-[#2563eb] hover:text-blue-500 transition-colors">
            Check Another Resume
          </button>
        </div>
      )}
    </div>
  )
}
