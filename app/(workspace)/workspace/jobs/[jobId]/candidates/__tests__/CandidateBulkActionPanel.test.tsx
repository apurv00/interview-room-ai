import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CandidateBulkActionPanel from '../CandidateBulkActionPanel'

const JOB_ID = '111111111111111111111111'
const OPERATION_ID = '222222222222222222222222'
const SELECTION_ID = '333333333333333333333333'

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

const operation = {
  operationId: OPERATION_ID,
  action: 'reject',
  status: 'partial',
  totalCount: 75,
  queuedCount: 0,
  processingCount: 0,
  succeededCount: 70,
  conflictCount: 4,
  failedCount: 1,
}

describe('CandidateBulkActionPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('crypto', { randomUUID: () => '11111111-1111-4111-8111-111111111111' })
  })

  it('confirms an exact server snapshot, persists the operation, and pages controlled issues', async () => {
    const accepted = vi.fn()
    const settled = vi.fn()
    const finish = vi.fn()
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'POST') return Promise.resolve(json({ operation }, 202))
      if (url.includes('cursor=next-issue')) return Promise.resolve(json({
        operation,
        issues: { items: [{ itemId: 'issue-two', applicationId: '555555555555555555555555', status: 'failed', code: 'CANDIDATE_UNAVAILABLE' }], nextCursor: null },
      }))
      return Promise.resolve(json({
        operation,
        issues: { items: [{ itemId: 'issue-one', applicationId: '444444444444444444444444', status: 'conflict', code: 'STAGE_CHANGED' }], nextCursor: 'next-issue' },
      }))
    }))

    render(
      <CandidateBulkActionPanel
        jobId={JOB_ID}
        selection={{ selectionId: SELECTION_ID, count: 75, expiresAt: '2026-08-25T09:00:00.000Z', description: '75 matches', homogeneousStage: 'new' }}
        expectedStage="new"
        returnTo={`/workspace/jobs/${JOB_ID}/candidates?view=all`}
        onOperationAccepted={accepted}
        onFinish={finish}
        onSettled={settled}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reject selected…' }))
    fireEvent.change(screen.getByLabelText('Structured reason'), { target: { value: 'requirements_mismatch' } })
    fireEvent.click(screen.getByText(/I confirm this exact 75-candidate snapshot/))
    fireEvent.click(screen.getByRole('button', { name: 'Start durable operation' }))

    await waitFor(() => expect(accepted).toHaveBeenCalledWith(OPERATION_ID))
    const post = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'POST')
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
      selectionId: SELECTION_ID,
      action: 'reject',
      reasonCode: 'requirements_mismatch',
      communication: 'none',
      confirmed: true,
      confirmedCount: 75,
    })
    expect(JSON.parse(String(post?.[1]?.body))).not.toHaveProperty('note')
    expect(await screen.findByText('Bulk reject · partial')).toBeTruthy()
    fireEvent.click(screen.getByText('Review conflicts and failures'))
    fireEvent.click(await screen.findByRole('button', { name: 'Next issues' }))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('cursor=next-issue'))).toBe(true))
    expect(await screen.findByText(/candidate unavailable/)).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Review bulk issue for application 444444444444444444444444' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Review bulk issue for application 555555555555555555555555' })).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Issue page 2' })).toHaveFocus())

    fireEvent.click(screen.getByRole('button', { name: 'Previous issues' }))
    const firstIssue = await screen.findByRole('link', { name: 'Review bulk issue for application 444444444444444444444444' })
    expect(firstIssue).toHaveAttribute(
      'href',
      expect.stringContaining(`returnTo=%2Fworkspace%2Fjobs%2F${JOB_ID}%2Fcandidates%3Fview%3Dall`),
    )
    expect(screen.queryByRole('link', { name: 'Review bulk issue for application 555555555555555555555555' })).toBeNull()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Issue page 1' })).toHaveFocus())
    expect(settled).toHaveBeenCalledTimes(1)
    expect(screen.getByText('75 of 75 processed; 70 succeeded; 4 conflicts; 1 failures.')).toHaveClass('sr-only')
    fireEvent.click(screen.getByRole('button', { name: 'Finish and choose candidates again' }))
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it('posts the only valid structured withdrawal reason and never sends free text', async () => {
    const withdrawnOperation = { ...operation, action: 'withdraw', status: 'queued' }
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve(json({ operation: withdrawnOperation }, 202))
      return Promise.resolve(json({ operation: withdrawnOperation, issues: { items: [], nextCursor: null } }))
    }))

    render(
      <CandidateBulkActionPanel
        jobId={JOB_ID}
        selection={{ selectionId: SELECTION_ID, count: 2, expiresAt: '2026-08-25T09:00:00.000Z', description: 'Two candidates', homogeneousStage: 'new' }}
        expectedStage="new"
        onFinish={vi.fn()}
        onSettled={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Mark withdrawn…' }))
    fireEvent.change(screen.getByLabelText('Structured reason'), { target: { value: 'candidate_withdrew' } })
    fireEvent.click(screen.getByText(/I confirm this exact 2-candidate snapshot/))
    fireEvent.click(screen.getByRole('button', { name: 'Start durable operation' }))

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true))
    const post = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'POST')
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
      action: 'withdraw',
      reasonCode: 'candidate_withdrew',
      communication: 'none',
    })
    expect(JSON.parse(String(post?.[1]?.body))).not.toHaveProperty('note')
  })

  it('hides start controls while a durable operation is recovering, then renders the recovered status', async () => {
    let resolveRecovery!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveRecovery = resolve })))

    render(
      <CandidateBulkActionPanel
        jobId={JOB_ID}
        selection={{ selectionId: SELECTION_ID, count: 2, expiresAt: '2026-08-25T09:00:00.000Z', description: 'Two candidates', homogeneousStage: 'new' }}
        expectedStage="new"
        initialOperationId={OPERATION_ID}
        onFinish={vi.fn()}
        onSettled={vi.fn()}
      />,
    )

    expect(screen.getByRole('status')).toHaveTextContent('Recovering durable operation status')
    expect(screen.queryByRole('button', { name: 'Reject selected…' })).toBeNull()
    resolveRecovery(json({ operation: { ...operation, status: 'completed' }, issues: { items: [], nextCursor: null } }))
    expect(await screen.findByText('Bulk reject · completed')).toBeTruthy()
    expect(screen.queryByText('Recovering durable operation status…')).toBeNull()
  })

  it.each([
    ['404', () => Promise.resolve(json({ error: 'Operation not found' }, 404)), /Operation not found/],
    ['503', () => Promise.resolve(json({ error: 'Status temporarily unavailable' }, 503)), /Status temporarily unavailable/],
    ['network', () => Promise.reject(new Error('offline')), /network error prevented recovery/i],
    ['malformed', () => Promise.resolve(json({ operation: { operationId: OPERATION_ID } })), /incomplete or did not match/i],
  ])('fails loudly for %s recovery and preserves the durable coordinate', async (_case, responseFactory, message) => {
    vi.stubGlobal('fetch', vi.fn(responseFactory))
    render(
      <CandidateBulkActionPanel
        jobId={JOB_ID}
        selection={{ selectionId: SELECTION_ID, count: 2, expiresAt: '2026-08-25T09:00:00.000Z', description: 'Two candidates', homogeneousStage: 'new' }}
        expectedStage="new"
        initialOperationId={OPERATION_ID}
        onFinish={vi.fn()}
        onSettled={vi.fn()}
      />,
    )

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(message)
    expect(screen.getByLabelText('Durable operation ID')).toHaveValue(OPERATION_ID)
    expect(screen.getByRole('button', { name: 'Retry recovery' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy operation ID' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Reject selected…' })).toBeNull()
  })

  it('retries a failed recovery and does not create a polling loop when status objects are replaced', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(() => {
      calls += 1
      if (calls === 1) return Promise.resolve(json({ error: 'Temporarily unavailable' }, 503))
      return Promise.resolve(json({ operation: { ...operation, status: 'processing' }, issues: { items: [], nextCursor: null } }))
    }))
    render(
      <CandidateBulkActionPanel
        jobId={JOB_ID}
        selection={{ selectionId: SELECTION_ID, count: 75, expiresAt: '2026-08-25T09:00:00.000Z', description: '75 candidates', homogeneousStage: 'new' }}
        expectedStage="new"
        initialOperationId={OPERATION_ID}
        onFinish={vi.fn()}
        onSettled={vi.fn()}
      />,
    )

    await screen.findByText(/Temporarily unavailable/)
    fireEvent.click(screen.getByRole('button', { name: 'Retry recovery' }))
    expect(await screen.findByText('Bulk reject · processing')).toBeTruthy()
    await waitFor(() => expect(calls).toBe(3))
  })

  it('offers only action-valid structured reasons and restores focus when confirmation is cancelled', async () => {
    vi.stubGlobal('fetch', vi.fn())
    render(
      <CandidateBulkActionPanel
        jobId={JOB_ID}
        selection={{ selectionId: SELECTION_ID, count: 2, expiresAt: '2026-08-25T09:00:00.000Z', description: 'Two candidates', homogeneousStage: 'new' }}
        expectedStage="new"
        onFinish={vi.fn()}
        onSettled={vi.fn()}
      />,
    )

    const withdraw = screen.getByRole('button', { name: 'Mark withdrawn…' })
    fireEvent.click(withdraw)
    expect(screen.getByRole('option', { name: 'Candidate withdrew' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Requirements mismatch' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(withdraw).toHaveFocus())

    fireEvent.click(screen.getByRole('button', { name: 'Reject selected…' }))
    expect(screen.getByRole('option', { name: 'Requirements mismatch' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Candidate withdrew' })).toBeNull()
  })

  it('defensively mounts at most 50 issues when an endpoint over-delivers 1,000 rows', async () => {
    const oversizedIssues = Array.from({ length: 1_000 }, (_, index) => ({
      itemId: `issue-${index}`,
      applicationId: (index + 1).toString(16).padStart(24, '0'),
      status: 'conflict',
      code: 'STAGE_CHANGED',
    }))
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({
      operation: {
        ...operation,
        status: 'completed',
        totalCount: 1_000,
        succeededCount: 0,
        conflictCount: 1_000,
        failedCount: 0,
      },
      issues: { items: oversizedIssues, nextCursor: null },
    }))))

    render(
      <CandidateBulkActionPanel
        jobId={JOB_ID}
        selection={null}
        expectedStage={null}
        initialOperationId={OPERATION_ID}
        onFinish={vi.fn()}
        onSettled={vi.fn()}
      />,
    )

    expect(await screen.findByText('50 shown on this page · at most 50 issues are mounted at once')).toBeTruthy()
    expect(screen.getAllByRole('link', { name: /Review bulk issue for application/ })).toHaveLength(50)
    expect(screen.queryByRole('link', { name: 'Review bulk issue for application 000000000000000000000033' })).toBeNull()
  })

  it('ignores a superseded operation response when the durable coordinate changes', async () => {
    const replacementOperationId = '666666666666666666666666'
    let resolveOld!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes(OPERATION_ID)) {
        return new Promise<Response>((resolve) => { resolveOld = resolve })
      }
      return Promise.resolve(json({
        operation: { ...operation, operationId: replacementOperationId, status: 'completed' },
        issues: {
          items: [{ itemId: 'replacement', applicationId: '777777777777777777777777', status: 'conflict', code: 'STAGE_CHANGED' }],
          nextCursor: null,
        },
      }))
    }))

    const props = {
      jobId: JOB_ID,
      selection: null,
      expectedStage: null,
      onFinish: vi.fn(),
      onSettled: vi.fn(),
    }
    const { rerender } = render(<CandidateBulkActionPanel {...props} initialOperationId={OPERATION_ID} />)
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1))
    rerender(<CandidateBulkActionPanel {...props} initialOperationId={replacementOperationId} />)

    expect(await screen.findByRole('link', { name: 'Review bulk issue for application 777777777777777777777777' })).toBeTruthy()
    resolveOld(json({ error: 'A stale operation failed to load.' }, 503))
    await Promise.resolve()

    expect(screen.queryByText('A stale operation failed to load.')).toBeNull()
    expect(screen.getByText(`Bulk reject · completed`)).toBeTruthy()
  })

  it('cannot restore an old queued operation after a replacement recovery takes ownership', async () => {
    const replacementOperationId = '666666666666666666666666'
    let oldOperationCalls = 0
    let resolveOldPoll!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes(OPERATION_ID)) {
        oldOperationCalls += 1
        if (oldOperationCalls === 1) {
          return Promise.resolve(json({
            operation: { ...operation, status: 'queued' },
            issues: { items: [], nextCursor: null },
          }))
        }
        return new Promise<Response>((resolve) => { resolveOldPoll = resolve })
      }
      return Promise.resolve(json({
        operation: { ...operation, operationId: replacementOperationId, status: 'completed' },
        issues: {
          items: [{ itemId: 'replacement', applicationId: '777777777777777777777777', status: 'conflict', code: 'STAGE_CHANGED' }],
          nextCursor: null,
        },
      }))
    }))

    const props = {
      jobId: JOB_ID,
      selection: null,
      expectedStage: null,
      onFinish: vi.fn(),
      onSettled: vi.fn(),
    }
    const view = render(<CandidateBulkActionPanel {...props} initialOperationId={OPERATION_ID} />)
    expect(await screen.findByText('Bulk reject · queued')).toBeTruthy()
    await waitFor(() => expect(oldOperationCalls).toBe(2))

    view.rerender(<CandidateBulkActionPanel {...props} initialOperationId={replacementOperationId} />)
    expect(await screen.findByText('Bulk reject · completed')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Review bulk issue for application 777777777777777777777777' })).toBeTruthy()

    resolveOldPoll(json({
      operation: { ...operation, status: 'processing' },
      issues: {
        items: [{ itemId: 'old', applicationId: '999999999999999999999999', status: 'failed', code: 'CANDIDATE_UNAVAILABLE' }],
        nextCursor: null,
      },
    }))
    await Promise.resolve()
    await Promise.resolve()

    expect(screen.getByText('Bulk reject · completed')).toBeTruthy()
    expect(screen.queryByText('Bulk reject · processing')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Review bulk issue for application 999999999999999999999999' })).toBeNull()
  })

  it('keeps a newer issue navigation locked when an older navigation settles', async () => {
    const replacementOperationId = '666666666666666666666666'
    let resolveOldPage!: (response: Response) => void
    let resolveNewPage!: (response: Response) => void
    const oldPage = new Promise<Response>((resolve) => { resolveOldPage = resolve })
    const newPage = new Promise<Response>((resolve) => { resolveNewPage = resolve })
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes(OPERATION_ID)) {
        if (url.includes('cursor=old-next')) return oldPage
        return Promise.resolve(json({
          operation: { ...operation, status: 'completed' },
          issues: {
            items: [{ itemId: 'old-one', applicationId: '777777777777777777777777', status: 'conflict', code: 'STAGE_CHANGED' }],
            nextCursor: 'old-next',
          },
        }))
      }
      if (url.includes('cursor=new-next')) return newPage
      return Promise.resolve(json({
        operation: { ...operation, operationId: replacementOperationId, status: 'completed' },
        issues: {
          items: [{ itemId: 'new-one', applicationId: '888888888888888888888888', status: 'conflict', code: 'STAGE_CHANGED' }],
          nextCursor: 'new-next',
        },
      }))
    }))

    const props = {
      jobId: JOB_ID,
      selection: null,
      expectedStage: null,
      onFinish: vi.fn(),
      onSettled: vi.fn(),
    }
    const view = render(<CandidateBulkActionPanel {...props} initialOperationId={OPERATION_ID} />)
    expect(await screen.findByRole('link', { name: 'Review bulk issue for application 777777777777777777777777' })).toBeTruthy()
    fireEvent.click(screen.getByText('Review conflicts and failures'))
    fireEvent.click(screen.getByRole('button', { name: 'Next issues' }))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('cursor=old-next'))).toBe(true))

    view.rerender(<CandidateBulkActionPanel {...props} initialOperationId={replacementOperationId} />)
    expect(await screen.findByRole('link', { name: 'Review bulk issue for application 888888888888888888888888' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next issues' }))
    const nextButton = screen.getByRole('button', { name: 'Next issues' })
    expect(nextButton).toBeDisabled()

    resolveOldPage(json({
      operation: { ...operation, status: 'completed' },
      issues: {
        items: [{ itemId: 'old-two', applicationId: '999999999999999999999999', status: 'failed', code: 'CANDIDATE_UNAVAILABLE' }],
        nextCursor: null,
      },
    }))
    await Promise.resolve()
    expect(nextButton).toBeDisabled()
    expect(screen.queryByRole('link', { name: 'Review bulk issue for application 999999999999999999999999' })).toBeNull()

    resolveNewPage(json({
      operation: { ...operation, operationId: replacementOperationId, status: 'completed' },
      issues: {
        items: [{ itemId: 'new-two', applicationId: 'aaaaaaaaaaaaaaaaaaaaaaaa', status: 'failed', code: 'CANDIDATE_UNAVAILABLE' }],
        nextCursor: null,
      },
    }))
    expect(await screen.findByRole('link', { name: 'Review bulk issue for application aaaaaaaaaaaaaaaaaaaaaaaa' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Review bulk issue for application 888888888888888888888888' })).toBeNull()
  })

  it('keeps the bulk confirmation heading visibly focused and restores its trigger on cancel', async () => {
    vi.stubGlobal('fetch', vi.fn())
    render(
      <CandidateBulkActionPanel
        jobId={JOB_ID}
        selection={{ selectionId: SELECTION_ID, count: 2, expiresAt: '2026-08-25T09:00:00.000Z', description: 'Two candidates', homogeneousStage: 'new' }}
        expectedStage="new"
        onFinish={vi.fn()}
        onSettled={vi.fn()}
      />,
    )

    const trigger = screen.getByRole('button', { name: 'Reject selected…' })
    fireEvent.click(trigger)
    const heading = screen.getByRole('heading', { name: 'Confirm reject for 2 candidates' })
    await waitFor(() => expect(heading).toHaveFocus())
    expect(heading).toHaveAttribute('tabindex', '-1')
    expect(heading).not.toHaveClass('focus:outline-none')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('keeps the paged-issue heading visibly focused after bounded navigation', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('cursor=next-issue')) {
        return Promise.resolve(json({
          operation,
          issues: { items: [{ itemId: 'issue-two', applicationId: '555555555555555555555555', status: 'failed', code: 'CANDIDATE_UNAVAILABLE' }], nextCursor: null },
        }))
      }
      return Promise.resolve(json({
        operation,
        issues: { items: [{ itemId: 'issue-one', applicationId: '444444444444444444444444', status: 'conflict', code: 'STAGE_CHANGED' }], nextCursor: 'next-issue' },
      }))
    }))
    render(
      <CandidateBulkActionPanel
        jobId={JOB_ID}
        selection={null}
        expectedStage={null}
        initialOperationId={OPERATION_ID}
        onFinish={vi.fn()}
        onSettled={vi.fn()}
      />,
    )

    await screen.findByText('Bulk reject · partial')
    fireEvent.click(screen.getByText('Review conflicts and failures'))
    fireEvent.click(screen.getByRole('button', { name: 'Next issues' }))
    const heading = await screen.findByRole('heading', { name: 'Issue page 2' })
    await waitFor(() => expect(heading).toHaveFocus())
    expect(heading).toHaveAttribute('tabindex', '-1')
    expect(heading).not.toHaveClass('focus:outline-none')
  })
})
