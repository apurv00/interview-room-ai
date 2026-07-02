'use client'

import { useState, useEffect, useRef } from 'react'
import { useSession } from 'next-auth/react'
import FileDropzone from '@shared/ui/FileDropzone'
import { Check, Loader2 } from 'lucide-react'
import { useAuthGate } from '@shared/providers/AuthGateProvider'

// UAT-024: ATS check P95 is ~35s on Sonnet. While waiting on the LLM
// the user previously saw a static "Analyzing..." button. Stepping
// through realistic phase labels gives them a sense of progress even
// when the underlying call is opaque. Pacing matches observed median
// LLM latency — the final step holds until the response actually
// arrives, so we never get ahead of reality.
const ATS_PROGRESS_STEPS = [
  'Parsing resume structure…',
  'Analyzing formatting…',
  'Matching keywords against the job description…',
  'Compiling your compatibility score…',
] as const
const ATS_PROGRESS_INTERVAL_MS = 8_000

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
  const { status: authStatus } = useSession()
  const { requireAuth } = useAuthGate()
  const isAnonymous = authStatus !== 'authenticated'
  const [savedResumes, setSavedResumes] = useState<SavedResume[]>([])
  const [resumeText, setResumeText] = useState('')
  const [resumeSource, setResumeSource] = useState<'upload' | 'saved'>('upload')
  /** Full resume object of the selected saved resume — kept so a completed
   *  check can persist its REAL ATS score back onto the resume (the dashboard
   *  badge reads savedResumes.atsScore, which previously nothing honest set). */
  const [selectedSaved, setSelectedSaved] = useState<Record<string, unknown> | null>(null)
  /** Controlled value for the saved-resume dropdown. The old uncontrolled
   *  defaultValue meant that after "Remove", re-selecting the SAME resume
   *  fired no change event — the dropdown looked selected but did nothing. */
  const [selectedId, setSelectedId] = useState('')
  const [resumeFileName, setResumeFileName] = useState('')
  const [jobDescription, setJobDescription] = useState('')
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<ATSResult | null>(null)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)

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
        setSelectedSaved({ ...data, id })
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
        setSelectedSaved(null)
        setSelectedId('')
      } else setError(data.error || 'Upload failed')
    } catch { setError('Upload failed') }
    setUploading(false)
  }

  // UAT-024: stepped progress indicator. Advances every
  // ATS_PROGRESS_INTERVAL_MS while `checking === true`, capped at the
  // last step so we never claim "Compiling…" before the LLM has spoken.
  const [progressStep, setProgressStep] = useState(0)
  const progressTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!checking) {
      setProgressStep(0)
      return
    }
    progressTimer.current = setInterval(() => {
      setProgressStep((s) => Math.min(s + 1, ATS_PROGRESS_STEPS.length - 1))
    }, ATS_PROGRESS_INTERVAL_MS)
    return () => {
      if (progressTimer.current) clearInterval(progressTimer.current)
      progressTimer.current = null
    }
  }, [checking])

  async function handleCheck() {
    if (!resumeText) { setError('Paste a resume or upload one first'); return }
    setError('')
    setChecking(true)
    setProgressStep(0)
    try {
      const res = await fetch('/api/resume/ats-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resumeText, jobDescription: jobDescription || undefined }),
      })
      const data = await res.json()
      if (res.ok) {
        setResult(data)
        // Persist the real ATS score onto the saved resume so the dashboard
        // badge reflects an actual ATS check. Fire-and-forget: a failure here
        // must not disturb the result the user is reading.
        // REFETCH first — /api/resume/save is a full-replacement save and the
        // check takes ~30s: replaying the selection-time snapshot would roll
        // back any edits made in another tab meanwhile (Codex P2). The score
        // rides on the freshest copy; if the refetch fails, skip persisting.
        const savedId = (selectedSaved as { id?: string } | null)?.id
        if (resumeSource === 'saved' && savedId && typeof data.score === 'number') {
          fetch(`/api/resume/save?id=${savedId}`)
            .then(r => (r.ok ? r.json() : null))
            .then(fresh => {
              if (!fresh || !fresh.name) return
              return fetch('/api/resume/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...fresh, id: savedId, atsScore: data.score }),
              })
            })
            .catch(() => {})
        }
      } else if (res.status === 429 && data.code === 'ANON_DAILY_LIMIT') {
        setError('Daily limit reached. Sign in for unlimited ATS checks.')
        requireAuth('ats_check')
      } else {
        setError(data.error || 'Check failed')
      }
    } catch { setError('Network error') }
    setChecking(false)
  }

  const severityStyles = {
    critical: { bg: 'bg-red-500/10', border: 'border-red-500/20', text: 'text-red-400' },
    warning: { bg: 'bg-amber-500/10', border: 'border-amber-500/20', text: 'text-amber-400' },
    info: { bg: 'bg-blue-500/10', border: 'border-blue-500/20', text: 'text-blue-600' },
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-slate-900">ATS Compatibility Check</h1>
      <p className="text-sm text-slate-500">
        Score your resume against Applicant Tracking System parsers and get specific fixes.
      </p>

      {!result ? (
        <div className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
            <h2 className="text-sm font-semibold text-slate-500">Select Resume</h2>

            {/* Saved resumes dropdown */}
            {savedResumes.length > 0 && (
              <div>
                <label className="text-[10px] text-slate-500 uppercase tracking-wider">From Saved Resumes</label>
                <select
                  value={selectedId}
                  onChange={e => { setSelectedId(e.target.value); if (e.target.value) handleSelectSaved(e.target.value) }}
                  className="w-full mt-1 px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
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
                <button onClick={() => { setResumeText(''); setResumeFileName(''); setSelectedSaved(null); setSelectedId('') }} className="text-xs text-slate-500 hover:text-slate-500">
                  Remove
                </button>
              </div>
            )}
          </div>

          <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
            <h2 className="text-sm font-semibold text-slate-500">Job Description (optional, improves keyword analysis)</h2>
            <textarea
              value={jobDescription}
              onChange={e => setJobDescription(e.target.value)}
              placeholder="Paste job description for keyword matching..."
              rows={5}
              className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y"
            />
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          {checking && (
            <div
              role="status"
              aria-live="polite"
              className="bg-emerald-500/5 border border-emerald-500/20 rounded-xl px-4 py-3 flex items-center gap-3"
            >
              <Loader2 className="w-4 h-4 text-emerald-600 animate-spin shrink-0" />
              <div className="text-sm text-emerald-700 flex-1 min-w-0">
                <span className="font-medium">{ATS_PROGRESS_STEPS[progressStep]}</span>
                <span className="ml-2 text-emerald-600/70 text-xs">
                  Step {progressStep + 1} of {ATS_PROGRESS_STEPS.length}
                </span>
              </div>
            </div>
          )}

          <button
            onClick={handleCheck}
            disabled={checking || !resumeText}
            className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-medium transition-colors disabled:opacity-50"
          >
            {checking ? 'Analyzing…' : 'Run ATS Check'}
          </button>
        </div>
      ) : (
        <div className="space-y-6 animate-fade-in">
          <div className="bg-white border border-slate-200 rounded-2xl p-6 text-center">
            <p className="text-sm text-slate-500 mb-2">ATS Compatibility Score</p>
            <p className={`text-5xl font-bold ${result.score >= 80 ? 'text-[#059669]' : result.score >= 60 ? 'text-amber-400' : 'text-red-400'}`}>
              {result.score}
            </p>
            <p className="text-xs text-slate-500 mt-2">{result.summary}</p>
          </div>

          {result.issues.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
              <h3 className="text-sm font-semibold text-slate-500">Issues Found ({result.issues.length})</h3>
              {result.issues.map((issue, i) => {
                const style = severityStyles[issue.severity]
                return (
                  <div key={i} className={`${style.bg} border ${style.border} rounded-xl p-3`}>
                    <div className="flex items-start gap-2">
                      <span className={`text-[10px] font-bold ${style.text} uppercase mt-0.5`}>{issue.severity}</span>
                      <div>
                        <p className="text-xs text-slate-500">{issue.message}</p>
                        <p className="text-[11px] text-slate-500 mt-1">Fix: {issue.fix}</p>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          <div className="bg-white border border-slate-200 rounded-2xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-slate-500">Formatting</h3>
              <span className={`text-sm font-bold ${result.formatting.score >= 80 ? 'text-[#059669]' : 'text-amber-400'}`}>
                {result.formatting.score}/100
              </span>
            </div>
            {result.formatting.issues.length > 0 && (
              <ul className="space-y-1">
                {result.formatting.issues.map((issue, i) => (
                  <li key={i} className="text-xs text-slate-500 flex items-start gap-1.5">
                    <span className="text-amber-400 mt-0.5">-</span> {issue}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <div className="bg-white border border-slate-200 rounded-2xl p-5">
              <h3 className="text-xs font-semibold text-[#059669] uppercase tracking-wider mb-2">Sections Found</h3>
              <div className="flex flex-wrap gap-1.5">
                {result.sections.found.map((s, i) => (
                  <span key={i} className="px-2 py-0.5 bg-emerald-500/10 border border-emerald-500/20 rounded text-[10px] text-[#059669]">{s}</span>
                ))}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-2xl p-5">
              <h3 className="text-xs font-semibold text-amber-400 uppercase tracking-wider mb-2">Recommended Sections</h3>
              <div className="flex flex-wrap gap-1.5">
                {result.sections.recommended.map((s, i) => (
                  <span key={i} className="px-2 py-0.5 bg-amber-500/10 border border-amber-500/20 rounded text-[10px] text-amber-400">{s}</span>
                ))}
              </div>
            </div>
          </div>

          <button onClick={() => setResult(null)} className="text-sm text-blue-600 hover:text-blue-500 transition-colors">
            Check Another Resume
          </button>
        </div>
      )}
    </div>
  )
}
