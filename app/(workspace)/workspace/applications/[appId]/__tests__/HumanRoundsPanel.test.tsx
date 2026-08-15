import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import HumanRoundsPanel, { type HumanRoundView } from '../HumanRoundsPanel'

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HumanRoundsPanel', () => {
  it('sends a guest interviewer kit without rendering its possession capability', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => '11111111-1111-4111-8111-111111111111' })
    const onChanged = vi.fn().mockResolvedValue(undefined)
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/workspace/applications/app-1/human-rounds')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({
        mode: 'guest_kit',
        interviewerName: 'Hiring Manager',
        interviewerEmail: 'manager@example.com',
        operationId: '11111111-1111-4111-8111-111111111111',
      })
      return json({
        humanRound: { id: 'round-1' },
        deliveryQueued: true,
        // A deliberately hostile server field must not be rendered even if a
        // regression accidentally puts it in a successful response.
        kitUrl: 'https://hire.example/interview-kit/round-1#kit=secret',
      }, 201)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <HumanRoundsPanel
        applicationId="app-1"
        humanRounds={[]}
        jobIsOpen
        terminal={false}
        onChanged={onChanged}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Send interviewer kit' }))
    fireEvent.change(screen.getByLabelText('Interviewer name'), { target: { value: 'Hiring Manager' } })
    fireEvent.change(screen.getByLabelText('Interviewer email'), { target: { value: 'manager@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send kit' }))

    await screen.findByText('Interview kit queued for delivery. The interviewer can complete it without an account.')
    expect(onChanged).toHaveBeenCalledOnce()
    expect(document.body.textContent).not.toContain('#kit=secret')
  })

  it('submits the exact four-dimension rubric for a member-run round', async () => {
    const onChanged = vi.fn().mockResolvedValue(undefined)
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/workspace/human-rounds/round-1/scorecard')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({
        dimensions: [
          { key: 'role_capability', rating: 3, evidence: 'Role evidence' },
          { key: 'problem_solving', rating: 3, evidence: 'Problem evidence' },
          { key: 'communication', rating: 3, evidence: 'Communication evidence' },
          { key: 'collaboration', rating: 3, evidence: 'Collaboration evidence' },
        ],
        recommendation: 'yes',
        overallComment: 'Proceed based on interview evidence.',
      })
      return json({ humanRound: { id: 'round-1', status: 'completed' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <HumanRoundsPanel
        applicationId="app-1"
        jobIsOpen
        terminal={false}
        onChanged={onChanged}
        humanRounds={[{
          id: 'round-1',
          mode: 'member_room',
          status: 'pending_scorecard',
          openedAt: '2026-08-13T00:00:00.000Z',
          scorecardSubmittedAt: null,
          revokedAt: null,
          createdAt: '2026-08-13T00:00:00.000Z',
        }]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Complete my scorecard' }))
    fireEvent.change(screen.getByLabelText('Role capability evidence'), { target: { value: 'Role evidence' } })
    fireEvent.change(screen.getByLabelText('Problem solving evidence'), { target: { value: 'Problem evidence' } })
    fireEvent.change(screen.getByLabelText('Communication evidence'), { target: { value: 'Communication evidence' } })
    fireEvent.change(screen.getByLabelText('Collaboration evidence'), { target: { value: 'Collaboration evidence' } })
    fireEvent.change(screen.getByLabelText('Overall comment'), { target: { value: 'Proceed based on interview evidence.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit scorecard' }))

    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce())
    expect(screen.getByText('Scorecard submitted. Its evidence now appears as a completed human round.')).toBeInTheDocument()
  })

  it('renders completed scorecard evidence without merging it into AI evidence', () => {
    const completedRound: HumanRoundView = {
      id: 'round-2',
      mode: 'guest_kit',
      status: 'completed',
      openedAt: '2026-08-13T00:00:00.000Z',
      scorecardSubmittedAt: '2026-08-13T01:00:00.000Z',
      revokedAt: null,
      createdAt: '2026-08-13T00:00:00.000Z',
      scorecard: {
        reviewerKind: 'kit',
        reviewerName: 'Guest interviewer',
        dimensions: [
          { key: 'role_capability', rating: 5, evidence: 'Mapped the role requirements to relevant production experience.' },
          { key: 'problem_solving', rating: 4, evidence: 'Decomposed the incident and explained the trade-offs.' },
          { key: 'communication', rating: 5, evidence: 'Explained assumptions clearly to non-specialists.' },
          { key: 'collaboration', rating: 4, evidence: 'Gave a specific cross-functional collaboration example.' },
        ],
        recommendation: 'strong_yes',
        overallComment: 'Strong evidence for advancing this candidate.',
        submittedAt: '2026-08-13T01:00:00.000Z',
      },
      delivery: {
        initial: { status: 'sent', attempts: 1, sentAt: '2026-08-13T00:01:00.000Z', terminalFailure: false },
        reminder: { status: 'sent', sentAt: '2026-08-14T00:01:00.000Z' },
      },
    }

    render(
      <HumanRoundsPanel
        applicationId="app-1"
        humanRounds={[completedRound]}
        jobIsOpen={false}
        terminal={false}
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Submitted scorecard' })).toBeInTheDocument()
    expect(screen.getByText('Role capability · 5 / 5')).toBeInTheDocument()
    expect(screen.getByText('Strong evidence for advancing this candidate.')).toBeInTheDocument()
    expect(screen.getByText('Strong yes')).toBeInTheDocument()
    expect(screen.getByText(/Interview kit email sent/)).toBeInTheDocument()
    expect(screen.getByText(/One scorecard reminder emailed/)).toBeInTheDocument()
    expect(screen.queryByText(/^AI \d+/)).not.toBeInTheDocument()
  })

  it('shows a terminal kit-delivery recovery state without exposing recipient or capability data', () => {
    const terminalFailureRound = {
      id: 'round-3',
      mode: 'guest_kit',
      status: 'pending_scorecard',
      openedAt: null,
      scorecardSubmittedAt: null,
      revokedAt: null,
      createdAt: '2026-08-13T00:00:00.000Z',
      scorecard: null,
      delivery: {
        initial: {
          status: 'failed',
          attempts: 5,
          sentAt: null,
          terminalFailure: true,
          // Simulate a hostile/over-broad API response. This member UI must
          // never spread delivery records or surface an interviewer contact,
          // provider detail, or a capability link.
          recipientEmail: 'manager@example.com',
          lastError: 'Provider-specific error that must stay server-side',
          kitUrl: 'https://hire.example/interview-kit/round-3#kit=secret-capability',
        },
        reminder: null,
      },
    } as unknown as HumanRoundView

    render(
      <HumanRoundsPanel
        applicationId="app-1"
        humanRounds={[terminalFailureRound]}
        jobIsOpen
        terminal={false}
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Interview kit delivery stopped after 5 attempts.')
    expect(screen.getByRole('alert')).toHaveTextContent('create a new interviewer kit')
    expect(document.body.textContent).not.toContain('manager@example.com')
    expect(document.body.textContent).not.toContain('Provider-specific error')
    expect(document.body.textContent).not.toContain('secret-capability')
  })
})
