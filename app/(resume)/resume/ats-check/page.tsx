'use client'

import { useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import FileDropzone from '@interview/components/FileDropzone'

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
  const [resumeText, setResumeText] = useState('')
  const [resumeFileName, setResumeFileName] = useState('')
  const [jobDescription, setJobDescription] = useState('')
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<ATSResult | null>(null)
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
      if (res.ok) { setResumeText(data.text); setResumeFileName(data.fileName) }
      else setError(data.error || 'Upload failed')
    } catch { setError('Upload failed') }
    setUploading(false)
  }

  async function handleCheck() {
    if (!resumeText) { setError('Upload a resume first'); return }
    setError('')
    setChecking(true)
    try {
      const res = await fetch('/api/resume/ats-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resumeText,
          jobDescription: jobDescription || undefined,
        }),
      })
      const data = await res.json()
      if (res.ok) setResult(data)
      else setError(data.error || 'Check failed')
    } catch { setError('Network error') }
    setChecking(false)
  }

  const severityStyles = {
    critical: { bg: 'bg-red-500/10', border: 'border-red-500/20', text: 'text-red-400', icon: '!!!' },
    warning: { bg: 'bg-amber-500/10', border: 'border-amber-500/20', text: 'text-amber-400', icon: '!' },
    info: { bg: 'bg-indigo-500/10', border: 'border-indigo-500/20', text: 'text-indigo-400', icon: 'i' },
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-white">ATS Compatibility Check</h1>
      <p className="text-sm text-slate-400">
        Score your resume against Applicant Tracking System parsers and get specific fixes.
      </p>

      {!result ? (
        <div className="space-y-6">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
            <h2 className="text-sm font-semibold text-slate-300">Upload Resume</h2>
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
                <span className="text-sm text-emerald-300">{resumeFileName || 'Resume uploaded'}</span>
                <button onClick={() => { setResumeText(''); setResumeFileName('') }} className="text-xs text-slate-500 hover:text-slate-300">
                  Remove
                </button>
              </div>
            )}
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
            <h2 className="text-sm font-semibold text-slate-300">Job Description (optional, improves keyword analysis)</h2>
            <textarea
              value={jobDescription}
              onChange={e => setJobDescription(e.target.value)}
              placeholder="Paste job description for keyword matching..."
              rows={5}
              className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y"
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
          {/* Score */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center">
            <p className="text-sm text-slate-400 mb-2">ATS Compatibility Score</p>
            <p className={`text-5xl font-bold ${
              result.score >= 80 ? 'text-emerald-400' : result.score >= 60 ? 'text-amber-400' : 'text-red-400'
            }`}>
              {result.score}
            </p>
            <p className="text-xs text-slate-500 mt-2">{result.summary}</p>
          </div>

          {/* Issues */}
          {result.issues.length > 0 && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
              <h3 className="text-sm font-semibold text-slate-300">Issues Found ({result.issues.length})</h3>
              {result.issues.map((issue, i) => {
                const style = severityStyles[issue.severity]
                return (
                  <div key={i} className={`${style.bg} border ${style.border} rounded-xl p-3`}>
                    <div className="flex items-start gap-2">
                      <span className={`text-[10px] font-bold ${style.text} uppercase mt-0.5`}>
                        {issue.severity}
                      </span>
                      <div>
                        <p className="text-xs text-slate-300">{issue.message}</p>
                        <p className="text-[11px] text-slate-500 mt-1">Fix: {issue.fix}</p>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Formatting score */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-slate-300">Formatting</h3>
              <span className={`text-sm font-bold ${result.formatting.score >= 80 ? 'text-emerald-400' : 'text-amber-400'}`}>
                {result.formatting.score}/100
              </span>
            </div>
            {result.formatting.issues.length > 0 && (
              <ul className="space-y-1">
                {result.formatting.issues.map((issue, i) => (
                  <li key={i} className="text-xs text-slate-400 flex items-start gap-1.5">
                    <span className="text-amber-400 mt-0.5">-</span> {issue}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Sections analysis */}
          <div className="grid md:grid-cols-2 gap-4">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
              <h3 className="text-xs font-semibold text-emerald-400 uppercase tracking-wider mb-2">Sections Found</h3>
              <div className="flex flex-wrap gap-1.5">
                {result.sections.found.map((s, i) => (
                  <span key={i} className="px-2 py-0.5 bg-emerald-500/10 border border-emerald-500/20 rounded text-[10px] text-emerald-400">
                    {s}
                  </span>
                ))}
              </div>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
              <h3 className="text-xs font-semibold text-amber-400 uppercase tracking-wider mb-2">Recommended Sections</h3>
              <div className="flex flex-wrap gap-1.5">
                {result.sections.recommended.map((s, i) => (
                  <span key={i} className="px-2 py-0.5 bg-amber-500/10 border border-amber-500/20 rounded text-[10px] text-amber-400">
                    {s}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <button
            onClick={() => setResult(null)}
            className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            Check Another Resume
          </button>
        </div>
      )}
    </div>
  )
}
