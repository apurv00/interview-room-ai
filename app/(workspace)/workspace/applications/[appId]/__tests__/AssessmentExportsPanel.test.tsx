import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AssessmentExportsPanel from '../AssessmentExportsPanel'

const EXPORT_ID = '2'.repeat(24)
const OPERATION_ID = '11111111-1111-4111-8111-111111111111'

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function view(status: 'pending' | 'ready' | 'failed' | 'cancelled') {
  return {
    id: EXPORT_ID,
    status,
    requestedAt: '2026-08-14T10:00:00.000Z',
    expiresAt: '2026-08-21T10:00:00.000Z',
    readyAt: status === 'ready' ? '2026-08-14T10:02:00.000Z' : null,
    // A deliberately over-broad server response must not be rendered by the
    // member UI even if a route regression accidentally contains it.
    objectKey: 'hire-assessment-exports/v1/private.pdf',
    decisionSnapshot: { rawResume: 'never render this' },
    downloadUrl: 'https://storage.example/private.pdf',
    failureCode: 'storage_failed',
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('AssessmentExportsPanel', () => {
  it('requests with a UUID and schedules opaque status polling while the export is pending', async () => {
    vi.useFakeTimers()
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')
    vi.stubGlobal('crypto', { randomUUID: () => OPERATION_ID })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path.endsWith('/assessment-exports') && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({ operationId: OPERATION_ID })
        return json({ assessmentExport: view('pending') }, 201)
      }
      throw new Error(`Unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<AssessmentExportsPanel applicationId="app-1" jobIsOpen terminal={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create assessment PDF' }))

    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText('Assessment export queued. This page will check its status automatically.')).toBeTruthy()
    expect(screen.getByText('queued')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Preparing…' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Download PDF' })).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspace/applications/app-1/assessment-exports',
      expect.objectContaining({ method: 'POST', cache: 'no-store' }),
    )
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 3_000)
    expect(document.body.textContent).not.toContain('private.pdf')
    expect(document.body.textContent).not.toContain('never render this')
    expect(document.body.textContent).not.toContain('storage.example')
    expect(document.body.textContent).not.toContain('storage_failed')
  })

  it('offers a browser download only when the opaque lifecycle response is ready', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => OPERATION_ID })
    const createObjectURL = vi.fn(() => 'blob:private-assessment')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path.endsWith('/assessment-exports') && init?.method === 'POST') {
        return json({ assessmentExport: view('ready') }, 201)
      }
      if (path.endsWith(`/assessment-exports/${EXPORT_ID}/download`)) {
        return new Response('%PDF-safe', { status: 200, headers: { 'Content-Type': 'application/pdf' } })
      }
      throw new Error(`Unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<AssessmentExportsPanel applicationId="app-1" jobIsOpen terminal={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create assessment PDF' }))

    await screen.findByText('Assessment export is ready to download.')
    expect(screen.getByRole('button', { name: 'Download PDF' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Download PDF' }))
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce())
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/workspace/assessment-exports/${EXPORT_ID}/download`,
      { cache: 'no-store' },
    )
    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:private-assessment')
    expect(anchorClick).toHaveBeenCalledOnce()
  })

  it.each([
    ['failed', 'could not prepare', 'The report could not be prepared. Create a new export to try again.'],
    ['cancelled', 'cancelled', 'This report is no longer available. Create a new export while the application remains active.'],
  ] as const)('shows an opaque %s lifecycle state without a download action', async (status, badge, explanation) => {
    vi.stubGlobal('crypto', { randomUUID: () => OPERATION_ID })
    const fetchMock = vi.fn().mockResolvedValue(json({ assessmentExport: view(status) }))
    vi.stubGlobal('fetch', fetchMock)

    render(<AssessmentExportsPanel applicationId="app-1" jobIsOpen terminal={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create assessment PDF' }))

    await screen.findByText(explanation)
    expect(screen.getByText(badge)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Download PDF' })).toBeNull()
    expect(document.body.textContent).not.toContain('storage_failed')
  })
})
