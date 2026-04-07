'use client'

import { useEffect } from 'react'
import { X } from 'lucide-react'
import SignInForm from '@shared/ui/SignInForm'

export type AuthReason =
  | 'save_resume'
  | 'download_resume'
  | 'tailor_resume'
  | 'ats_check'
  | 'parse_resume'
  | 'enhance_resume'
  | 'start_interview'
  | 'view_history'
  | 'view_progress'
  | 'view_dashboard'
  | 'generic'

interface ReasonCopy {
  title: string
  subtitle: string
}

const REASON_COPY: Record<AuthReason, ReasonCopy> = {
  save_resume: {
    title: 'Sign in to save your resume',
    subtitle: 'Your work will be saved to your account so you can come back anytime.',
  },
  download_resume: {
    title: 'Sign in to download your resume',
    subtitle: 'Create a free account to export your resume as a polished PDF.',
  },
  tailor_resume: {
    title: 'Sign in to tailor your resume',
    subtitle: 'AI tailoring is free — sign in to run it against any job description.',
  },
  ats_check: {
    title: 'Sign in to run an ATS check',
    subtitle: 'Get a detailed compatibility score and fix list — free with an account.',
  },
  parse_resume: {
    title: 'Sign in to import your resume',
    subtitle: 'We use AI to convert your uploaded file into editable sections.',
  },
  enhance_resume: {
    title: 'Sign in to enhance with AI',
    subtitle: 'Sign in to use AI to rewrite and strengthen your resume content.',
  },
  start_interview: {
    title: 'Sign in to start your interview',
    subtitle: 'We save your sessions, feedback, and progress so you can improve over time.',
  },
  view_history: {
    title: 'Sign in to see your interview history',
    subtitle: 'Once you sign in, your past sessions and feedback show up here.',
  },
  view_progress: {
    title: 'Sign in to track your progress',
    subtitle: 'Sign in to see your competency growth, streaks, and milestones.',
  },
  view_dashboard: {
    title: 'Sign in to view your dashboard',
    subtitle: 'Personalized analytics unlock once you sign in and run an interview.',
  },
  generic: {
    title: 'Sign in to interviewprep.guru',
    subtitle: 'Practice mock interviews with AI feedback.',
  },
}

interface Props {
  reason: AuthReason | null
  onClose: () => void
}

export default function AuthGateModal({ reason, onClose }: Props) {
  // Lock body scroll while open
  useEffect(() => {
    if (!reason) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [reason])

  // Close on Escape
  useEffect(() => {
    if (!reason) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [reason, onClose])

  if (!reason) return null

  const copy = REASON_COPY[reason]

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center px-4 py-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-gate-title"
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close sign in"
        onClick={onClose}
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
      />

      {/* Card */}
      <div className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl border border-[#e1e8ed] p-6 sm:p-7 animate-fade-in">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-3 right-3 p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="flex justify-center mb-4">
          <div className="w-9 h-9 rounded-[8px] bg-[#2563eb] flex items-center justify-center">
            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
            </svg>
          </div>
        </div>

        <h2 id="auth-gate-title" className="text-xl font-semibold text-[#0f1419] text-center">
          {copy.title}
        </h2>
        <p className="text-sm text-[#71767b] text-center mt-1.5">{copy.subtitle}</p>

        <div className="mt-5">
          <SignInForm />
        </div>
      </div>
    </div>
  )
}
