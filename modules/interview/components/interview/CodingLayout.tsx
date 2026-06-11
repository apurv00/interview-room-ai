'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { FileText, Code2, MessageSquare } from 'lucide-react'
import Avatar from '@interview/components/Avatar'
import CodeEditor from './CodeEditor'
import ClarificationsPanel from './ClarificationsPanel'
import type { AvatarEmotion, InterviewState, CodeLanguage } from '@shared/types'
import { getStarterCode, type CodingProblem } from '@interview/config/codingProblems'
import type { CodingClarificationRecord } from '@interview/validators/clarifyCoding'

type MobileTab = 'problem' | 'code' | 'chat'

interface CodingLayoutProps {
  // Avatar props
  avatarEmotion: AvatarEmotion
  isAvatarTalking: boolean
  isListening: boolean
  isProcessing: boolean
  transcriptWordCount: number

  // Problem
  problem: CodingProblem | null
  phase: InterviewState

  // Code editor
  language: CodeLanguage
  onLanguageChange: (lang: CodeLanguage) => void
  onCodeSubmit: (code: string) => void

  // Clarifications
  sessionId?: string

  // Transcript
  currentQuestion: string
  liveAnswer: string

  // Children (coaching layer)
  children?: React.ReactNode
}

// Editor should only be locked during these phases
const EDITOR_DISABLED_PHASES = new Set<string>([
  'INIT', 'INTERVIEW_START', 'PROCESSING', 'SCORING', 'ENDED',
])

export default function CodingLayout({
  avatarEmotion,
  isAvatarTalking,
  isListening,
  isProcessing,
  transcriptWordCount,
  problem,
  phase,
  language,
  onLanguageChange,
  onCodeSubmit,
  sessionId,
  currentQuestion,
  liveAnswer,
  children,
}: CodingLayoutProps) {
  const [mobileTab, setMobileTab] = useState<MobileTab>('code')
  // Always resolve to a non-empty per-language skeleton so Java/C++/TS never
  // open an empty editor (getStarterCode falls back to a generic skeleton).
  const starterCode = getStarterCode(problem, language)
  const editorDisabled = EDITOR_DISABLED_PHASES.has(phase)

  // ── Clarifications: append-only Q&A about the current problem ──
  const [clarifications, setClarifications] = useState<CodingClarificationRecord[]>([])

  // Reset clarifications when the problem changes
  useEffect(() => {
    setClarifications([])
  }, [problem?.id])

  // ── Follow-up highlight: when the interviewer asks a NEW question while the
  // candidate is heads-down in the editor, briefly highlight the conversation so
  // it isn't missed. The first question (the problem brief) isn't a "follow-up";
  // anything after it is flagged as one. (Candidate feedback, 2026-06-11.)
  const prevQuestionRef = useRef('')
  const questionCountRef = useRef(0)
  const [questionHighlight, setQuestionHighlight] = useState(false)
  const [isFollowUp, setIsFollowUp] = useState(false)

  useEffect(() => {
    const q = (currentQuestion || '').trim()
    if (!q || q === prevQuestionRef.current) return
    prevQuestionRef.current = q
    questionCountRef.current += 1
    setIsFollowUp(questionCountRef.current > 1)
    setQuestionHighlight(true)
    const t = setTimeout(() => setQuestionHighlight(false), 6000)
    return () => clearTimeout(t)
  }, [currentQuestion])

  // A brand-new problem resets the follow-up counter (next brief is question #1).
  useEffect(() => {
    prevQuestionRef.current = ''
    questionCountRef.current = 0
    setQuestionHighlight(false)
    setIsFollowUp(false)
  }, [problem?.id])

  const askClarification = useCallback(
    async (question: string) => {
      if (!problem) throw new Error('No active problem')
      const res = await fetch('/api/interview/clarify-coding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          problemId: problem.id,
          candidateQuestion: question,
          language,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `Request failed (${res.status})`)
      }
      const record = (await res.json()) as CodingClarificationRecord
      setClarifications((prev) => [...prev, record])
    },
    [problem, sessionId, language]
  )

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Desktop: Split layout */}
      <div className="flex-1 flex min-h-0">
        {/* Left panel (40%): Avatar + Problem */}
        <div className="hidden md:flex md:w-[40%] flex-col gap-2 p-3 border-r border-gray-800 min-w-0">
          {/* Avatar (compact) */}
          <div className="h-28 flex items-center justify-center bg-gray-900/50 rounded-lg overflow-hidden shrink-0">
            <Avatar
              emotion={avatarEmotion}
              isTalking={isAvatarTalking}
              isListening={isListening}
              isProcessing={isProcessing}
              transcriptWordCount={transcriptWordCount}
            />
          </div>

          {/* Problem description */}
          {problem && (
            <div className="flex-1 overflow-y-auto bg-gray-900/60 rounded-lg p-4 space-y-3">
              {/* Title + difficulty */}
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-white">{problem.title}</h3>
                <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                  problem.difficulty === 'easy' ? 'bg-emerald-500/25 text-emerald-300' :
                  problem.difficulty === 'medium' ? 'bg-amber-500/25 text-amber-300' :
                  'bg-red-500/25 text-red-300'
                }`}>
                  {problem.difficulty.charAt(0).toUpperCase() + problem.difficulty.slice(1)}
                </span>
              </div>

              {/* Description */}
              <p className="text-sm text-gray-100 whitespace-pre-line leading-relaxed">{problem.description}</p>

              {/* Examples */}
              <div className="space-y-2">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Examples</p>
                {problem.examples.map((ex, i) => (
                  <div key={i} className="bg-gray-800/80 rounded-md p-3 space-y-1">
                    <div>
                      <span className="text-xs text-gray-400 font-medium">Input: </span>
                      <code className="text-sm text-white font-mono">{ex.input}</code>
                    </div>
                    <div>
                      <span className="text-xs text-gray-400 font-medium">Output: </span>
                      <code className="text-sm text-emerald-300 font-mono">{ex.output}</code>
                    </div>
                    {ex.explanation && (
                      <div className="text-xs text-gray-300 mt-1 italic">{ex.explanation}</div>
                    )}
                  </div>
                ))}
              </div>

              {/* Constraints */}
              <div>
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">Constraints</p>
                <ul className="space-y-1">
                  {problem.constraints.map((c, i) => (
                    <li key={i} className="text-sm text-gray-200 font-mono">{c}</li>
                  ))}
                </ul>
              </div>

              {/* Clarifications */}
              <ClarificationsPanel
                clarifications={clarifications}
                onAsk={askClarification}
                disabled={editorDisabled}
              />

              {/* Live transcript */}
              {(currentQuestion || liveAnswer) && (
                <div className="border-t border-gray-700 pt-3 mt-3 space-y-2">
                  {currentQuestion && (
                    <div
                      className={`rounded-md transition-all duration-500 ${
                        questionHighlight
                          ? 'bg-blue-500/15 ring-2 ring-blue-400/70 animate-pulse px-3 py-2 -mx-1'
                          : 'px-0 py-0'
                      }`}
                    >
                      {questionHighlight && (
                        <span className="inline-flex items-center gap-1 mb-1 px-1.5 py-0.5 rounded-full bg-blue-500/30 text-blue-100 text-[10px] font-semibold uppercase tracking-wide">
                          <span className="w-1.5 h-1.5 rounded-full bg-blue-300 animate-ping" />
                          {isFollowUp ? 'Follow-up question' : 'New question'}
                        </span>
                      )}
                      <p className="text-sm text-blue-300">
                        <span className="font-semibold text-blue-200">Alex: </span>
                        {currentQuestion}
                      </p>
                    </div>
                  )}
                  {liveAnswer && (
                    <p className="text-sm text-gray-200">
                      <span className="font-semibold text-purple-300">You: </span>
                      {liveAnswer}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right panel (60%): Code Editor */}
        <div className="flex-1 flex flex-col p-3 min-h-0">
          {/* Mobile tabs */}
          <div className="flex md:hidden gap-1 mb-2">
            {([
              { key: 'problem' as MobileTab, icon: <FileText className="w-3.5 h-3.5" />, label: 'Problem' },
              { key: 'code' as MobileTab, icon: <Code2 className="w-3.5 h-3.5" />, label: 'Code' },
              { key: 'chat' as MobileTab, icon: <MessageSquare className="w-3.5 h-3.5" />, label: 'Chat' },
            ]).map((tab) => (
              <button
                key={tab.key}
                onClick={() => setMobileTab(tab.key)}
                className={`flex items-center gap-1.5 px-3 py-2 text-sm rounded-md transition-colors ${
                  mobileTab === tab.key ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'
                }`}
              >
                {tab.icon} {tab.label}
              </button>
            ))}
          </div>

          {/* Mobile follow-up banner — surfaces a new question ABOVE the editor
              so it stays visible (the problem panel is desktop-only). Codex P2. */}
          {questionHighlight && currentQuestion && (
            <div className="md:hidden mb-2 rounded-md bg-blue-500/15 ring-2 ring-blue-400/70 px-3 py-2 animate-pulse shrink-0">
              <span className="inline-flex items-center gap-1 mb-1 px-1.5 py-0.5 rounded-full bg-blue-500/30 text-blue-100 text-[10px] font-semibold uppercase tracking-wide">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-300 animate-ping" />
                {isFollowUp ? 'Follow-up question' : 'New question'}
              </span>
              <p className="text-sm text-blue-200">
                <span className="font-semibold">Alex: </span>
                {currentQuestion}
              </p>
            </div>
          )}

          {/* Code editor */}
          <div className={`flex-1 min-h-0 ${mobileTab !== 'code' ? 'hidden md:flex md:flex-col' : 'flex flex-col'}`}>
            <CodeEditor
              initialCode={starterCode}
              language={language}
              onLanguageChange={onLanguageChange}
              onSubmit={onCodeSubmit}
              disabled={editorDisabled}
            />
          </div>
        </div>
      </div>

      {/* Coaching layer */}
      {children}
    </div>
  )
}
