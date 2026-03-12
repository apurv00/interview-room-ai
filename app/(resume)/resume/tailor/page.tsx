'use client'

import { useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import FileDropzone from '@/components/FileDropzone'

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
  const [resumeText, setResumeText] = useState('')
  const [resumeFileName, setResumeFileName] = useState('')
  const [jobDescription, setJobDescription] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [tailoring, setTailoring] = useState(false)
  const [result, setResult] = useState<TailorResult | null>(null)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)

  useEffect(() => {
    if (authStatus === 'unauthenticated') router.push('/signin')
  }, [authStatus, router])

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
      } else {
        setError(data.error || 'Upload failed')
      }
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
        body: JSON.stringify({
          resumeText,
          jobDescription,
          companyName: companyName || undefined,
        }),
      })
      const data = await res.json()
      if (res.ok) {
        setResult(data)
      } else {
        setError(data.error || 'Tailoring failed')
      }
    } catch { setError('Network error') }
    setTailoring(false)
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-white">Tailor Resume for Job</h1>
      <p className="text-sm text-slate-400">
        Upload your resume and paste a job description. AI will tailor your resume to highlight the most relevant experience.
      </p>

      {!result ? (
        <div className="space-y-6">
          {/* Resume upload */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
            <h2 className="text-sm font-semibold text-slate-300">Your Resume</h2>
            {!resumeText ? (
              <FileDropzone
                label="Upload Resume"
                isUploading={uploading}
                onFileSelect={handleUpload}
                onRemove={() => {}}
                onError={setError}
              />
            ) : (
              <div className="flex items-center justify-between bg-emerald-500/5 border border-emerald-500/15 rounded-xl px-4 py-3">
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  <span className="text-sm text-emerald-300">{resumeFileName || 'Resume uploaded'}</span>
                </div>
                <button
                  onClick={() => { setResumeText(''); setResumeFileName('') }}
                  className="text-xs text-slate-500 hover:text-slate-300"
                >
                  Remove
                </button>
              </div>
            )}
          </div>

          {/* Job description */}
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
          {/* Match score */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center">
            <p className="text-sm text-slate-400 mb-2">Job Match Score</p>
            <p className={`text-4xl font-bold ${
              result.matchScore >= 80 ? 'text-emerald-400' : result.matchScore >= 60 ? 'text-amber-400' : 'text-red-400'
            }`}>
              {result.matchScore}%
            </p>
          </div>

          {/* Keywords */}
          <div className="grid md:grid-cols-2 gap-4">
            {result.addedKeywords.length > 0 && (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
                <h3 className="text-xs font-semibold text-emerald-400 uppercase tracking-wider mb-2">Keywords Added</h3>
                <div className="flex flex-wrap gap-1.5">
                  {result.addedKeywords.map((k, i) => (
                    <span key={i} className="px-2 py-0.5 bg-emerald-500/10 border border-emerald-500/20 rounded text-[10px] text-emerald-400">
                      {k}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {result.missingKeywords.length > 0 && (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
                <h3 className="text-xs font-semibold text-amber-400 uppercase tracking-wider mb-2">Still Missing</h3>
                <div className="flex flex-wrap gap-1.5">
                  {result.missingKeywords.map((k, i) => (
                    <span key={i} className="px-2 py-0.5 bg-amber-500/10 border border-amber-500/20 rounded text-[10px] text-amber-400">
                      {k}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Changes made */}
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

          {/* Tailored resume text */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-300">Tailored Resume</h3>
              <button
                onClick={() => navigator.clipboard.writeText(result.tailoredResume)}
                className="px-3 py-1.5 bg-emerald-600/10 border border-emerald-500/20 text-emerald-400 text-[10px] rounded-lg font-medium hover:bg-emerald-600/20 transition-colors"
              >
                Copy to Clipboard
              </button>
            </div>
            <pre className="whitespace-pre-wrap text-xs text-slate-300 bg-slate-800 rounded-xl p-4 max-h-96 overflow-y-auto">
              {result.tailoredResume}
            </pre>
          </div>

          <button
            onClick={() => setResult(null)}
            className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            Start Over
          </button>
        </div>
      )}
    </div>
  )
}
