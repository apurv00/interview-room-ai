'use client'

import { useEffect, useState, Suspense } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useSearchParams } from 'next/navigation'

interface WeakQuestion {
  sessionId: string
  questionIndex: number
  question: string
  answer: string
  avgScore: number
  relevance: number
  structure: number
  specificity: number
  ownership: number
  competency: string
  sessionDate: string
}

interface DrillResult {
  newScore: number
  delta: number
  breakdown: {
    relevance: number
    structure: number
    specificity: number
    ownership: number
  }
}

const COMPETENCIES = [
  { value: '', label: 'All' },
  { value: 'relevance', label: 'Relevance' },
  { value: 'structure', label: 'Structure' },
  { value: 'specificity', label: 'Specificity' },
  { value: 'ownership', label: 'Ownership' },
]

export default function DrillPage() {
  return (
    <Suspense fallback={
      <main className="max-w-4xl mx-auto px-4 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-[#eff3f4] rounded w-48" />
          {[1, 2, 3].map(i => <div key={i} className="h-24 bg-[#eff3f4] rounded-xl" />)}
        </div>
      </main>
    }>
      <DrillPageInner />
    </Suspense>
  )
}

function DrillPageInner() {
  const searchParams = useSearchParams()
  const [questions, setQuestions] = useState<WeakQuestion[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState(searchParams.get('competency') || '')

  // Active drill state
  const [activeQuestion, setActiveQuestion] = useState<WeakQuestion | null>(null)
  const [newAnswer, setNewAnswer] = useState('')
  const [evaluating, setEvaluating] = useState(false)
  const [result, setResult] = useState<DrillResult | null>(null)
  const [showOriginal, setShowOriginal] = useState(false)

  useEffect(() => {
    setLoading(true)
    const params = new URLSearchParams()
    if (filter) params.set('competency', filter)
    fetch(`/api/learn/drill/questions?${params}`)
      .then(r => r.json())
      .then(d => { setQuestions(d.questions || []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [filter])

  const startDrill = (q: WeakQuestion) => {
    setActiveQuestion(q)
    setNewAnswer('')
    setResult(null)
    setShowOriginal(false)
  }

  const submitAnswer = async () => {
    if (!activeQuestion || !newAnswer.trim()) return
    setEvaluating(true)
    try {
      const res = await fetch('/api/learn/drill/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: activeQuestion.sessionId,
          questionIndex: activeQuestion.questionIndex,
          question: activeQuestion.question,
          originalAnswer: activeQuestion.answer,
          originalScore: activeQuestion.avgScore,
          newAnswer: newAnswer.trim(),
          competency: activeQuestion.competency,
        }),
      })
      const data = await res.json()
      setResult(data)
    } catch {
      // silently fail
    } finally {
      setEvaluating(false)
    }
  }

  const resetDrill = () => {
    setActiveQuestion(null)
    setNewAnswer('')
    setResult(null)
    setShowOriginal(false)
  }

  if (loading) {
    return (
      <main className="max-w-4xl mx-auto px-4 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-[#eff3f4] rounded w-48" />
          <div className="h-4 bg-[#eff3f4] rounded w-72" />
          {[1, 2, 3].map(i => <div key={i} className="h-24 bg-[#eff3f4] rounded-xl" />)}
        </div>
      </main>
    )
  }

  return (
    <main className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      <div>
        <motion.h1
          className="text-2xl font-bold text-[#0f1419]"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
        >
          Drill Mode
        </motion.h1>
        <p className="text-sm text-[#71767b] mt-1">
          Re-attempt your weakest answers and see how much you improve.
        </p>
      </div>

      {/* Competency filter */}
      <div className="flex gap-2 flex-wrap">
        {COMPETENCIES.map(c => (
          <button
            key={c.value}
            onClick={() => setFilter(c.value)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
              filter === c.value
                ? 'bg-blue-600 text-white'
                : 'bg-[#eff3f4] text-[#8b98a5] hover:text-[#536471]'
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        {activeQuestion ? (
          <motion.div
            key="drill-active"
            className="space-y-6"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
          >
            {/* Question */}
            <div className="surface-card-bordered p-5 sm:p-6">
              <div className="flex items-start justify-between gap-4 mb-4">
                <h2 className="text-base font-semibold text-[#0f1419]">{activeQuestion.question}</h2>
                <button
                  onClick={resetDrill}
                  className="text-xs text-[#71767b] hover:text-[#536471] shrink-0"
                >
                  Back
                </button>
              </div>

              <div className="flex items-center gap-3 mb-4">
                <span className="text-xs text-[#71767b]">Original score: {activeQuestion.avgScore}/100</span>
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                  activeQuestion.avgScore < 40 ? 'bg-red-500/10 text-[#f4212e]' : 'bg-amber-500/10 text-[#d97706]'
                }`}>
                  Weak: {activeQuestion.competency}
                </span>
              </div>

              {/* Toggle original answer */}
              <button
                onClick={() => setShowOriginal(!showOriginal)}
                className="text-xs text-blue-400 hover:text-blue-300 mb-3"
              >
                {showOriginal ? 'Hide' : 'Show'} original answer
              </button>
              {showOriginal && (
                <div className="p-3 rounded-lg bg-[#f8fafc] text-sm text-[#8b98a5] mb-4 border border-[#e1e8ed]">
                  {activeQuestion.answer}
                </div>
              )}

              {/* New answer input */}
              {!result && (
                <>
                  <textarea
                    value={newAnswer}
                    onChange={e => setNewAnswer(e.target.value)}
                    placeholder="Type your improved answer here..."
                    rows={6}
                    className="w-full p-4 bg-white border border-[#e1e8ed] rounded-xl text-sm text-[#0f1419] placeholder:text-[#8b98a5] focus:outline-none focus:ring-2 focus:ring-blue-500/50 resize-none"
                  />
                  <button
                    onClick={submitAnswer}
                    disabled={evaluating || !newAnswer.trim()}
                    className="mt-3 px-5 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-[#eff3f4] disabled:text-[#71767b] text-white text-sm font-medium rounded-lg transition-colors"
                  >
                    {evaluating ? 'Evaluating...' : 'Submit Answer'}
                  </button>
                </>
              )}

              {/* Result */}
              {result && (
                <motion.div
                  className="space-y-4 mt-4"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                >
                  {/* Score comparison */}
                  <div className="flex items-center gap-4 p-4 rounded-xl bg-[#f8fafc]">
                    <div className="text-center">
                      <div className="text-xs text-[#71767b]">Original</div>
                      <div className="text-xl font-bold text-[#8b98a5]">{activeQuestion.avgScore}</div>
                    </div>
                    <svg className="w-5 h-5 text-[#8b98a5]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                    </svg>
                    <div className="text-center">
                      <div className="text-xs text-[#71767b]">New</div>
                      <div className="text-xl font-bold text-[#0f1419]">{result.newScore}</div>
                    </div>
                    <div className={`ml-auto px-3 py-1 rounded-lg text-sm font-semibold ${
                      result.delta > 0
                        ? 'bg-emerald-500/10 text-[#059669]'
                        : result.delta < 0
                        ? 'bg-red-500/10 text-[#f4212e]'
                        : 'bg-[#eff3f4] text-[#8b98a5]'
                    }`}>
                      {result.delta > 0 ? '+' : ''}{result.delta}
                    </div>
                  </div>

                  {/* Dimension breakdown */}
                  <div className="grid grid-cols-2 gap-3">
                    {Object.entries(result.breakdown).map(([dim, score]) => {
                      const orig = activeQuestion[dim as keyof typeof activeQuestion] as number
                      const d = score - orig
                      return (
                        <div key={dim} className="p-3 rounded-lg bg-[#f8fafc]">
                          <div className="text-xs text-[#8b98a5] capitalize mb-1">{dim}</div>
                          <div className="flex items-baseline gap-2">
                            <span className="text-sm font-medium text-[#0f1419]">{score}</span>
                            {d !== 0 && (
                              <span className={`text-xs ${d > 0 ? 'text-[#059669]' : 'text-[#f4212e]'}`}>
                                {d > 0 ? '+' : ''}{d}
                              </span>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  <div className="flex gap-3">
                    <button
                      onClick={() => { setResult(null); setNewAnswer('') }}
                      className="px-4 py-2 bg-[#f8fafc] hover:bg-[#eff3f4] text-sm text-[#536471] rounded-lg transition-colors"
                    >
                      Try Again
                    </button>
                    <button
                      onClick={resetDrill}
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
                    >
                      Next Question
                    </button>
                  </div>
                </motion.div>
              )}
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="drill-list"
            className="space-y-3"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            {questions.length === 0 ? (
              <div className="text-center py-16">
                <p className="text-[#71767b] mb-4">
                  {filter
                    ? `No weak ${filter} questions found. Try a different filter.`
                    : 'No weak answers found yet. Complete more interviews to get drill questions!'}
                </p>
                <a
                  href="/lobby"
                  className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  Start an Interview
                </a>
              </div>
            ) : (
              questions.map((q, i) => (
                <motion.div
                  key={`${q.sessionId}-${q.questionIndex}`}
                  className="surface-card-bordered p-4 sm:p-5 cursor-pointer hover:border-blue-500/30 transition-colors"
                  onClick={() => startDrill(q)}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.05 }}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <h3 className="text-sm font-medium text-[#0f1419] line-clamp-2">{q.question}</h3>
                      <div className="flex items-center gap-3 mt-2">
                        <span className="text-xs text-[#71767b]">Score: {q.avgScore}/100</span>
                        <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                          q.avgScore < 30 ? 'bg-red-500/10 text-[#f4212e]' :
                          q.avgScore < 50 ? 'bg-amber-500/10 text-[#d97706]' :
                          'bg-yellow-500/10 text-[#d97706]'
                        }`}>
                          {q.competency}
                        </span>
                      </div>
                    </div>
                    <svg className="w-4 h-4 text-[#8b98a5] shrink-0 mt-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                </motion.div>
              ))
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  )
}
