import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import ModelConfigPage from '../page'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ModelConfigPage', () => {
  it('preserves the code-owned provider when an operator enables a Jobs override', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      config: { routingEnabled: false, slots: [] },
      taskSlots: ['jobs.evaluate-posting'],
      defaults: {
        'jobs.evaluate-posting': {
          model: 'gpt-5.6-luna',
          provider: 'openai',
          maxTokens: 800,
        },
      },
      providers: [
        { name: 'anthropic', label: 'Anthropic', configured: true },
        { name: 'openai', label: 'OpenAI', configured: true },
      ],
    }))
    vi.stubGlobal('fetch', fetchMock)

    render(<ModelConfigPage />)

    expect(await screen.findByText('evaluate posting')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Override' }))

    expect(screen.getAllByRole('combobox')[0]).toHaveValue('openai')
    expect(screen.getByText(/each task uses its code-owned default/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Save Config' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const request = fetchMock.mock.calls[1][1] as RequestInit
    expect(JSON.parse(String(request.body))).toEqual({
      routingEnabled: false,
      slots: [{
        taskSlot: 'jobs.evaluate-posting',
        model: 'gpt-5.6-luna',
        provider: 'openai',
        maxTokens: 800,
        isActive: true,
        useToonInput: false,
      }],
    })
  })
})
