'use client'

import { useState, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { getDomainTips, CHECKLIST_SECTIONS, WARMUP_QUESTIONS } from '@interview/config/prepTips'
import type { PrepTip } from '@interview/config/prepTips'

interface PrepChecklistProps {
  domainSlug: string
  domainLabel: string
  duration: number
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function TipIcon({ icon }: { icon: PrepTip['icon'] }) {
  const cls = 'w-3.5 h-3.5'
  switch (icon) {
    case 'star':
      return <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg>
    case 'chart':
      return <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
    case 'users':
      return <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" /></svg>
    case 'code':
      return <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" /></svg>
    case 'bulb':
      return <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>
  }
}

// ─── WarmUp Question sub-component ───────────────────────────────────────────

function WarmUpQuestion() {
  const [active, setActive] = useState(false)
  const [timeLeft, setTimeLeft] = useState(60)
  const [question] = useState(() =>
    WARMUP_QUESTIONS[Math.floor(Math.random() * WARMUP_QUESTIONS.length)]
  )

  const startWarmUp = () => {
    setActive(true)
    setTimeLeft(60)
    const interval = setInterval(() => {
      setTimeLeft(prev => {
        if (prev <= 1) {
          clearInterval(interval)
          setActive(false)
          return 0
        }
        return prev - 1
      })
    }, 1000)
  }

  return (
    <div className="space-y-3">
      <div className="bg-[#f8fafc] rounded-xl p-4 space-y-3">
        <div className="flex items-start gap-3">
          <div className="w-6 h-6 rounded-full bg-blue-500/20 flex items-center justify-center shrink-0 mt-0.5">
            <svg className="w-3.5 h-3.5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-[#0f1419]">Warm-up question</p>
            <p className="text-sm text-[#536471] mt-1">{question}</p>
          </div>
        </div>

        <AnimatePresence mode="wait">
          {!active ? (
            <motion.button
              key="start"
              onClick={startWarmUp}
              className="w-full py-2.5 rounded-xl bg-blue-600/10 border border-blue-500/30 text-sm text-blue-600 font-medium hover:bg-blue-600/20 transition-colors"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              Start 60s warm-up (not scored)
            </motion.button>
          ) : (
            <motion.div
              key="timer"
              className="space-y-2"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <div className="flex items-center gap-3">
                <div className="w-2 h-2 rounded-full bg-[#f4212e] animate-pulse" />
                <span className="text-sm text-[#0f1419]">Speaking... answer out loud</span>
                <span className="ml-auto text-sm font-mono text-[#536471] tabular-nums">{timeLeft}s</span>
              </div>
              <div className="h-1 bg-[#eff3f4] rounded-full overflow-hidden">
                <motion.div
                  className="h-full bg-blue-500 rounded-full"
                  initial={{ width: '100%' }}
                  animate={{ width: '0%' }}
                  transition={{ duration: 60, ease: 'linear' }}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <p className="text-xs text-[#8b98a5] text-center">Practice your delivery — this won&apos;t be recorded or scored.</p>
    </div>
  )
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function PrepChecklist({ domainSlug, domainLabel, duration }: PrepChecklistProps) {
  const [checkedItems, setCheckedItems] = useState<Set<string>>(new Set())
  const [openSection, setOpenSection] = useState<string | null>(null)
  const domainTips = useMemo(() => getDomainTips(domainSlug), [domainSlug])

  const totalItems = CHECKLIST_SECTIONS.reduce((sum, s) => sum + s.items.length, 0)
  const checkedCount = checkedItems.size
  const progress = totalItems > 0 ? Math.round((checkedCount / totalItems) * 100) : 0

  const toggleItem = (sectionId: string, itemIdx: number) => {
    const key = `${sectionId}:${itemIdx}`
    setCheckedItems(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleSection = (sectionId: string) => {
    setOpenSection(prev => prev === sectionId ? null : sectionId)
  }

  const estimatedDuration = duration === 10 ? '10-15' : duration === 20 ? '20-25' : '30-40'

  return (
    <div className="bg-white/90 backdrop-blur-sm border border-[#e1e8ed] rounded-2xl p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[#0f1419]">Interview Prep</h2>
        <span className="text-xs text-[#71767b]">~{estimatedDuration} min total</span>
      </div>

      {/* Progress bar */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs text-[#71767b]">{checkedCount} of {totalItems} items checked</span>
          <span className="text-xs text-[#71767b] font-mono tabular-nums">{progress}%</span>
        </div>
        <div className="h-1.5 bg-[#eff3f4] rounded-full overflow-hidden">
          <motion.div
            className="h-full bg-emerald-500 rounded-full"
            animate={{ width: `${progress}%` }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
          />
        </div>
      </div>

      {/* Checklist sections (accordion) */}
      <div className="space-y-2">
        {CHECKLIST_SECTIONS.map(section => {
          const isOpen = openSection === section.id
          const sectionChecked = section.items.filter((_, i) => checkedItems.has(`${section.id}:${i}`)).length
          const sectionComplete = sectionChecked === section.items.length

          return (
            <div key={section.id} className="rounded-xl border border-[#e1e8ed] overflow-hidden">
              <button
                onClick={() => toggleSection(section.id)}
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[#f8fafc] transition-colors"
                aria-expanded={isOpen}
              >
                <span className="text-base">{section.icon}</span>
                <span className="text-sm text-[#0f1419] flex-1">{section.title}</span>
                {sectionComplete && (
                  <span className="text-xs text-emerald-400 font-medium">Done</span>
                )}
                {!sectionComplete && sectionChecked > 0 && (
                  <span className="text-xs text-[#8b98a5]">{sectionChecked}/{section.items.length}</span>
                )}
                <svg
                  className={`w-3.5 h-3.5 text-[#8b98a5] shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              <AnimatePresence>
                {isOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <div className="px-4 pb-3 space-y-2">
                      {section.items.map((item, idx) => {
                        const key = `${section.id}:${idx}`
                        const checked = checkedItems.has(key)
                        return (
                          <label key={idx} className="flex items-start gap-3 cursor-pointer group">
                            <div className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                              checked
                                ? 'bg-emerald-500 border-emerald-500'
                                : 'border-[#e1e8ed] group-hover:border-[#536471]'
                            }`}>
                              {checked && (
                                <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                </svg>
                              )}
                            </div>
                            <span className={`text-sm transition-colors ${checked ? 'text-[#8b98a5] line-through' : 'text-[#536471]'}`}>
                              {item}
                            </span>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleItem(section.id, idx)}
                              className="sr-only"
                            />
                          </label>
                        )
                      })}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )
        })}
      </div>

      {/* Domain-specific tips */}
      <div className="space-y-2.5">
        <h3 className="text-xs font-semibold text-[#536471] uppercase tracking-wider">
          Tips for {domainLabel}
        </h3>
        <ul className="space-y-2">
          {domainTips.map((tip, i) => (
            <li key={i} className="flex items-start gap-2.5 text-sm text-[#536471]">
              <span className="text-[#2563eb] mt-0.5 shrink-0">
                <TipIcon icon={tip.icon} />
              </span>
              {tip.text}
            </li>
          ))}
        </ul>
      </div>

      {/* Warm-up question */}
      <WarmUpQuestion />
    </div>
  )
}
