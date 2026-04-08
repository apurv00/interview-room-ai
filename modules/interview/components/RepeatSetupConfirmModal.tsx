'use client'

/**
 * RepeatSetupConfirmModal — shown on /interview/setup when the user has a
 * prior interview configuration in localStorage (or fetched from the DB
 * fallback). Lets repeat users one-click into the lobby with their previous
 * setup, jump to a specific step to tweak a single field, or start over.
 */

import { useEffect } from 'react'
import { X, ArrowRight, Edit3, Sparkles } from 'lucide-react'
import Button from '@shared/ui/Button'
import type { InterviewConfig } from '@shared/types'
import {
  EXPERIENCE_LABELS,
  getDurationLabel,
  getDomainLabel,
} from '@interview/config/interviewConfig'

export type RepeatSetupStep = 0 | 1 | 2

interface Props {
  config: InterviewConfig
  resumeFileName?: string
  onStart: () => void
  onEdit: (step: RepeatSetupStep) => void
  onClose: () => void
  onStartOver: () => void
}

interface Row {
  label: string
  value: string
  step: RepeatSetupStep
}

export default function RepeatSetupConfirmModal({
  config,
  resumeFileName,
  onStart,
  onEdit,
  onClose,
  onStartOver,
}: Props) {
  // Lock body scroll while open
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  const rows: Row[] = []
  rows.push({ label: 'Domain', value: getDomainLabel(config.role), step: 0 })
  if (resumeFileName || config.resumeFileName) {
    rows.push({ label: 'Resume', value: resumeFileName || config.resumeFileName || 'Resume', step: 0 })
  }
  rows.push({ label: 'Experience', value: EXPERIENCE_LABELS[config.experience], step: 1 })
  if (config.targetCompany) {
    rows.push({ label: 'Company', value: config.targetCompany, step: 1 })
  }
  if (config.jobDescription) {
    rows.push({ label: 'Job Description', value: config.jdFileName || 'Saved JD', step: 1 })
  }
  if (config.interviewType) {
    rows.push({ label: 'Interview Type', value: config.interviewType, step: 2 })
  }
  rows.push({ label: 'Duration', value: getDurationLabel(config.duration), step: 2 })

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center px-4 py-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="repeat-setup-title"
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close"
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
            <Sparkles className="w-5 h-5 text-white" />
          </div>
        </div>

        <h2 id="repeat-setup-title" className="text-xl font-semibold text-[#0f1419] text-center">
          Ready for another round?
        </h2>
        <p className="text-sm text-[#71767b] text-center mt-1.5">
          Here&apos;s your last setup. Jump straight in, or tweak anything below.
        </p>

        {/* Summary rows */}
        <div className="mt-5 border border-slate-200 rounded-xl divide-y divide-slate-100 bg-slate-50/60">
          {rows.map((row) => (
            <div
              key={`${row.label}-${row.step}`}
              className="flex items-center justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                  {row.label}
                </div>
                <div className="text-sm font-semibold text-slate-800 truncate">
                  {row.value}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onEdit(row.step)}
                className="shrink-0 text-xs font-medium text-blue-600 hover:text-blue-700 flex items-center gap-1 transition-colors"
              >
                <Edit3 className="w-3 h-3" /> Edit
              </button>
            </div>
          ))}
        </div>

        {/* Actions */}
        <div className="mt-5 flex flex-col gap-2.5">
          <Button variant="primary" size="md" glow onClick={onStart} isFullWidth>
            Enter Interview Room
            <ArrowRight className="w-4 h-4 ml-1.5" />
          </Button>
          <button
            type="button"
            onClick={onStartOver}
            className="text-xs font-medium text-slate-500 hover:text-slate-800 transition-colors mx-auto"
          >
            Start over with a fresh setup
          </button>
        </div>
      </div>
    </div>
  )
}
