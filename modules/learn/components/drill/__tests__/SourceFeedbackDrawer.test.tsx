import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import SourceFeedbackDrawer from '../SourceFeedbackDrawer'

// structure=20 is the weakest slot, so the bar for that slot is easy to find by label.
const scores = { relevance: 50, structure: 20, specificity: 50, ownership: 50 }
const base = {
  open: true,
  onClose: vi.fn(),
  sessionId: 's1',
  question: 'q',
  originalAnswer: 'my answer',
  scores,
}

describe('SourceFeedbackDrawer — domain-aware bar labels (per-row)', () => {
  it('coding: shows the "Code Quality" bar label', () => {
    render(<SourceFeedbackDrawer {...base} interviewType="coding" questionIndex={3} />)
    expect(screen.getByText('Code Quality')).toBeInTheDocument()
    expect(screen.queryByText('Structure (STAR)')).not.toBeInTheDocument()
  })

  it('academics warm-up (Q0): behavioral "Structure (STAR)", NOT the academic label', () => {
    render(<SourceFeedbackDrawer {...base} interviewType="academics" questionIndex={0} />)
    expect(screen.getByText('Structure (STAR)')).toBeInTheDocument()
    expect(screen.queryByText('Conceptual Depth')).not.toBeInTheDocument()
  })

  it('academics real probe (Q2): academic "Conceptual Depth" label', () => {
    render(<SourceFeedbackDrawer {...base} interviewType="academics" questionIndex={2} />)
    expect(screen.getByText('Conceptual Depth')).toBeInTheDocument()
    expect(screen.queryByText('Structure (STAR)')).not.toBeInTheDocument()
  })
})
