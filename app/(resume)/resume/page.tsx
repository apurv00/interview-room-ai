'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import Link from 'next/link'

interface ResumeListData {
  resumes: Array<{
    id: string
    name: string
    template: string
    targetRole: string
    targetCompany: string
    atsScore: number | null
    updatedAt: string
  }>
  count: number
  limit: number
  hasProfile: boolean
}

export default function ResumeDashboardPage() {
  const { data: session, status } = useSession()
  const [data, setData] = useState<ResumeListData | null>(null)
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState<string | null>(null)

  useEffect(() => {
    if (status !== 'authenticated') {
      setLoading(false)
      return
    }
    fetchResumes()
  }, [status])

  function fetchResumes() {
    fetch('/api/resume/save')
      .then(r => r.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this resume? This cannot be undone.')) return
    setDeleting(id)
    try {
      await fetch(`/api/resume/save?id=${id}`, { method: 'DELETE' })
      fetchResumes()
    } catch { /* ignore */ }
    setDeleting(null)
  }

  // Unauthenticated landing page
  if (status === 'unauthenticated') {
    return (
      <div className="max-w-3xl mx-auto py-12 space-y-12">
        <div className="text-center space-y-4">
          <span className="inline-block px-3 py-1 bg-emerald-500/10 border border-emerald-500/20 rounded-full text-xs text-emerald-600 font-semibold">
            AI-Powered Resume Builder
          </span>
          <h1 className="text-3xl md:text-4xl font-bold text-[#0f1419]">
            Build resumes that get interviews
          </h1>
          <p className="text-[#536471] max-w-lg mx-auto">
            AI-powered resume building, tailoring for specific jobs, and ATS optimization.
            Personalized to your experience and target companies.
          </p>
          <div className="flex items-center justify-center gap-3 pt-4">
            <Link href="/signup" className="px-6 py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-medium transition-colors">
              Get Started Free
            </Link>
            <Link href="/signin" className="px-6 py-3 bg-[#f8fafc] hover:bg-[#eff3f4] text-[#0f1419] rounded-xl font-medium transition-colors">
              Sign In
            </Link>
          </div>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          {[
            { icon: '📝', title: 'AI Resume Builder', desc: 'Create professional resumes with AI suggestions, live preview, and instant PDF download.' },
            { icon: '🎯', title: 'Job-Specific Tailoring', desc: 'Paste a job description and get a tailored resume that highlights relevant experience.' },
            { icon: '✅', title: 'ATS Compatibility', desc: 'Score your resume against ATS parsers and get specific fixes for formatting issues.' },
          ].map(f => (
            <div key={f.title} className="bg-white border border-[#e1e8ed] rounded-2xl p-6 text-center">
              <span className="text-3xl">{f.icon}</span>
              <h3 className="text-sm font-semibold text-[#0f1419] mt-3">{f.title}</h3>
              <p className="text-xs text-[#536471] mt-2">{f.desc}</p>
            </div>
          ))}
        </div>

        <div className="space-y-4">
          <h2 className="text-xl font-bold text-[#0f1419] text-center">How It Works</h2>
          <div className="grid md:grid-cols-4 gap-4">
            {[
              { step: '1', title: 'Upload or Build', desc: 'Upload your current resume or build from scratch with templates' },
              { step: '2', title: 'AI Enhance', desc: 'AI rewrites bullets with metrics, action verbs, and keywords' },
              { step: '3', title: 'Tailor & Check', desc: 'Tailor for specific jobs and run ATS compatibility check' },
              { step: '4', title: 'Download PDF', desc: 'Download as clean, ATS-friendly PDF — no watermarks, no paywall' },
            ].map(s => (
              <div key={s.step} className="text-center space-y-2">
                <div className="w-8 h-8 rounded-full bg-emerald-600/20 flex items-center justify-center text-emerald-600 text-sm font-bold mx-auto">
                  {s.step}
                </div>
                <h3 className="text-sm font-semibold text-[#0f1419]">{s.title}</h3>
                <p className="text-[11px] text-[#71767b]">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 rounded-full border-2 border-emerald-400 border-t-transparent animate-spin" />
      </div>
    )
  }

  const atLimit = data ? data.count >= data.limit : false

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#0f1419]">My Resumes</h1>
          <p className="text-sm text-[#536471] mt-1">
            Create and manage your resumes
            {data && (
              <span className={`ml-2 text-xs font-medium ${atLimit ? 'text-amber-400' : 'text-[#71767b]'}`}>
                ({data.count}/{data.limit} used)
              </span>
            )}
          </p>
        </div>
        {atLimit ? (
          <span className="px-4 py-2 bg-[#f8fafc] text-[#71767b] text-sm rounded-xl font-medium cursor-not-allowed">
            Limit Reached
          </span>
        ) : (
          <Link
            href="/resume/builder"
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm rounded-xl font-medium transition-colors"
          >
            New Resume
          </Link>
        )}
      </div>

      {/* Quick actions */}
      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { href: '/resume/wizard', title: 'Smart Wizard', desc: 'Step-by-step AI-guided builder', icon: '✨', disabled: false },
          { href: atLimit ? '#' : '/resume/builder', title: 'Build Resume', desc: 'Create from scratch or upload', icon: '📝', disabled: atLimit },
          { href: '/resume/tailor', title: 'Tailor for Job', desc: 'Customize for a job posting', icon: '🎯', disabled: false },
          { href: '/resume/ats-check', title: 'ATS Check', desc: 'Score & optimize for ATS', icon: '✅', disabled: false },
        ].map(a => (
          <Link
            key={a.title}
            href={a.href}
            className={`bg-white border border-[#e1e8ed] rounded-2xl p-5 transition-all group ${a.disabled ? 'opacity-50 cursor-not-allowed' : 'hover:border-[#536471]'}`}
            onClick={e => a.disabled && e.preventDefault()}
          >
            <span className="text-2xl">{a.icon}</span>
            <h3 className="text-sm font-semibold text-[#0f1419] mt-3 group-hover:text-emerald-600 transition-colors">
              {a.title}
            </h3>
            <p className="text-xs text-[#71767b] mt-1">{a.desc}</p>
          </Link>
        ))}
      </div>

      {/* Saved resumes */}
      {data?.resumes && data.resumes.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-[#536471] uppercase tracking-widest">Saved Resumes</h2>
          {data.resumes.map(r => (
            <div key={r.id} className="bg-white border border-[#e1e8ed] rounded-2xl p-4 flex items-center justify-between hover:border-[#536471] transition-all">
              <Link href={`/resume/builder?id=${r.id}`} className="flex items-center gap-3 flex-1 min-w-0">
                <div className="w-9 h-9 rounded-lg bg-emerald-600/10 flex items-center justify-center shrink-0">
                  <svg className="w-4 h-4 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[#0f1419] truncate">{r.name}</p>
                  <p className="text-[11px] text-[#71767b] truncate">
                    {r.targetRole && `${r.targetRole}`}
                    {r.targetCompany && ` at ${r.targetCompany}`}
                    {!r.targetRole && !r.targetCompany && 'General resume'}
                    {r.template && r.template !== 'professional' && ` · ${r.template}`}
                  </p>
                </div>
              </Link>
              <div className="flex items-center gap-3 shrink-0 ml-3">
                {r.atsScore !== null && (
                  <span className={`text-sm font-bold ${r.atsScore >= 80 ? 'text-[#059669]' : r.atsScore >= 60 ? 'text-amber-400' : 'text-red-400'}`}>
                    ATS: {r.atsScore}
                  </span>
                )}
                <span className="text-[10px] text-[#8b98a5]">
                  {new Date(r.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>
                <button
                  onClick={() => handleDelete(r.id)}
                  disabled={deleting === r.id}
                  className="text-[#8b98a5] hover:text-red-400 transition-colors disabled:opacity-50"
                  title="Delete resume"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </section>
      ) : (
        <div className="text-center py-8 bg-white border border-[#e1e8ed] rounded-2xl">
          <p className="text-[#536471] text-sm">No saved resumes yet.</p>
          <p className="text-xs text-[#71767b] mt-1">Create your first resume to get started.</p>
        </div>
      )}
    </div>
  )
}
