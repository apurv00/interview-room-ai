'use client'

import { useState, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
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
  /** Only part of the resume fit the analysis window. */
  inputTruncated?: boolean
  /** The rewrite itself was cut off — saving it would persist the loss. */
  outputTruncated?: boolean
}

export default function TailorPage() {
  const router = useRouter()
  const { status: authStatus } = useSession()
  const { requireAuth } = useAuthGate()
  const isAnonymous = authStatus !== 'authenticated'
  const [savedResumes, setSavedResumes] = useState<SavedResume[]>([])
  const [resumeText, setResumeText] = useState('')
  const [resumeSource, setResumeSource] = useState<'upload' | 'saved' | 'paste'>('upload')
  const [resumeFileName, setResumeFileName] = useState('')
  const [jobDescription, setJobDescription] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [tailoring, setTailoring] = useState(false)
  const [result, setResult] = useState<TailorResult | null>(null)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [savingCopy, setSavingCopy] = useState(false)
  // Jobs hand-off (Wave 4.5, package 11): ?jobId= prefills the JD from the
  // posting and the tailored result persists on the application row.
  const searchParams = useSearchParams()
  const jobId = searchParams?.get('jobId') ?? null
  useEffect(() => {
    if (!jobId) return
    fetch(`/api/jobs/${jobId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && d.gated === false) {
          if (typeof d.jd === 'string' && d.jd) setJobDescription((prev) => prev || d.jd)
          if (typeof d.company === 'string') setCompanyName((prev) => prev || d.company)
        }
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId])
  /** Controlled value for the saved-resume dropdown. The old uncontrolled
   *  defaultValue meant that after "Remove", re-selecting the SAME resume
   *  fired no change event — the dropdown looked selected but did nothing. */
  const [selectedId, setSelectedId] = useState('')

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
    setError('')
    try {
      const res = await fetch(`/api/resume/save?id=${id}`)
      if (!res.ok) {
        // Stale dropdown (deleted in another tab) used to no-op silently.
        setError('That resume could not be loaded — it may have been deleted. Pick another or refresh.')
        setSelectedId('')
        return
      }
      const data = await res.json()
      if (data.fullText) {
        setResumeText(data.fullText)
        setResumeFileName(resume.name)
        setResumeSource('saved')
      } else {
        setError('That resume has no text to tailor yet — open it in the builder and add content first.')
        setSelectedId('')
      }
    } catch {
      setError('Could not load that resume. Please try again.')
      setSelectedId('')
    }
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
        setSelectedId('')
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
      // Persist on the application row (latest-wins; never a cap seat).
      if (jobId) {
        fetch(`/api/jobs/${jobId}/tailored`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tailoredText: data.tailoredResume ?? data.tailoredText ?? '',
            sourceResumeId: '',
            matchScore: data.matchScore,
            addedKeywords: data.addedKeywords ?? [],
            missingKeywords: data.missingKeywords ?? [],
          }),
        }).catch(() => {})
      }
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
      // Save the COMPLETE tailored text as fullText and let the builder
      // structure it on open. Parsing here and spreading a PARTIAL result made
      // saveResume regenerate fullText from that partial structure, silently
      // dropping any section the parser couldn't model (the whole tailored
      // rewrite could vanish). With no structured fields posted, saveResume
      // keeps the tailored text verbatim; opening the copy runs the builder's
      // partial-tolerant parse-on-open, which warns before it can lose anything.
      const res = await fetch('/api/resume/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `${resumeFileName || 'Resume'} (Tailored${companyName ? ` for ${companyName}` : ''})`,
          targetRole: '',
          targetCompany: companyName || '',
          fullText: result.tailoredResume,
          // matchScore is JD-match, NOT ATS compatibility — storing it as
          // atsScore made the dashboard "ATS: N" badge lie. The badge now
          // only shows scores from a real ATS check.
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

            {/* Chip only for a LOADED source (upload/saved). The anonymous paste
                box stays an editable textarea — it used to flip to a chip after
                the first character, trapping 1 char and locking out editing. */}
            {resumeText && resumeSource !== 'paste' ? (
              <div className="flex items-center justify-between bg-emerald-500/5 border border-emerald-500/15 rounded-xl px-4 py-3">
                <div className="flex items-center gap-2">
                  <Check className="w-4 h-4 text-[#059669]" strokeWidth={2} />
                  <span className="text-sm text-[#059669]">{resumeFileName || 'Resume loaded'}</span>
                  <span className="text-[10px] text-slate-500">({resumeSource === 'saved' ? 'saved' : 'uploaded'})</span>
                </div>
                <button onClick={() => { setResumeText(''); setResumeFileName(''); setSelectedId('') }} className="text-xs text-slate-500 hover:text-slate-500">
                  Remove
                </button>
              </div>
            ) : (
              <>
                {!isAnonymous && (
                  <FileDropzone label="Upload Resume" isUploading={uploading} onFileSelect={handleUpload} onRemove={() => {}} onError={setError} />
                )}
                {isAnonymous && (
                  <div className="space-y-2">
                    <label className="text-[10px] text-slate-500 uppercase tracking-wider">Paste your resume text</label>
                    <textarea
                      value={resumeSource === 'paste' ? resumeText : ''}
                      onChange={e => { setResumeText(e.target.value); setResumeSource('paste'); setResumeFileName(e.target.value ? 'Pasted resume' : '') }}
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
            {tailoring ? (
              <span className="flex items-center justify-center gap-2">
                <span
                  aria-hidden="true"
                  className="w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin"
                />
                Tailoring resume… this can take ~15s
              </span>
            ) : (
              'Tailor My Resume'
            )}
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
          {(result.inputTruncated || result.outputTruncated) && (
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" strokeWidth={2} />
              <p className="text-xs text-amber-600">
                {result.outputTruncated
                  ? 'The tailored rewrite was cut off before completing — saving it would lose the tail of your resume. Try again, or shorten the resume/job description.'
                  : 'Your resume was longer than the analysis window — only the first part was tailored. The untouched tail is NOT included in the result below.'}
              </p>
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
                {/* inputTruncated blocks too: for a 15k–50k-char resume the
                    model only saw the first slice, so tailoredResume OMITS the
                    unprocessed tail — saving it would silently drop that tail
                    (Codex P2). Copy stays enabled for manual splicing. */}
                <button
                  onClick={handleSaveAsCopy}
                  disabled={savingCopy || result.outputTruncated || result.inputTruncated}
                  title={result.outputTruncated
                    ? 'The rewrite was cut off — saving would persist an incomplete resume.'
                    : result.inputTruncated
                      ? 'Only the first part of your resume was tailored — saving would drop the rest. Use Copy and merge manually, or shorten the resume.'
                      : undefined}
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
