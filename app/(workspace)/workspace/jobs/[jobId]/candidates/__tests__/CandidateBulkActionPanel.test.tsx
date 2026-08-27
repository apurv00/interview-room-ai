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
    fireEvent.click(await screen.findByRole('button', { name: 'Load more issues' }))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('cursor=next-issue'))).toBe(true))
    expect(await screen.findByText(/candidate unavailable/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Review bulk issue for application 444444444444444444444444' })).toHaveAttribute(
      'href',
      expect.stringContaining(`returnTo=%2Fworkspace%2Fjobs%2F${JOB_ID}%2Fcandidates%3Fview%3Dall`),
    )
    expect(screen.getByRole('link', { name: 'Review bulk issue for application 555555555555555555555555' })).toBeTruthy()
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
})
