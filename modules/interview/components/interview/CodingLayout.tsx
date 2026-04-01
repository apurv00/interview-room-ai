'use client'

import { useState } from 'react'
import { FileText, Code2, MessageSquare } from 'lucide-react'
import Avatar from '@interview/components/Avatar'
import CodeEditor from './CodeEditor'
import type { AvatarEmotion, InterviewState, CodeLanguage } from '@shared/types'
import type { CodingProblem } from '@interview/config/codingProblems'

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

  // Transcript
  currentQuestion: string
  liveAnswer: string

  // Children (coaching layer)
  children?: React.ReactNode
}

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
  currentQuestion,
  liveAnswer,
  children,
}: CodingLayoutProps) {
  const [mobileTab, setMobileTab] = useState<MobileTab>('code')
  const isCodePhase = phase === 'CODE_EDITING'
  const starterCode = problem?.starterCode?.[language] || ''

  return (
    <div className="flex flex-col h-full">
      {/* Desktop: Split layout */}
      <div className="flex-1 flex min-h-0">
        {/* Left panel (40%): Avatar + Transcript */}
        <div className="hidden md:flex md:w-[40%] flex-col gap-2 p-3 border-r border-gray-800">
          {/* Avatar (compact) */}
          <div className="h-32 flex items-center justify-center bg-gray-900/50 rounded-lg overflow-hidden">
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
            <div className="flex-1 overflow-y-auto bg-gray-900/30 rounded-lg p-3 space-y-3">
              <h3 className="text-sm font-semibold text-white">{problem.title}</h3>
              <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${
                problem.difficulty === 'easy' ? 'bg-emerald-500/20 text-emerald-400' :
                problem.difficulty === 'medium' ? 'bg-amber-500/20 text-amber-400' :
                'bg-red-500/20 text-red-400'
              }`}>
                {problem.difficulty.charAt(0).toUpperCase() + problem.difficulty.slice(1)}
              </span>

              <p className="text-xs text-gray-300 whitespace-pre-line">{problem.description}</p>

              {/* Examples */}
              <div className="space-y-2">
                {problem.examples.map((ex, i) => (
                  <div key={i} className="bg-gray-800/50 rounded-md p-2 text-xs">
                    <div className="text-gray-400">
                      <span className="text-gray-500">Input: </span>
                      <code className="text-gray-300">{ex.input}</code>
                    </div>
                    <div className="text-gray-400">
                      <span className="text-gray-500">Output: </span>
                      <code className="text-emerald-400">{ex.output}</code>
                    </div>
                    {ex.explanation && (
                      <div className="text-gray-500 mt-1">{ex.explanation}</div>
                    )}
                  </div>
                ))}
              </div>

              {/* Constraints */}
              <div>
                <p className="text-[10px] font-medium text-gray-500 uppercase mb-1">Constraints</p>
                <ul className="text-xs text-gray-400 space-y-0.5">
                  {problem.constraints.map((c, i) => (
                    <li key={i} className="font-mono text-[11px]">{c}</li>
                  ))}
                </ul>
              </div>

              {/* Live transcript */}
              {(currentQuestion || liveAnswer) && (
                <div className="border-t border-gray-700 pt-2 mt-2">
                  {currentQuestion && (
                    <p className="text-xs text-blue-400 mb-1"><span className="font-medium">Alex:</span> {currentQuestion}</p>
                  )}
                  {liveAnswer && (
                    <p className="text-xs text-gray-300"><span className="font-medium text-purple-400">You:</span> {liveAnswer}</p>
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
                className={`flex items-center gap-1 px-3 py-1.5 text-xs rounded-md transition-colors ${
                  mobileTab === tab.key ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'
                }`}
              >
                {tab.icon} {tab.label}
              </button>
            ))}
          </div>

          {/* Code editor (always visible on desktop, conditionally on mobile) */}
          <div className={`flex-1 min-h-0 ${mobileTab !== 'code' ? 'hidden md:flex md:flex-col' : 'flex flex-col'}`}>
            <CodeEditor
              initialCode={starterCode}
              language={language}
              onLanguageChange={onLanguageChange}
              onSubmit={onCodeSubmit}
              disabled={!isCodePhase && phase !== 'LISTENING'}
            />
          </div>
        </div>
      </div>

      {/* Coaching layer */}
      {children}
    </div>
  )
}
