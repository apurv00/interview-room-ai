import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import InterviewKitEntry from '../InterviewKitEntry'

const KIT_ID = 'a'.repeat(24)
const WORKSPACE_ID = '1'.repeat(24)
const CAPABILITY = `${WORKSPACE_ID}.${KIT_ID}.${'bc'.repeat(32)}`
const STORAGE_KEY = `hire:interview-kit:v1:${KIT_ID}`

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function activeKit() {
  return {
    state: 'ok',
    workspaceName: 'Example Co',
    jobTitle: 'Senior Full-Stack Engineer',
    interviewerName: 'Jordan',
    brief: {
      candidateName: 'Ada Lovelace',
      experienceYears: 5,
      location: 'Bengaluru',
    },
  }
}

beforeEach(() => {
  window.sessionStorage.clear()
  window.history.replaceState({}, '', `/interview-kit/${KIT_ID}`)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('InterviewKitEntry', () => {
  it('stores a valid fragment, scrubs browser history, and opens with no cookies', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(activeKit()))
    vi.stubGlobal('fetch', fetchMock)
    window.history.replaceState(
      {},
      '',
      `/interview-kit/${KIT_ID}#kit=${encodeURIComponent(CAPABILITY)}`,
    )

    render(<InterviewKitEntry kitId={KIT_ID} />)

    expect(await screen.findByRole('heading', { name: 'Senior Full-Stack Engineer' })).toBeTruthy()
    expect(screen.getByText('Ada Lovelace')).toBeTruthy()
    expect(window.location.hash).toBe('')
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe(CAPABILITY)
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/interview-kit/${KIT_ID}/bootstrap`,
      expect.objectContaining({
        method: 'POST',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        body: JSON.stringify({ capability: CAPABILITY }),
      }),
    )
  })

  it('recovers the capability from tab-scoped storage after the fragment is scrubbed', async () => {
    window.sessionStorage.setItem(STORAGE_KEY, CAPABILITY)
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(activeKit()))
    vi.stubGlobal('fetch', fetchMock)

    render(<InterviewKitEntry kitId={KIT_ID} />)

    expect(await screen.findByText('Interview brief')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/interview-kit/${KIT_ID}/bootstrap`,
      expect.objectContaining({ body: JSON.stringify({ capability: CAPABILITY }) }),
    )
  })

  it('does not persist or submit a malformed or mismatched fragment', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const differentKit = 'b'.repeat(24)
    const mismatched = `${WORKSPACE_ID}.${differentKit}.${'bc'.repeat(32)}`
    window.history.replaceState(
      {},
      '',
      `/interview-kit/${KIT_ID}#kit=${encodeURIComponent(mismatched)}`,
    )

    render(<InterviewKitEntry kitId={KIT_ID} />)

    expect(
      await screen.findByRole('heading', { name: 'This interview kit link is no longer active' }),
    ).toBeTruthy()
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('submits exactly the fixed scorecard through the no-cookie endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(activeKit()))
      .mockResolvedValueOnce(jsonResponse({ state: 'submitted' }))
    vi.stubGlobal('fetch', fetchMock)
    window.history.replaceState(
      {},
      '',
      `/interview-kit/${KIT_ID}#kit=${encodeURIComponent(CAPABILITY)}`,
    )

    render(<InterviewKitEntry kitId={KIT_ID} />)
    await screen.findByText('Scorecard')

    for (const select of screen.getAllByLabelText('Rating')) {
      fireEvent.change(select, { target: { value: '4' } })
    }
    for (const textarea of screen.getAllByLabelText('Evidence')) {
      fireEvent.change(textarea, { target: { value: 'Clear, specific example.' } })
    }
    fireEvent.change(screen.getByLabelText('Recommendation'), { target: { value: 'yes' } })
    fireEvent.change(screen.getByLabelText('Overall feedback'), {
      target: { value: 'Strong practical evidence and thoughtful communication.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Submit scorecard' }))

    expect(await screen.findByRole('heading', { name: 'Scorecard submitted' })).toBeTruthy()
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/interview-kit/${KIT_ID}/scorecard`,
      expect.objectContaining({
        method: 'POST',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        body: JSON.stringify({
          capability: CAPABILITY,
          dimensions: [
            { key: 'role_capability', rating: 4, evidence: 'Clear, specific example.' },
            { key: 'problem_solving', rating: 4, evidence: 'Clear, specific example.' },
            { key: 'communication', rating: 4, evidence: 'Clear, specific example.' },
            { key: 'collaboration', rating: 4, evidence: 'Clear, specific example.' },
          ],
          recommendation: 'yes',
          overallComment: 'Strong practical evidence and thoughtful communication.',
        }),
      }),
    )
  })

  it('uses one indistinguishable inactive state for a dead kit response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'inactive' }, 410))
    vi.stubGlobal('fetch', fetchMock)
    window.history.replaceState(
      {},
      '',
      `/interview-kit/${KIT_ID}#kit=${encodeURIComponent(CAPABILITY)}`,
    )

    render(<InterviewKitEntry kitId={KIT_ID} />)

    expect(
      await screen.findByRole('heading', { name: 'This interview kit link is no longer active' }),
    ).toBeTruthy()
  })
})
