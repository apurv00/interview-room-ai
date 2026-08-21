import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import HireInterviewRecordingPanel from '../HireInterviewRecordingPanel'

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HireInterviewRecordingPanel', () => {
  it('obtains a short-lived capability only when an HR member elects to play the full recording', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        url: 'https://private-r2.example/recording.webm?signature=temporary',
        expiresInSeconds: 300,
        kind: 'camera_recording',
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { container } = render(
      <HireInterviewRecordingPanel
        applicationId="application-1"
        recording={{
          status: 'ready',
          assetId: 'asset-1',
          capturedAt: '2026-08-17T12:00:00.000Z',
          bytes: 42_000_000,
        }}
      />,
    )

    expect(screen.getByText('Full interview recording')).toBeTruthy()
    expect(screen.queryByText('asset-1')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Play full interview' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/workspace/applications/application-1/media/asset-1',
        { cache: 'no-store' },
      )
    })
    const player = container.querySelector('video')
    expect(player?.getAttribute('src')).toBe(
      'https://private-r2.example/recording.webm?signature=temporary',
    )

    fireEvent.error(player!)
    await screen.findByText(/temporary playback link expired/i)
    expect(screen.getByRole('button', { name: 'Play full interview' })).toBeTruthy()
  })

  it('shows transfer and removal states without offering a playback action', () => {
    const { rerender } = render(
      <HireInterviewRecordingPanel
        applicationId="application-1"
        recording={{ status: 'awaiting_transfer' }}
      />,
    )

    expect(screen.getByText('Preparing recording')).toBeTruthy()
    expect(screen.getByText(/waiting for the candidate recording/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Play full interview' })).toBeNull()

    rerender(
      <HireInterviewRecordingPanel
        applicationId="application-1"
        recording={{ status: 'removed' }}
      />,
    )
    expect(screen.getByText('Recording removed')).toBeTruthy()
    expect(screen.getByText(/retention or deletion policy/i)).toBeTruthy()
  })

  it('shows a neutral terminal delivery failure without a playback action', () => {
    render(
      <HireInterviewRecordingPanel
        applicationId="application-1"
        recording={{ status: 'unavailable', reason: 'retry_exhausted' }}
      />,
    )

    expect(screen.getByText('Recording unavailable')).toBeTruthy()
    expect(screen.getByText(/bounded retries/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Play full interview' })).toBeNull()
  })
})
