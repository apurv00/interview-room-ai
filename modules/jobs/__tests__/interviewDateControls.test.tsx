import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import InterviewDateControls from '../components/InterviewDateControls'

describe('InterviewDateControls', () => {
  it('keeps the control open and exposes a failed save', async () => {
    const onCapture = vi.fn().mockRejectedValue(new Error('network'))
    render(<InterviewDateControls onCapture={onCapture} />)

    fireEvent.click(screen.getByRole('button', { name: 'Tomorrow' }))

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save interview timing. Try again.")
    expect(screen.getByRole('button', { name: 'Tomorrow' })).toBeEnabled()
  })

  it('submits only a selected exact calendar date and clears it after success', async () => {
    const onCapture = vi.fn().mockResolvedValue(undefined)
    render(<InterviewDateControls onCapture={onCapture} />)
    const input = screen.getByLabelText('Exact interview date')

    fireEvent.change(input, { target: { value: '2026-07-30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save exact date' }))

    await waitFor(() => expect(onCapture).toHaveBeenCalledWith({ date: '2026-07-30' }))
    await waitFor(() => expect(input).toHaveValue(''))
  })
})
