import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import ClarificationsPanel from '../components/interview/ClarificationsPanel'
import type { CodingClarificationRecord } from '../validators/clarifyCoding'

describe('ClarificationsPanel', () => {
  it('renders existing clarifications including added examples and constraints', () => {
    const clarifications: CodingClarificationRecord[] = [
      {
        problemId: 'two-sum',
        question: 'Can the array contain duplicates?',
        answer: 'Yes — the input may contain duplicate values, but each index is used at most once.',
        addedExamples: [
          { input: 'nums = [3,3], target = 6', output: '[0,1]', explanation: 'Same value, different indices' },
        ],
        addedConstraints: ['Indices in the result are zero-based'],
        createdAt: new Date().toISOString(),
      },
    ]
    render(<ClarificationsPanel clarifications={clarifications} onAsk={vi.fn()} />)
    expect(screen.getByText(/Can the array contain duplicates\?/)).toBeTruthy()
    expect(screen.getByText(/each index is used at most once/)).toBeTruthy()
    expect(screen.getByText(/nums = \[3,3\], target = 6/)).toBeTruthy()
    expect(screen.getByText(/Indices in the result are zero-based/)).toBeTruthy()
  })

  it('calls onAsk with the typed question and clears the input on success', async () => {
    const onAsk = vi.fn().mockResolvedValue(undefined)
    render(<ClarificationsPanel clarifications={[]} onAsk={onAsk} />)

    const textarea = screen.getByPlaceholderText(/Ask the interviewer to clarify/i)
    fireEvent.change(textarea, { target: { value: 'Are negative numbers allowed?' } })
    fireEvent.click(screen.getByRole('button', { name: /ask the interviewer/i }))

    await waitFor(() => expect(onAsk).toHaveBeenCalledWith('Are negative numbers allowed?'))
    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe(''))
  })

  it('surfaces an error message when onAsk rejects', async () => {
    const onAsk = vi.fn().mockRejectedValue(new Error('Rate limit exceeded'))
    render(<ClarificationsPanel clarifications={[]} onAsk={onAsk} />)

    fireEvent.change(screen.getByPlaceholderText(/Ask the interviewer/i), {
      target: { value: 'What about empty input?' },
    })
    fireEvent.click(screen.getByRole('button', { name: /ask the interviewer/i }))

    await waitFor(() => expect(screen.getByText(/Rate limit exceeded/)).toBeTruthy())
  })

  it('does nothing when the input is empty', () => {
    const onAsk = vi.fn()
    render(<ClarificationsPanel clarifications={[]} onAsk={onAsk} />)
    const button = screen.getByRole('button', { name: /ask the interviewer/i })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(button)
    expect(onAsk).not.toHaveBeenCalled()
  })
})
