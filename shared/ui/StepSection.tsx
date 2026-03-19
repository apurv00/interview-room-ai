'use client'

import { useEffect, useState } from 'react'

interface StepSectionProps {
  step: number
  label: string
  children: React.ReactNode
  visible?: boolean
  completed?: boolean
  highlight?: boolean
}

export default function StepSection({ step, label, children, visible = true, completed = false, highlight = false }: StepSectionProps) {
  const [pulse, setPulse] = useState(false)

  useEffect(() => {
    if (highlight) {
      setPulse(true)
      const timer = setTimeout(() => setPulse(false), 2000)
      return () => clearTimeout(timer)
    }
  }, [highlight])

  if (!visible) return null

  return (
    <section
      id={`step-${step}`}
      className={`space-y-3 rounded-xl transition-all duration-300 ${
        pulse ? 'ring-2 ring-[rgba(99,102,241,0.4)] bg-[rgba(99,102,241,0.03)] p-4 -m-4' : ''
      }`}
    >
      <div className="step-label flex items-center gap-1.5">
        <span className="flex items-center gap-1">
          {step}
          {completed && (
            <svg className="w-3 h-3 text-[#34d399]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          )}
        </span>
        <span className="text-[var(--foreground-muted)]/50">·</span>
        <span>{label}</span>
      </div>
      {children}
    </section>
  )
}
