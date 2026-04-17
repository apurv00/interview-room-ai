'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, Check, Loader2, BookOpen } from 'lucide-react'

export interface LessonListEntry {
  lessonId: string
  competency: string
  completed: boolean
}

interface LessonDetail {
  lessonId: string
  competency: string
  title: string
  conceptSummary: string
  conceptDeepDive: string
  example: {
    question: string
    goodAnswer: string
    annotations: string[]
  }
  keyTakeaways: string[]
  overrideContent?: string
}

interface LessonCardProps {
  entry: LessonListEntry
  index: number
  domain: string
  depth: string
  onComplete: (lessonId: string) => Promise<void>
}

export default function LessonCard({ entry, index, domain, depth, onComplete }: LessonCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [lesson, setLesson] = useState<LessonDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [completing, setCompleting] = useState(false)

  const prettyCompetency = entry.competency.replace(/_/g, ' ')

  const toggle = async () => {
    const next = !expanded
    setExpanded(next)
    if (next && !lesson && !loading) {
      setLoading(true)
      setError(null)
      try {
        const url = `/api/learn/pathway/lesson/${encodeURIComponent(entry.lessonId)}?domain=${encodeURIComponent(domain)}&depth=${encodeURIComponent(depth)}`
        const res = await fetch(url)
        if (!res.ok) {
          setError('Could not load this lesson. Try again in a moment.')
        } else {
          const data = await res.json()
          setLesson(data.lesson)
        }
      } catch {
        setError('Network error loading lesson.')
      } finally {
        setLoading(false)
      }
    }
  }

  const markComplete = async () => {
    if (entry.completed || completing) return
    setCompleting(true)
    try {
      await onComplete(entry.lessonId)
    } finally {
      setCompleting(false)
    }
  }

  return (
    <motion.div
      className={`surface-card-bordered overflow-hidden ${entry.completed ? 'bg-[#f8fafc]' : ''}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.03, 0.3) }}
    >
      <button
        type="button"
        onClick={toggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[#f7fafc] transition-colors"
        aria-expanded={expanded}
      >
        <div
          className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
            entry.completed ? 'bg-emerald-500 text-white' : 'bg-blue-500/10 text-blue-500'
          }`}
          aria-hidden
        >
          {entry.completed ? <Check className="w-4 h-4" /> : <BookOpen className="w-3.5 h-3.5" />}
        </div>

        <div className="flex-1 min-w-0">
          <div className={`text-sm font-medium ${entry.completed ? 'text-[#8b98a5] line-through' : 'text-[#0f1419]'}`}>
            {lesson?.title ?? `Lesson ${index + 1}: ${prettyCompetency}`}
          </div>
          <div className="text-[11px] text-[#8b98a5] capitalize mt-0.5">{prettyCompetency}</div>
        </div>

        <motion.span
          animate={{ rotate: expanded ? 180 : 0 }}
          transition={{ duration: 0.2 }}
          className="shrink-0 text-[#8b98a5]"
          aria-hidden
        >
          <ChevronDown className="w-4 h-4" />
        </motion.span>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 pt-1 border-t border-[#eff3f4] space-y-4">
              {loading && (
                <div className="flex items-center gap-2 text-sm text-[#8b98a5] py-4">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading lesson…
                </div>
              )}

              {error && !loading && (
                <div className="text-sm text-[#f4212e] py-2">{error}</div>
              )}

              {lesson && !loading && !error && (
                <>
                  {lesson.overrideContent ? (
                    <div className="text-sm text-[#0f1419] whitespace-pre-wrap leading-relaxed">
                      {lesson.overrideContent}
                    </div>
                  ) : (
                    <>
                      <section>
                        <div className="text-[11px] uppercase tracking-wide text-[#8b98a5] font-semibold mb-1">
                          Core idea
                        </div>
                        <p className="text-sm text-[#0f1419] leading-relaxed">{lesson.conceptSummary}</p>
                      </section>

                      {lesson.conceptDeepDive && (
                        <section>
                          <div className="text-[11px] uppercase tracking-wide text-[#8b98a5] font-semibold mb-1">
                            How it works
                          </div>
                          <p className="text-sm text-[#536471] leading-relaxed whitespace-pre-wrap">
                            {lesson.conceptDeepDive}
                          </p>
                        </section>
                      )}

                      {lesson.example?.question && (
                        <section className="rounded-xl bg-[#f7fafc] p-3 space-y-2">
                          <div className="text-[11px] uppercase tracking-wide text-blue-500 font-semibold">
                            Worked example
                          </div>
                          <div>
                            <div className="text-xs text-[#8b98a5] mb-1">Question</div>
                            <div className="text-sm text-[#0f1419]">{lesson.example.question}</div>
                          </div>
                          <div>
                            <div className="text-xs text-[#8b98a5] mb-1">Strong answer</div>
                            <div className="text-sm text-[#0f1419] whitespace-pre-wrap leading-relaxed">
                              {lesson.example.goodAnswer}
                            </div>
                          </div>
                          {lesson.example.annotations?.length > 0 && (
                            <div>
                              <div className="text-xs text-[#8b98a5] mb-1">Why it works</div>
                              <ul className="text-sm text-[#536471] list-disc list-inside space-y-1">
                                {lesson.example.annotations.map((a, i) => (
                                  <li key={i}>{a}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </section>
                      )}

                      {lesson.keyTakeaways?.length > 0 && (
                        <section>
                          <div className="text-[11px] uppercase tracking-wide text-[#8b98a5] font-semibold mb-1">
                            Key takeaways
                          </div>
                          <ul className="text-sm text-[#536471] list-disc list-inside space-y-1">
                            {lesson.keyTakeaways.map((t, i) => (
                              <li key={i}>{t}</li>
                            ))}
                          </ul>
                        </section>
                      )}
                    </>
                  )}

                  <div className="flex items-center justify-between pt-2">
                    <a
                      href={`/practice/drill?competency=${encodeURIComponent(entry.competency)}`}
                      className="text-sm text-blue-500 hover:text-blue-600 font-medium"
                    >
                      Drill this competency →
                    </a>
                    {entry.completed ? (
                      <span className="inline-flex items-center gap-1 text-xs text-emerald-600 font-medium">
                        <Check className="w-3.5 h-3.5" /> Completed
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={markComplete}
                        disabled={completing}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white text-xs font-semibold rounded-lg transition-colors"
                      >
                        {completing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                        {completing ? 'Saving…' : 'Mark complete'}
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
