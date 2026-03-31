'use client'

import { useEffect, useRef, useState } from 'react'
import type { InterviewState } from '@shared/types'

// ─── STAR Keywords ──────────────────────────────────────────────────────────

const SITUATION_KEYWORDS = [
  'context', 'background', 'working on', 'working at', 'team was', 'project',
  'company', 'role was', 'at the time', 'situation', 'when i was',
]

const TASK_KEYWORDS = [
  'responsible for', 'needed to', 'goal was', 'challenge was', 'asked to',
  'task was', 'objective', 'my job was', 'assigned to', 'had to',
]

const ACTION_KEYWORDS = [
  'i decided', 'i built', 'i led', 'i created', 'my approach', 'i implemented',
  'i spoke to', 'i organized', 'i analyzed', 'i designed', 'i proposed',
  'i collaborated', 'i initiated', 'i developed', 'i reached out',
]

const RESULT_KEYWORDS = [
  'result was', 'outcome', 'increased by', 'reduced', 'achieved', 'led to',
  'improved', 'saved', 'grew', 'delivered', 'resulted in', 'impact was',
  '%', 'percent', 'revenue', 'users', 'customers',
]

export type StarStep = 'situation' | 'task' | 'action' | 'result'

export interface CoachModeState {
  currentStep: StarStep | null
  completedSteps: StarStep[]
  suggestion: string | null
}

const STEP_SUGGESTIONS: Record<StarStep, string> = {
  situation: 'Set the scene — describe the context, team, and timeframe.',
  task: 'What was your specific responsibility or the challenge you faced?',
  action: 'What actions did YOU take? Use "I" not "we."',
  result: 'What was the measurable outcome? Include numbers if possible.',
}

const CHECK_INTERVAL_MS = 1000

interface UseCoachModeOptions {
  phase: InterviewState
  liveTranscript: string
  enabled: boolean
}

export function useCoachMode({ phase, liveTranscript, enabled }: UseCoachModeOptions): CoachModeState {
  const [state, setState] = useState<CoachModeState>({
    currentStep: null,
    completedSteps: [],
    suggestion: null,
  })

  const transcriptRef = useRef(liveTranscript)
  transcriptRef.current = liveTranscript

  // Reset on new LISTENING phase
  useEffect(() => {
    if (phase === 'LISTENING') {
      setState({ currentStep: null, completedSteps: [], suggestion: 'Start with the Situation — set the context.' })
    } else {
      setState({ currentStep: null, completedSteps: [], suggestion: null })
    }
  }, [phase])

  // Analyze transcript periodically
  useEffect(() => {
    if (phase !== 'LISTENING' || !enabled) return

    const interval = setInterval(() => {
      const text = transcriptRef.current.toLowerCase()
      if (!text || text.length < 10) return

      const detected = detectStarSteps(text)
      const nextStep = getNextStep(detected)
      const suggestion = nextStep
        ? STEP_SUGGESTIONS[nextStep]
        : detected.length >= 4
        ? 'Great STAR structure! Consider adding specific metrics.'
        : getSpecificitySuggestion(text)

      setState({
        currentStep: detected[detected.length - 1] || null,
        completedSteps: detected,
        suggestion,
      })
    }, CHECK_INTERVAL_MS)

    return () => clearInterval(interval)
  }, [phase, enabled])

  return state
}

function detectStarSteps(text: string): StarStep[] {
  const steps: StarStep[] = []

  if (SITUATION_KEYWORDS.some((kw) => text.includes(kw))) steps.push('situation')
  if (TASK_KEYWORDS.some((kw) => text.includes(kw))) steps.push('task')
  if (ACTION_KEYWORDS.some((kw) => text.includes(kw))) steps.push('action')
  if (RESULT_KEYWORDS.some((kw) => text.includes(kw))) steps.push('result')

  return steps
}

function getNextStep(completed: StarStep[]): StarStep | null {
  const order: StarStep[] = ['situation', 'task', 'action', 'result']
  for (const step of order) {
    if (!completed.includes(step)) return step
  }
  return null
}

function getSpecificitySuggestion(text: string): string | null {
  // Check for numbers/metrics
  const hasNumbers = /\d+/.test(text)
  if (!hasNumbers && text.length > 100) {
    return 'Try adding a specific number or metric to strengthen your answer.'
  }
  return null
}
