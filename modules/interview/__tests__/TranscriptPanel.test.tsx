import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import TranscriptPanel from '@interview/components/interview/TranscriptPanel'
import type { Duration, InterviewState } from '@shared/types'
import type { QuestionDisplay } from '@interview/utils/questionDisplay'

function renderPanel(questionDisplay: QuestionDisplay, phase: InterviewState = 'ASK_QUESTION') {
  return render(
    <TranscriptPanel
      phase={phase}
      questionDisplay={questionDisplay}
      duration={20 as Duration}
      currentQuestion="Can you walk me through an example?"
      liveAnswer=""
    />,
  )
}

describe('TranscriptPanel question display', () => {
  it('renders main question labels without total-count suffixes', () => {
    renderPanel({ kind: 'question', number: 3, progressIndex: 3 })

    expect(screen.getByText('Question 3')).toBeTruthy()
    expect(screen.queryByText(/of\s+\d+/i)).toBeNull()
  })

  it('renders follow-up labels from questionDisplay', () => {
    renderPanel({ kind: 'follow_up', number: 2, parentNumber: 3, progressIndex: 3 }, 'LISTENING')

    expect(screen.getByText('Follow-up 2')).toBeTruthy()
    expect(screen.queryByText(/Question 13 of 11/i)).toBeNull()
  })

  it('renders wrap-up while listening', () => {
    renderPanel({ kind: 'wrap_up' }, 'LISTENING')

    expect(screen.getByText('Wrap-up')).toBeTruthy()
    expect(screen.getByText(/Listening/i)).toBeTruthy()
  })

  it('renders the intro state separately', () => {
    renderPanel({ kind: 'intro' }, 'INTERVIEW_START')

    expect(screen.getByText('Introduction')).toBeTruthy()
    expect(screen.queryByText(/Question/i)).toBeNull()
  })

  it('keeps inflated internal indexes out of the UI', () => {
    renderPanel({ kind: 'follow_up', number: 2, parentNumber: 11, progressIndex: 13 }, 'LISTENING')

    expect(screen.getByText('Follow-up 2')).toBeTruthy()
    expect(screen.queryByText(/13 of 11/i)).toBeNull()
  })
})
