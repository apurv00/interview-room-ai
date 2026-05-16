import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import TextWithQuestionChips from '../TextWithQuestionChips'

describe('TextWithQuestionChips', () => {
  it('renders plain text when no Q-tokens exist', () => {
    render(<TextWithQuestionChips text="Just keep practicing." />)
    expect(screen.getByText('Just keep practicing.')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('splits text into segments and renders chips for Q-tokens', () => {
    const handler = vi.fn()
    render(<TextWithQuestionChips text="In Q3 you said something." onQuestionClick={handler} />)
    expect(screen.getByRole('button', { name: /Jump to Q3/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button'))
    expect(handler).toHaveBeenCalledWith(2)
  })

  it('renders multiple chips in document order', () => {
    render(<TextWithQuestionChips text="In Q1 and Q4 you..." onQuestionClick={() => {}} />)
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(2)
    expect(buttons[0]).toHaveTextContent('Q1')
    expect(buttons[1]).toHaveTextContent('Q4')
  })

  it('renders a single chip for a range token preserving raw text', () => {
    render(<TextWithQuestionChips text="Q3-Q5 weakness" onQuestionClick={() => {}} />)
    const button = screen.getByRole('button')
    expect(button).toHaveTextContent('Q3-Q5')
  })

  it('honors maxQuestionIndex by degrading out-of-range chips to plain text', () => {
    render(
      <TextWithQuestionChips
        text="In Q3 and Q11 ..."
        onQuestionClick={() => {}}
        maxQuestionIndex={4}
      />
    )
    // Q3 in range → button; Q11 out of range → plain text
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toHaveTextContent('Q3')
    expect(screen.getByText('Q11')).toBeInTheDocument()
  })
})
