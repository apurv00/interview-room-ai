import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ApplicationCardPage from '../page'

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>{children}</a>
  ),
}))

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const INVITE_URL =
  'https://hire.interviewprep.guru/candidate/round-1#invite=111111111111111111111111.secret'

function card(deliveryStatus: 'failed' | 'sent', interviewInProgress = false) {
  return {
    application: {
      id: 'app-1',
      jobId: 'job-1',
      stage: 'new',
      decisionNote: null,
      offerDecision: null,
      resumeMatch: null,
      applicantSubmissions: [],
      events: [],
    },
    candidate: {
      id: 'candidate-1',
      name: 'Candidate One',
      email: 'candidate@example.com',
      phone: null,
      resumeText: null,
      resumeFileName: null,
    },
    job: { id: 'job-1', title: 'Platform Engineer', status: 'open' },
    rounds: [{
      id: 'round-1',
      status: 'invited',
      invitedAt: '2026-08-10T12:00:00.000Z',
      inviteExpiresAt: '2026-08-17T12:00:00.000Z',
      consentAt: null,
      linkedAt: null,
      revokedAt: null,
      config: { role: 'Platform Engineer', experience: '3-6', duration: 15 },
      attemptCount: 0,
      results: null,
      assessment: null,
      evidenceIndex: [],
      identityPhoto: null,
      mediaPurged: false,
      inviteDelivery: {
        status: deliveryStatus,
        attempts: deliveryStatus === 'failed' ? 1 : 2,
        expiresAt: '2026-08-17T12:00:00.000Z',
        sentAt: deliveryStatus === 'sent' ? '2026-08-10T12:01:00.000Z' : null,
        lastError: deliveryStatus === 'failed' ? 'Provider did not accept the invitation' : null,
        inviteUrl: INVITE_URL,
        recoverable: true,
      },
    }],
    activity: interviewInProgress ? [{ roundId: 'round-1', inProgress: true }] : [],
  }
}

type CardStage = 'new' | 'screened' | 'offer' | 'hired' | 'rejected' | 'withdrawn'

function cardAtStage(stage: CardStage) {
  const value = card('sent')
  value.application.stage = stage
  return value
}

const STAGE_CONFIRMATION_CASES = [
  { trigger: 'Reject', initialStage: 'new', terminalStage: 'rejected', confirm: 'Confirm decision' },
  { trigger: 'Withdraw', initialStage: 'new', terminalStage: 'withdrawn', confirm: 'Confirm decision' },
  { trigger: 'Offer accepted', initialStage: 'offer', terminalStage: 'hired', confirm: 'Confirm hire' },
  { trigger: 'Offer declined', initialStage: 'offer', terminalStage: 'rejected', confirm: 'Confirm decision' },
] as const

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('AI invitation delivery recovery UI', () => {
  it('renders no falsey numeric text when no resume is on file', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => json(card('sent'))))

    const { container } = render(
      <ApplicationCardPage params={{ appId: 'app-1' }} />,
    )

    await screen.findByRole('region', { name: 'Human review readiness' })
    expect(screen.queryByText('Résumés on file')).not.toBeInTheDocument()

    const textWalker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
    const bareTextNodes: string[] = []
    while (textWalker.nextNode()) {
      const text = textWalker.currentNode.textContent?.trim()
      if (text) bareTextNodes.push(text)
    }
    expect(bareTextNodes).not.toContain('0')
  })

  it('returns to the exact candidate-list state without accepting an external redirect', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => json(card('sent'))))
    const returnTo = '/workspace/jobs/job-1/candidates?view=offers&sort=newest'
    const first = render(
      <ApplicationCardPage params={{ appId: 'app-1' }} searchParams={{ returnTo }} />,
    )
    expect(await screen.findByRole('link', { name: /Back to Platform Engineer candidates/i }))
      .toHaveAttribute('href', returnTo)
    first.unmount()

    const second = render(
      <ApplicationCardPage
        params={{ appId: 'app-1' }}
        searchParams={{ returnTo: 'https://attacker.example/phish' }}
      />,
    )
    expect(await screen.findByRole('link', { name: /Back to Platform Engineer candidates/i }))
      .toHaveAttribute('href', '/workspace/jobs/job-1/candidates')
    second.unmount()

    render(
      <ApplicationCardPage
        params={{ appId: 'app-1' }}
        searchParams={{ returnTo: '/workspace/jobs/job-1/decision?cursor=opaque' }}
      />,
    )
    expect(await screen.findByRole('link', { name: /Back to Platform Engineer workspace/i }))
      .toHaveAttribute('href', '/workspace/jobs/job-1/decision?cursor=opaque')
  })

  it('requires an action-valid structured reason before a destructive decision', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return json({ application: { id: 'app-1', stage: 'rejected' } })
      return json(card('sent'))
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<ApplicationCardPage params={{ appId: 'app-1' }} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }))
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
    const reason = screen.getByLabelText('Structured reason')
    expect(reason).toHaveValue('requirements_mismatch')
    fireEvent.change(reason, { target: { value: 'role_filled' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm decision' }))

    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1))
    const [, request] = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!
    expect(JSON.parse(String(request?.body))).toMatchObject({
      action: 'reject', reasonCode: 'role_filled', expectedFrom: 'new',
    })
  })

  it.each(STAGE_CONFIRMATION_CASES)(
    'returns focus to the $trigger trigger when its confirmation is cancelled',
    async ({ trigger, initialStage }) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(cardAtStage(initialStage))))
      render(<ApplicationCardPage params={{ appId: 'app-1' }} />)

      const actionTrigger = await screen.findByRole('button', { name: trigger })
      actionTrigger.focus()
      fireEvent.click(actionTrigger)

      if (trigger === 'Offer accepted') {
        expect(screen.getByLabelText(/Record why the candidate accepted/i)).toHaveFocus()
      } else {
        expect(screen.getByLabelText('Structured reason')).toHaveFocus()
      }
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

      await waitFor(() => expect(actionTrigger).toHaveFocus())
    },
  )

  it.each(STAGE_CONFIRMATION_CASES)(
    'focuses the stable candidate heading after a successful $trigger action removes its trigger',
    async ({ trigger, initialStage, terminalStage, confirm }) => {
      let currentStage: CardStage = initialStage
      const fetchMock = vi.fn().mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          currentStage = terminalStage
          return json({ application: { id: 'app-1', stage: terminalStage } })
        }
        return json(cardAtStage(currentStage))
      })
      vi.stubGlobal('fetch', fetchMock)
      render(<ApplicationCardPage params={{ appId: 'app-1' }} />)

      const actionTrigger = await screen.findByRole('button', { name: trigger })
      actionTrigger.focus()
      fireEvent.click(actionTrigger)
      if (trigger === 'Offer accepted') {
        fireEvent.change(screen.getByLabelText(/Record why the candidate accepted/i), {
          target: { value: 'Accepted after final compensation review.' },
        })
      }
      fireEvent.click(screen.getByRole('button', { name: confirm }))

      const heading = screen.getByRole('heading', { level: 1, name: 'Candidate One' })
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: trigger })).not.toBeInTheDocument()
        expect(heading).toHaveFocus()
      })
      expect(heading).toHaveAttribute('tabindex', '-1')
    },
  )

  it('keeps focus on Advance after a successful non-terminal stage move', async () => {
    let currentStage: CardStage = 'new'
    const fetchMock = vi.fn().mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        currentStage = 'screened'
        return json({ application: { id: 'app-1', stage: currentStage } })
      }
      return json(cardAtStage(currentStage))
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<ApplicationCardPage params={{ appId: 'app-1' }} />)

    const advance = await screen.findByRole('button', { name: 'Advance' })
    advance.focus()
    fireEvent.click(advance)

    await waitFor(() => expect(screen.getByText('screened')).toBeInTheDocument())
    await waitFor(() => expect(advance).toHaveFocus())
    expect(screen.getByRole('button', { name: 'Advance' })).toBe(advance)
  })

  it('keeps the existing card and action focus when post-decision refresh fails', async () => {
    let detailReads = 0
    const fetchMock = vi.fn().mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return json({ application: { id: 'app-1', stage: 'rejected' } })
      }
      detailReads += 1
      if (detailReads === 1) return json(cardAtStage('new'))
      return json({ error: 'readback unavailable' }, 503)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<ApplicationCardPage params={{ appId: 'app-1' }} />)

    const reject = await screen.findByRole('button', { name: 'Reject' })
    reject.focus()
    fireEvent.click(reject)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm decision' }))

    expect(await screen.findByText(
      'The decision was saved, but the latest candidate details could not be refreshed. Reload this page before another action.',
    )).toBeInTheDocument()
    await waitFor(() => expect(reject).toHaveFocus())
    expect(screen.getByRole('heading', { level: 1, name: 'Candidate One' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Confirm decision' })).not.toBeInTheDocument()
  })

  it('wraps valid maximum-length candidate identity text on narrow detail views', async () => {
    const longName = 'N'.repeat(120)
    const longEmail = `${'e'.repeat(242)}@example.com`
    const longPhone = '9'.repeat(32)
    const value = cardAtStage('new')
    value.candidate = {
      ...value.candidate,
      name: longName,
      email: longEmail,
      phone: longPhone,
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(value)))
    render(<ApplicationCardPage params={{ appId: 'app-1' }} />)

    const heading = await screen.findByRole('heading', { level: 1, name: longName })
    expect(heading).toHaveClass('break-words')
    const contact = heading.nextElementSibling
    expect(contact).toHaveClass('break-words')
    expect(contact?.textContent).toContain(longEmail)
    expect(contact?.textContent).toContain(longPhone)
  })

  it('leads the decision header with human readiness and neutral AI evidence', async () => {
    const base = card('sent')
    const reviewCard = {
      ...base,
      rounds: [
        {
          ...base.rounds[0],
          status: 'completed',
          linkedAt: '2026-08-10T13:00:00.000Z',
          results: {
            overallScore: 82,
            passProbability: 'likely to pass',
            confidenceLevel: 'high',
          },
          assessment: {
            overallScore: 82,
            overallEvidenceIds: [],
            recommendation: 'advance',
            confidence: 'high',
            dimensions: [],
            findings: [],
            questions: [],
          },
          inviteDelivery: null,
        },
      ],
      humanRounds: [
        {
          id: 'human-round-1',
          mode: 'member_room',
          status: 'completed',
          openedAt: '2026-08-10T14:00:00.000Z',
          scorecardSubmittedAt: '2026-08-10T15:00:00.000Z',
          revokedAt: null,
          createdAt: '2026-08-10T14:00:00.000Z',
          scorecard: null,
          delivery: null,
        },
        {
          id: 'human-round-2',
          mode: 'guest_kit',
          status: 'pending_scorecard',
          openedAt: null,
          scorecardSubmittedAt: null,
          revokedAt: null,
          createdAt: '2026-08-10T16:00:00.000Z',
          scorecard: null,
          delivery: null,
        },
      ],
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(reviewCard)))

    render(<ApplicationCardPage params={{ appId: 'app-1' }} />)

    const humanReview = await screen.findByRole('region', {
      name: 'Human review readiness',
    })
    expect(
      within(humanReview).getByText('1 human scorecard submitted · 1 pending'),
    ).toBeInTheDocument()

    const aiEvidence = screen.getByRole('region', { name: 'AI evidence' })
    expect(
      within(aiEvidence).getByText('Assessment score: 82 / 100 · Confidence: high'),
    ).toBeInTheDocument()
    expect(
      within(aiEvidence).getByText(
        'Supporting evidence only; a human makes the hiring decision.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/pass probability/i)).not.toBeInTheDocument()
    expect(screen.queryByText('likely to pass')).not.toBeInTheDocument()
    expect(
      screen.getByText('AI recommendation (supporting evidence only): advance'),
    ).toBeInTheDocument()
    const actions = screen.getByRole('group', { name: 'Candidate actions' })
    expect(actions).toHaveClass(
      'w-full',
      'flex-wrap',
      'xl:w-auto',
      'xl:shrink-0',
    )
    expect(actions.parentElement).toHaveClass('flex-col', 'xl:flex-row')
    expect(humanReview.parentElement?.parentElement).toHaveClass(
      'w-full',
      'xl:flex-1',
    )
    expect(within(actions).getByRole('button', { name: 'Advance' })).toBeInTheDocument()
    expect(within(actions).getByRole('button', { name: 'Reject' })).toBeInTheDocument()
  })

  it('states when every requested human review was revoked', async () => {
    const base = card('sent')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json({
          ...base,
          humanRounds: [
            {
              id: 'human-round-revoked',
              mode: 'member_room',
              status: 'revoked',
              openedAt: null,
              scorecardSubmittedAt: null,
              revokedAt: '2026-08-10T15:00:00.000Z',
              createdAt: '2026-08-10T14:00:00.000Z',
              scorecard: null,
              delivery: null,
            },
          ],
        }),
      ),
    )

    render(<ApplicationCardPage params={{ appId: 'app-1' }} />)

    const humanReview = await screen.findByRole('region', {
      name: 'Human review readiness',
    })
    expect(
      within(humanReview).getByText('1 requested human review was revoked'),
    ).toBeInTheDocument()
    expect(
      within(humanReview).queryByText('No human scorecards requested'),
    ).not.toBeInTheDocument()
  })

  it('programmatically labels the experience selector and required offer note', async () => {
    const newApplication = card('sent')
    newApplication.rounds = []
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(newApplication)))
    const first = render(<ApplicationCardPage params={{ appId: 'app-1' }} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Send AI interview' }))
    expect(
      screen.getByLabelText("Candidate's experience level"),
    ).toHaveAttribute('id', 'hire-candidate-experience')
    first.unmount()

    const offerApplication = card('sent')
    offerApplication.application.stage = 'offer'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(offerApplication)))
    render(<ApplicationCardPage params={{ appId: 'app-1' }} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Offer accepted' }))
    expect(
      screen.getByLabelText(/Record why the candidate accepted/i),
    ).toHaveAttribute('id', 'offer-decision-note')
  })

  it('shows the authenticated recovery link after reload and retries email idempotently', async () => {
    let retried = false
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/workspace/applications/app-1') {
        return json(card(retried ? 'sent' : 'failed'))
      }
      if (url === '/api/workspace/rounds/round-1/invite-delivery') {
        expect(init?.method).toBe('POST')
        retried = true
        return json({
          emailSent: true,
          delivery: card('sent').rounds[0].inviteDelivery,
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    render(<ApplicationCardPage params={{ appId: 'app-1' }} />)

    await screen.findByText('Invitation email failed · copy the link or retry')
    expect(screen.getByText(INVITE_URL)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Copy interview link' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(INVITE_URL))

    fireEvent.click(screen.getByRole('button', { name: 'Retry invitation email' }))
    await screen.findByText('Invitation email sent · recovery link available')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspace/rounds/round-1/invite-delivery',
      { method: 'POST' },
    )
    expect(screen.queryByRole('button', { name: 'Retry invitation email' })).not.toBeInTheDocument()
  })

  it('refreshes until a published interview leaves the in-progress state', async () => {
    vi.useFakeTimers()
    let interviewInProgress = true
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('/api/workspace/applications/app-1')
      return json(card('sent', interviewInProgress))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ApplicationCardPage params={{ appId: 'app-1' }} />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByText('Interview in progress')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    interviewInProgress = false
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
      await Promise.resolve()
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('Interview in progress')).not.toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
