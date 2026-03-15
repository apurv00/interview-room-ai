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
      if (res.ok) setResult(data)
      else setError(data.error || 'Tailoring failed')
    } catch { setError('Network error') }
    setTailoring(false)
  }

  async function handleSaveAsCopy() {
    if (!result) return
    setSavingCopy(true)
    try {
      const res = await fetch('/api/resume/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `${resumeFileName || 'Resume'} (Tailored${companyName ? ` for ${companyName}` : ''})`,
          targetRole: '',
          targetCompany: companyName || '',
          fullText: result.tailoredResume,
          atsScore: result.matchScore,
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
      <h1 className="text-2xl font-bold text-white">Tailor Resume for Job</h1>
      <p className="text-sm text-slate-400">
        Upload your resume and paste a job description. AI will tailor your resume to highlight the most relevant experience.
      </p>

      {!result ? (
        <div className="space-y-6">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
            <h2 className="text-sm font-semibold text-slate-300">Your Resume</h2>

            {savedResumes.length > 0 && (
              <div>
                <label className="text-[10px] text-slate-500 uppercase tracking-wider">From Saved Resumes</label>
                <select
                  onChange={e => e.target.value && handleSelectSaved(e.target.value)}
                  className="w-full mt-1 px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  defaultValue=""
                >
                  <option value="">Choose a saved resume...</option>
                  {savedResumes.map(r => (
                    <option key={r.id} value={r.id}>{r.name}{r.targetRole ? ` — ${r.targetRole}` : ''}</option>
                  ))}
                </select>
              </div>
            )}

            {savedResumes.length > 0 && <div className="text-center text-[10px] text-slate-600">or</div>}

            {!resumeText ? (
              <FileDropzone label="Upload Resume" isUploading={uploading} onFileSelect={handleUpload} onRemove={() => {}} onError={setError} />
            ) : (
              <div className="flex items-center justify-between bg-emerald-500/5 border border-emerald-500/15 rounded-xl px-4 py-3">
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  <span className="text-sm text-emerald-300">{resumeFileName || 'Resume loaded'}</span>
                  <span className="text-[10px] text-slate-500">({resumeSource === 'saved' ? 'saved' : 'uploaded'})</span>
                </div>
                <button onClick={() => { setResumeText(''); setResumeFileName('') }} className="text-xs text-slate-500 hover:text-slate-300">
                  Remove
                </button>
              </div>
            )}
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
            <h2 className="text-sm font-semibold text-slate-300">Job Description</h2>
            <input
              type="text"
              value={companyName}
              onChange={e => setCompanyName(e.target.value)}
              placeholder="Company name (optional)"
              className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
            <textarea
              value={jobDescription}
              onChange={e => setJobDescription(e.target.value)}
              placeholder="Paste the job description here..."
              rows={8}
              className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y"
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
              <svg className="w-4 h-4 text-red-400 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
              <p className="text-xs text-red-400">{error}</p>
            </div>
          )}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center">
            <p className="text-sm text-slate-400 mb-2">Job Match Score</p>
            <p className={`text-4xl font-bold ${result.matchScore >= 80 ? 'text-emerald-400' : result.matchScore >= 60 ? 'text-amber-400' : 'text-red-400'}`}>
              {result.matchScore}%
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            {result.addedKeywords.length > 0 && (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
                <h3 className="text-xs font-semibold text-emerald-400 uppercase tracking-wider mb-2">Keywords Added</h3>
                <div className="flex flex-wrap gap-1.5">
                  {result.addedKeywords.map((k, i) => (
                    <span key={i} className="px-2 py-0.5 bg-emerald-500/10 border border-emerald-500/20 rounded text-[10px] text-emerald-400">{k}</span>
                  ))}
                </div>
              </div>
            )}
            {result.missingKeywords.length > 0 && (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
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
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
              <h3 className="text-sm font-semibold text-slate-300">Changes Made</h3>
              {result.changes.map((c, i) => (
                <div key={i} className="border-l-2 border-emerald-500/30 pl-3 py-1">
                  <p className="text-xs font-medium text-slate-300">{c.section}</p>
                  <p className="text-[11px] text-slate-400 mt-0.5">{c.change}</p>
                  <p className="text-[10px] text-slate-500 mt-0.5">{c.reason}</p>
                </div>
              ))}
            </div>
          )}

          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-300">Tailored Resume</h3>
              <div className="flex gap-2">
                <button
                  onClick={() => navigator.clipboard.writeText(result.tailoredResume)}
                  className="px-3 py-1.5 bg-emerald-600/10 border border-emerald-500/20 text-emerald-400 text-[10px] rounded-lg font-medium hover:bg-emerald-600/20 transition-colors"
                >
                  Copy
                </button>
                <button
                  onClick={handleSaveAsCopy}
                  disabled={savingCopy}
                  className="px-3 py-1.5 bg-indigo-600/20 border border-indigo-500/30 text-indigo-400 text-[10px] rounded-lg font-medium hover:bg-indigo-600/30 transition-colors disabled:opacity-50"
                >
                  {savingCopy ? 'Saving...' : 'Save as New Resume'}
                </button>
              </div>
            </div>
            <pre className="whitespace-pre-wrap text-xs text-slate-300 bg-slate-800 rounded-xl p-4 max-h-96 overflow-y-auto">
              {result.tailoredResume}
            </pre>
          </div>

          <button onClick={() => setResult(null)} className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors">
            Start Over
          </button>
        </div>
      )}
    </div>
  )
}
