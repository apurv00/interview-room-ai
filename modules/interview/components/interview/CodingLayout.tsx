'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { FileText, Code2, MessageSquare, Clock } from 'lucide-react'
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
  /** Seconds left to answer the post-submit verbal question (0 when none active). */
  answerSecondsLeft?: number

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
  answerSecondsLeft = 0,
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
          // Send the problem so the route can clarify AI-generated problems that
          // aren't in the static pool (otherwise: "Problem not found").
          problem: {
            title: problem.title,
            difficulty: problem.difficulty,
            description: problem.description,
            examples: problem.examples,
            constraints: problem.constraints,
          },
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

  // The live transcript is shared by the desktop left panel (pinned at the bottom)
  // and the mobile Chat tab (its own full-height view), so the Problem and Chat
  // tabs stay distinct and a long problem can't bury the conversation. Codex P2.
  const renderConversation = () => {
    if (!currentQuestion && !liveAnswer && answerSecondsLeft <= 0) return null
    return (
      <div className="space-y-2">
        {/* Visible answer countdown — so the candidate knows there's a time limit
            and it auto-advances if they stay silent. Candidate feedback 2026-06-16. */}
        {answerSecondsLeft > 0 && (
          <div
            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold ${
              answerSecondsLeft <= 5 ? 'bg-red-500/25 text-red-300 animate-pulse' : 'bg-amber-500/20 text-amber-300'
            }`}
          >
            <Clock className="w-3 h-3" />
            {answerSecondsLeft}s to answer
          </div>
        )}
        {currentQuestion && (
          <div
            className={`rounded-md transition-all duration-500 ${
              questionHighlight
                ? 'bg-blue-500/15 ring-2 ring-blue-400/70 animate-pulse px-3 py-2 -mx-1'
                : ''
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
    )
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Mobile tab bar — switches which full-width panel shows. Hidden on
          desktop, where both panels render side by side. */}
      <div className="flex md:hidden gap-1 p-2 border-b border-gray-800 shrink-0">
        {([
          { key: 'problem' as MobileTab, icon: <FileText className="w-3.5 h-3.5" />, label: 'Problem' },
          { key: 'code' as MobileTab, icon: <Code2 className="w-3.5 h-3.5" />, label: 'Code' },
          { key: 'chat' as MobileTab, icon: <MessageSquare className="w-3.5 h-3.5" />, label: 'Chat' },
        ]).map((tab) => (
          <button
            key={tab.key}
            onClick={() => setMobileTab(tab.key)}
            className={`relative flex items-center gap-1.5 px-3 py-2 text-sm rounded-md transition-colors ${
              mobileTab === tab.key ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'
            }`}
          >
            {tab.icon} {tab.label}
            {/* Unread cue: a new question arrived while the candidate is on another tab */}
            {tab.key === 'chat' && questionHighlight && mobileTab !== 'chat' && (
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-blue-400 animate-ping" />
            )}
          </button>
        ))}
      </div>

      {/* Follow-up banner — mobile only, ABOVE the panels on any tab EXCEPT Chat
          (where the conversation is already visible). Lives here (not inside the
          Code panel) so a new question is seen on the Problem tab too. Review P1. */}
      {questionHighlight && currentQuestion && mobileTab !== 'chat' && (
        <div className="md:hidden m-2 rounded-md bg-blue-500/15 ring-2 ring-blue-400/70 px-3 py-2 animate-pulse shrink-0">
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

      {/* Mobile answer countdown — shown on EVERY mobile tab (incl. Code) so the
          candidate sees the timer wherever they are during the verbal follow-up.
          Independent of the 6s question-highlight banner above. Review P2. */}
      {answerSecondsLeft > 0 && (
        <div className="md:hidden mx-2 mb-1 flex justify-center shrink-0">
          <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold ${
            answerSecondsLeft <= 5 ? 'bg-red-500/25 text-red-300 animate-pulse' : 'bg-amber-500/20 text-amber-300'
          }`}>
            <Clock className="w-3 h-3" />{answerSecondsLeft}s to answer
          </span>
        </div>
      )}

      {/* Split layout: both panels on desktop; one at a time on mobile via tabs */}
      <div className="flex-1 flex min-h-0">
        {/* Left panel: Avatar + Problem + Conversation. Full-width on mobile when
            its tab is active (problem/chat); 40% on desktop. */}
        <div className={`${mobileTab === 'code' ? 'hidden' : 'flex'} md:flex w-full md:w-[40%] flex-col gap-2 p-3 md:border-r border-gray-800 min-w-0`}>
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

          {/* Problem panel — mobile: 'problem' tab only; desktop: always */}
          {problem && (
            <div className={`${mobileTab === 'chat' ? 'hidden md:block' : ''} flex-1 overflow-y-auto bg-gray-900/60 rounded-lg p-4 space-y-3`}>
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
                {problem.expectedTimeMinutes > 0 && (
                  <span
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gray-700/60 text-gray-300"
                    title="Suggested time for this problem"
                  >
                    <Clock className="w-3 h-3" />~{problem.expectedTimeMinutes} min
                  </span>
                )}
              </div>

              {/* Description */}
              <p className="text-sm text-gray-100 whitespace-pre-line leading-relaxed">{problem.description}</p>

              {/* Examples */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Examples</p>
                  <span className="text-[10px] text-emerald-400/80">Press <span className="font-semibold">Run</span> to test against these →</span>
                </div>
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

              {/* Live transcript — pinned at the bottom on DESKTOP. On mobile the
                  conversation lives in its own Chat tab (below) so a long problem
                  can't bury it. */}
              {(currentQuestion || liveAnswer) && (
                <div className="hidden md:block border-t border-gray-700 pt-3 mt-3">
                  {renderConversation()}
                </div>
              )}
            </div>
          )}

          {/* Chat panel — MOBILE 'chat' tab only (desktop shows the transcript in
              the problem panel above). A dedicated, un-buried conversation view. */}
          <div
            className={`${mobileTab === 'chat' ? 'flex' : 'hidden'} md:hidden flex-1 min-h-0 flex-col overflow-y-auto bg-gray-900/60 rounded-lg p-4`}
          >
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Conversation</p>
            {renderConversation() ?? (
              <p className="text-sm text-gray-500">
                No conversation yet — the interviewer&apos;s questions and your live answer will appear here.
              </p>
            )}
          </div>
        </div>

        {/* Right panel: Code Editor. Full-width on mobile when the Code tab is
            active; 60% on desktop. */}
        <div className={`${mobileTab === 'code' ? 'flex' : 'hidden'} md:flex flex-1 flex-col p-3 min-h-0`}>
          {/* (Follow-up banner now lives above the panels so it shows on every
              mobile tab, not just Code — Review P1.) */}

          {/* Code editor */}
          <div className="flex-1 min-h-0 flex flex-col">
            <CodeEditor
              initialCode={starterCode}
              language={language}
              onLanguageChange={onLanguageChange}
              onSubmit={onCodeSubmit}
              disabled={editorDisabled}
              // The interview loop only installs its submission resolver during
              // CODE_EDITING; submitting earlier (while the problem is being read
              // in ASK_QUESTION) is silently dropped. Gate Submit to that phase so
              // an early click can't lock the button as "Submitted". Codex P2.
              canSubmit={phase === 'CODE_EDITING'}
              // LeetCode-style: Run executes the candidate's code against these
              // example test cases and shows expected-vs-actual + pass/fail.
              runContext={problem ? { title: problem.title, description: problem.description, examples: problem.examples } : undefined}
            />
          </div>
        </div>
      </div>

      {/* Coaching layer */}
      {children}
    </div>
  )
}
