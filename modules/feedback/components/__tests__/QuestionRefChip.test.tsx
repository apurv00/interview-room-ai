import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import QuestionRefChip from '../QuestionRefChip'

describe('QuestionRefChip', () => {
  it('renders Q{n+1} from a 0-based questionIndex', () => {
    render(<QuestionRefChip questionIndex={2} />)
    expect(screen.getByText('Q3')).toBeInTheDocument()
  })

  it('renders a range label when rangeEndIndex is present', () => {
    render(<QuestionRefChip questionIndex={2} rangeEndIndex={4} />)
    expect(screen.getByText('Q3–Q5')).toBeInTheDocument()
  })

  it('prefers rawLabel over computed label', () => {
    render(<QuestionRefChip questionIndex={2} rawLabel="Q3-Q5" />)
    expect(screen.getByText('Q3-Q5')).toBeInTheDocument()
  })

  it('renders as a button and calls onClick with the questionIndex', () => {
    const handler = vi.fn()
    render(<QuestionRefChip questionIndex={4} onClick={handler} />)
    fireEvent.click(screen.getByRole('button', { name: /Jump to Q5/i }))
    expect(handler).toHaveBeenCalledWith(4)
  })

  it('renders inert (no button) when onClick is not provided', () => {
    render(<QuestionRefChip questionIndex={0} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('Q1')).toBeInTheDocument()
  })

  it('degrades to plain text when questionIndex is out of range', () => {
    const handler = vi.fn()
    // Session only had 5 questions (max index = 4); chip is for Q11
    render(<QuestionRefChip questionIndex={10} maxQuestionIndex={4} onClick={handler} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('Q11')).toBeInTheDocument()
  })

  it('stops event propagation so chips inside larger clickable surfaces do not trigger parent', () => {
    const parentHandler = vi.fn()
    const chipHandler = vi.fn()
    render(
      <div onClick={parentHandler}>
        <QuestionRefChip questionIndex={1} onClick={chipHandler} />
      </div>
    )
    fireEvent.click(screen.getByRole('button'))
    expect(chipHandler).toHaveBeenCalledWith(1)
    expect(parentHandler).not.toHaveBeenCalled()
  })
})
