'use client'

import { useState } from 'react'
import { FileText, Layout, MessageSquare } from 'lucide-react'
import Avatar from '@interview/components/Avatar'
import DesignCanvas from '@interview/components/design/DesignCanvas'
import type { AvatarEmotion, InterviewState, DesignSubmission } from '@shared/types'
import type { DesignProblem } from '@interview/config/designProblems'

type MobileTab = 'problem' | 'design' | 'chat'

interface DesignLayoutProps {
  // Avatar props
  avatarEmotion: AvatarEmotion
  isAvatarTalking: boolean
  isListening: boolean
  isProcessing: boolean
  transcriptWordCount: number

  // Problem
  problem: DesignProblem | null
  phase: InterviewState
  questionIndex: number

  // Design canvas
  onDesignSubmit: (data: DesignSubmission) => void

  // Transcript
  currentQuestion: string
  liveAnswer: string

  // Children (coaching layer)
  children?: React.ReactNode
}

const CANVAS_DISABLED_PHASES = new Set<string>([
  'INIT', 'INTERVIEW_START', 'PROCESSING', 'SCORING', 'ENDED',
])

export default function DesignLayout({
  avatarEmotion,
  isAvatarTalking,
  isListening,
  isProcessing,
  transcriptWordCount,
  problem,
  phase,
  questionIndex,
  onDesignSubmit,
  currentQuestion,
  liveAnswer,
  children,
}: DesignLayoutProps) {
  const [mobileTab, setMobileTab] = useState<MobileTab>('design')
  const canvasDisabled = CANVAS_DISABLED_PHASES.has(phase)

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Desktop: Split layout */}
      <div className="flex-1 flex min-h-0">
        {/* Left panel (35%): Avatar + Problem */}
        <div className="hidden md:flex md:w-[35%] flex-col gap-2 p-3 border-r border-gray-800 min-w-0">
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

              {/* Requirements */}
              <div>
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">Requirements</p>
                <ul className="space-y-1">
                  {problem.requirements.map((req, i) => (
                    <li key={i} className="text-sm text-gray-200 flex gap-2">
                      <span className="text-emerald-400 shrink-0">•</span>
                      {req}
                    </li>
                  ))}
                </ul>
              </div>

              {/* Hints */}
              {problem.hints.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">Hints</p>
                  <ul className="space-y-1">
                    {problem.hints.map((hint, i) => (
                      <li key={i} className="text-sm text-amber-200/80 italic">{hint}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Live transcript */}
              {(currentQuestion || liveAnswer) && (
                <div className="border-t border-gray-700 pt-3 mt-3 space-y-2">
                  {currentQuestion && (
                    <p className="text-sm text-blue-300">
                      <span className="font-semibold text-blue-200">Alex: </span>
                      {currentQuestion}
                    </p>
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

        {/* Right panel (65%): Design Canvas */}
        <div className="flex-1 flex flex-col p-3 min-h-0">
          {/* Mobile tabs */}
          <div className="flex md:hidden gap-1 mb-2">
            {([
              { key: 'problem' as MobileTab, icon: <FileText className="w-3.5 h-3.5" />, label: 'Problem' },
              { key: 'design' as MobileTab, icon: <Layout className="w-3.5 h-3.5" />, label: 'Design' },
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

          {/* Design canvas */}
          <div className={`flex-1 min-h-0 ${mobileTab !== 'design' ? 'hidden md:flex md:flex-col' : 'flex flex-col'}`}>
            <DesignCanvas
              onSubmit={onDesignSubmit}
              questionIndex={questionIndex}
              disabled={canvasDisabled}
            />
          </div>
        </div>
      </div>

      {/* Coaching layer */}
      {children}
    </div>
  )
}
