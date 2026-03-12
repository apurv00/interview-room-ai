'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import Link from 'next/link'

interface ResumeData {
  resumes: Array<{
    id: string
    name: string
    targetRole: string
    targetCompany: string
    atsScore: number | null
    updatedAt: string
  }>
  hasProfile: boolean
}

export default function ResumeDashboardPage() {
  const { data: session, status } = useSession()
  const [data, setData] = useState<ResumeData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (status !== 'authenticated') {
      setLoading(false)
      return
    }
    fetch('/api/resume/save')
      .then(r => r.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [status])

  // Unauthenticated landing page
  if (status === 'unauthenticated') {
    return (
      <div className="max-w-3xl mx-auto py-12 space-y-12">
        {/* Hero */}
        <div className="text-center space-y-4">
          <span className="inline-block px-3 py-1 bg-emerald-500/10 border border-emerald-500/20 rounded-full text-xs text-emerald-400 font-semibold">
            AI-Powered Resume Builder
          </span>
          <h1 className="text-3xl md:text-4xl font-bold text-white">
            Build resumes that get interviews
          </h1>
          <p className="text-slate-400 max-w-lg mx-auto">
            AI-powered resume building, tailoring for specific jobs, and ATS optimization.
            Personalized to your experience and target companies.
          </p>
          <div className="flex items-center justify-center gap-3 pt-4">
            <Link
              href="/signup"
              className="px-6 py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-medium transition-colors"
            >
              Get Started Free
            </Link>
            <Link
              href="/signin"
              className="px-6 py-3 bg-slate-800 hover:bg-slate-700 text-white rounded-xl font-medium transition-colors"
            >
              Sign In
            </Link>
          </div>
        </div>

        {/* Features */}
        <div className="grid md:grid-cols-3 gap-6">
          {[
            {
              icon: '📝',
              title: 'AI Resume Builder',
              desc: 'Create professional resumes from scratch or enhance your existing one with AI suggestions.',
            },
            {
              icon: '🎯',
              title: 'Job-Specific Tailoring',
              desc: 'Paste a job description and get a tailored resume that highlights relevant experience.',
            },
            {
              icon: '✅',
              title: 'ATS Compatibility',
              desc: 'Score your resume against ATS parsers and get specific fixes for formatting issues.',
            },
          ].map(f => (
            <div key={f.title} className="bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center">
              <span className="text-3xl">{f.icon}</span>
              <h3 className="text-sm font-semibold text-white mt-3">{f.title}</h3>
              <p className="text-xs text-slate-400 mt-2">{f.desc}</p>
            </div>
          ))}
        </div>

        {/* How it works */}
        <div className="space-y-4">
          <h2 className="text-xl font-bold text-white text-center">How It Works</h2>
          <div className="grid md:grid-cols-4 gap-4">
            {[
              { step: '1', title: 'Upload', desc: 'Upload your current resume or start from scratch' },
              { step: '2', title: 'Enhance', desc: 'AI suggests improvements and stronger bullet points' },
              { step: '3', title: 'Tailor', desc: 'Paste a job description to auto-tailor your resume' },
              { step: '4', title: 'Optimize', desc: 'Run ATS check and download in multiple formats' },
            ].map(s => (
              <div key={s.step} className="text-center space-y-2">
                <div className="w-8 h-8 rounded-full bg-emerald-600/20 flex items-center justify-center text-emerald-400 text-sm font-bold mx-auto">
                  {s.step}
                </div>
                <h3 className="text-sm font-semibold text-white">{s.title}</h3>
                <p className="text-[11px] text-slate-500">{s.desc}</p>
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

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">My Resumes</h1>
          <p className="text-sm text-slate-400 mt-1">Create and manage your resumes</p>
        </div>
        <Link
          href="/resume/builder"
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm rounded-xl font-medium transition-colors"
        >
          New Resume
        </Link>
      </div>

      {/* Quick actions */}
      <div className="grid md:grid-cols-3 gap-4">
        {[
          { href: '/resume/builder', title: 'Build Resume', desc: 'Create from scratch or upload', icon: '📝', color: 'emerald' },
          { href: '/resume/tailor', title: 'Tailor for Job', desc: 'Customize for a job posting', icon: '🎯', color: 'indigo' },
          { href: '/resume/ats-check', title: 'ATS Check', desc: 'Score & optimize for ATS', icon: '✅', color: 'amber' },
        ].map(a => (
          <Link
            key={a.href}
            href={a.href}
            className="bg-slate-900 border border-slate-800 rounded-2xl p-5 hover:border-slate-700 transition-all group"
          >
            <span className="text-2xl">{a.icon}</span>
            <h3 className="text-sm font-semibold text-white mt-3 group-hover:text-emerald-400 transition-colors">
              {a.title}
            </h3>
            <p className="text-xs text-slate-500 mt-1">{a.desc}</p>
          </Link>
        ))}
      </div>

      {/* Saved resumes */}
      {data?.resumes && data.resumes.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-widest">Saved Resumes</h2>
          {data.resumes.map(r => (
            <div key={r.id} className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex items-center justify-between hover:border-slate-700 transition-all">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-emerald-600/10 flex items-center justify-center">
                  <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-medium text-white">{r.name}</p>
                  <p className="text-[11px] text-slate-500">
                    {r.targetRole && `${r.targetRole}`}
                    {r.targetCompany && ` at ${r.targetCompany}`}
                    {!r.targetRole && !r.targetCompany && 'General resume'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-4">
                {r.atsScore !== null && (
                  <span className={`text-sm font-bold ${r.atsScore >= 80 ? 'text-emerald-400' : r.atsScore >= 60 ? 'text-amber-400' : 'text-red-400'}`}>
                    ATS: {r.atsScore}
                  </span>
                )}
                <span className="text-[10px] text-slate-600">
                  {new Date(r.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>
              </div>
            </div>
          ))}
        </section>
      ) : (
        <div className="text-center py-8 bg-slate-900 border border-slate-800 rounded-2xl">
          <p className="text-slate-400 text-sm">No saved resumes yet.</p>
          <p className="text-xs text-slate-500 mt-1">Create your first resume to get started.</p>
        </div>
      )}
    </div>
  )
}
