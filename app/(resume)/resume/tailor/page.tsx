'use client'

import { useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import FileDropzone from '@shared/ui/FileDropzone'
import { useAuthGate } from '@shared/providers/AuthGateProvider'
import { Check, AlertTriangle } from 'lucide-react'

interface SavedResume {
  id: string
  name: string
  targetRole: string
}

interface TailorResult {
  tailoredResume: string
  changes: Array<{ section: string; change: string; reason: string }>
  matchScore: number
  missingKeywords: string[]
  addedKeywords: string[]
}

export default function TailorPage() {
  const router = useRouter()
  const { status: authStatus } = useSession()
  const { requireAuth } = useAuthGate()
  const isAnonymous = authStatus !== 'authenticated'
  const [savedResumes, setSavedResumes] = useState<SavedResume[]>([])
  const [resumeText, setResumeText] = useState('')
  const [resumeSource, setResumeSource] = useState<'upload' | 'saved'>('upload')
  const [resumeFileName, setResumeFileName] = useState('')
  const [jobDescription, setJobDescription] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [tailoring, setTailoring] = useState(false)
  const [result, setResult] = useState<TailorResult | null>(null)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [savingCopy, setSavingCopy] = useState(false)

  useEffect(() => {
    if (authStatus === 'authenticated') {
      fetch('/api/resume/save')
        .then(r => r.json())
        .then(data => setSavedResumes(data.resumes || []))
        .catch(() => {})
    }
  }, [authStatus])

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
    if (isAnonymous) { requireAuth('parse_resume'); return }
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

  async function handleTailor() {
    if (!resumeText || !jobDescription) {
      setError('Both resume and job description are required')
      return
    }
    setError('')
    setTailoring(true)
    try {
      const res = await fetch('/api/resume/tailor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resumeText, jobDescription, companyName: companyName || undefined }),
      })
      const data = await res.json()
      if (res.ok) {
        setResult(data)
      } else if (res.status === 429 && data.code === 'ANON_DAILY_LIMIT') {
        // Anonymous user hit the daily IP cap — soft-prompt them to sign in
        setError('Daily limit reached. Sign in for unlimited tailoring.')
        requireAuth('tailor_resume')
      } else {
        setError(data.error || 'Tailoring failed')
      }
    } catch { setError('Network error') }
    setTailoring(false)
  }

  async function handleSaveAsCopy() {
    if (!result) return
    if (isAnonymous) { requireAuth('save_resume'); return }
    setSavingCopy(true)
    setError('')
    try {
      // Parse tailored text into structured fields so the builder can render them
      let structured: Record<string, unknown> = {}
      try {
        const parseRes = await fetch('/api/resume/parse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: result.tailoredResume }),
        })
        if (parseRes.ok) {
          structured = await parseRes.json()
        }
      } catch {
        // Parsing failed — save with fullText only as fallback
      }

      const res = await fetch('/api/resume/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `${resumeFileName || 'Resume'} (Tailored${companyName ? ` for ${companyName}` : ''})`,
          targetRole: '',
          targetCompany: companyName || '',
          fullText: result.tailoredResume,
          atsScore: result.matchScore,
          ...structured,
        }),
      })
      const data = await res.json()
      if (res.ok) {
        router.push(`/resume/builder?id=${data.id}`)
      } else if (data.code === 'RESUME_LIMIT') {
        setError('Resume limit reached (max 3). Delete an existing resume from the Resume Builder page, then try saving again.')
      } else {
        setError(data.error || 'Failed to save')
      }
    } catch { setError('Save failed') }
    setSavingCopy(false)
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-slate-900">Tailor Resume for Job</h1>
      <p className="text-sm text-slate-500">
        Upload your resume and paste a job description. AI will tailor your resume to highlight the most relevant experience.
      </p>

      {!result ? (
        <div className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
            <h2 className="text-sm font-semibold text-slate-500">Your Resume</h2>

            {savedResumes.length > 0 && (
              <div>
                <label className="text-[10px] text-slate-500 uppercase tracking-wider">From Saved Resumes</label>
                <select
                  onChange={e => e.target.value && handleSelectSaved(e.target.value)}
                  className="w-full mt-1 px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  defaultValue=""
                >
                  <option value="">Choose a saved resume...</option>
                  {savedResumes.map(r => (
                    <option key={r.id} value={r.id}>{r.name}{r.targetRole ? ` — ${r.targetRole}` : ''}</option>
                  ))}
                </select>
              </div>
            )}

            {savedResumes.length > 0 && <div className="text-center text-[10px] text-slate-400">or</div>}

            {!resumeText ? (
              <>
                {!isAnonymous && (
                  <FileDropzone label="Upload Resume" isUploading={uploading} onFileSelect={handleUpload} onRemove={() => {}} onError={setError} />
                )}
                {isAnonymous && (
                  <div className="space-y-2">
                    <label className="text-[10px] text-slate-500 uppercase tracking-wider">Paste your resume text</label>
                    <textarea
                      value={resumeText}
                      onChange={e => { setResumeText(e.target.value); if (e.target.value) setResumeFileName('Pasted resume') }}
                      placeholder="Paste your resume here. To upload a PDF or DOCX, sign in."
                      rows={8}
                      className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y"
                    />
                    <p className="text-[10px] text-slate-400">
                      <button type="button" onClick={() => requireAuth('parse_resume')} className="text-blue-600 hover:underline">Sign in</button>
                      {' '}to upload a PDF or DOCX instead.
                    </p>
                  </div>
                )}
              </>
            ) : (
              <div className="flex items-center justify-between bg-emerald-500/5 border border-emerald-500/15 rounded-xl px-4 py-3">
                <div className="flex items-center gap-2">
                  <Check className="w-4 h-4 text-[#059669]" strokeWidth={2} />
                  <span className="text-sm text-[#059669]">{resumeFileName || 'Resume loaded'}</span>
                  <span className="text-[10px] text-slate-500">({resumeSource === 'saved' ? 'saved' : 'uploaded'})</span>
                </div>
                <button onClick={() => { setResumeText(''); setResumeFileName('') }} className="text-xs text-slate-500 hover:text-slate-500">
                  Remove
                </button>
              </div>
            )}
          </div>

          <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
            <h2 className="text-sm font-semibold text-slate-500">Job Description</h2>
            <input
              type="text"
              value={companyName}
              onChange={e => setCompanyName(e.target.value)}
              placeholder="Company name (optional)"
              className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
            <textarea
              value={jobDescription}
              onChange={e => setJobDescription(e.target.value)}
              placeholder="Paste the job description here..."
              rows={8}
              className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y"
            />
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <button
            onClick={handleTailor}
            disabled={tailoring || !resumeText || !jobDescription}
            className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-medium transition-colors disabled:opacity-50"
          >
            {tailoring ? 'Tailoring resume...' : 'Tailor My Resume'}
          </button>
        </div>
      ) : (
        <div className="space-y-6 animate-fade-in">
          {error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" strokeWidth={2} />
              <p className="text-xs text-red-400">{error}</p>
            </div>
          )}
          <div className="bg-white border border-slate-200 rounded-2xl p-6 text-center">
            <p className="text-sm text-slate-500 mb-2">Job Match Score</p>
            <p className={`text-4xl font-bold ${result.matchScore >= 80 ? 'text-[#059669]' : result.matchScore >= 60 ? 'text-amber-400' : 'text-red-400'}`}>
              {result.matchScore}%
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            {result.addedKeywords.length > 0 && (
              <div className="bg-white border border-slate-200 rounded-2xl p-5">
                <h3 className="text-xs font-semibold text-[#059669] uppercase tracking-wider mb-2">Keywords Added</h3>
                <div className="flex flex-wrap gap-1.5">
                  {result.addedKeywords.map((k, i) => (
                    <span key={i} className="px-2 py-0.5 bg-emerald-500/10 border border-emerald-500/20 rounded text-[10px] text-[#059669]">{k}</span>
                  ))}
                </div>
              </div>
            )}
            {result.missingKeywords.length > 0 && (
              <div className="bg-white border border-slate-200 rounded-2xl p-5">
                <h3 className="text-xs font-semibold text-amber-400 uppercase tracking-wider mb-2">Still Missing</h3>
                <div className="flex flex-wrap gap-1.5">
                  {result.missingKeywords.map((k, i) => (
                    <span key={i} className="px-2 py-0.5 bg-amber-500/10 border border-amber-500/20 rounded text-[10px] text-amber-400">{k}</span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {result.changes.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
              <h3 className="text-sm font-semibold text-slate-500">Changes Made</h3>
              {result.changes.map((c, i) => (
                <div key={i} className="border-l-2 border-emerald-500/30 pl-3 py-1">
                  <p className="text-xs font-medium text-slate-500">{c.section}</p>
                  <p className="text-[11px] text-slate-500 mt-0.5">{c.change}</p>
                  <p className="text-[10px] text-slate-500 mt-0.5">{c.reason}</p>
                </div>
              ))}
            </div>
          )}

          <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-500">Tailored Resume</h3>
              <div className="flex gap-2">
                <button
                  onClick={() => navigator.clipboard.writeText(result.tailoredResume)}
                  className="px-3 py-1.5 bg-emerald-600/10 border border-emerald-500/20 text-[#059669] text-[10px] rounded-lg font-medium hover:bg-emerald-600/20 transition-colors"
                >
                  Copy
                </button>
                <button
                  onClick={handleSaveAsCopy}
                  disabled={savingCopy}
                  className="px-3 py-1.5 bg-blue-600/10 border border-blue-500/20 text-blue-600 text-[10px] rounded-lg font-medium hover:bg-blue-600/20 transition-colors disabled:opacity-50"
                >
                  {savingCopy ? 'Parsing & Saving...' : 'Save as New Resume'}
                </button>
              </div>
            </div>
            <pre className="whitespace-pre-wrap text-xs text-slate-500 bg-slate-50 rounded-xl p-4 max-h-96 overflow-y-auto">
              {result.tailoredResume}
            </pre>
          </div>

          <button onClick={() => setResult(null)} className="text-sm text-blue-600 hover:text-blue-500 transition-colors">
            Start Over
          </button>
        </div>
      )}
    </div>
  )
}
