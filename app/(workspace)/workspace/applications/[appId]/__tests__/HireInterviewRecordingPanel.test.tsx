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
  vi.restoreAllMocks()
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
        expect.objectContaining({
          cache: 'no-store',
          signal: expect.any(AbortSignal),
        }),
      )
    })
    const player = container.querySelector('video')
    expect(player?.getAttribute('src')).toBe(
      'https://private-r2.example/recording.webm?signature=temporary',
    )
    fireEvent.loadedMetadata(player!)
    expect(document.activeElement).toBe(player)

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

  it('opens from a timeline request, seeks to the event, and exposes synchronized captions', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:interview-captions')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      json({
        url: 'https://private-r2.example/recording.webm?signature=temporary',
        kind: 'camera_recording',
      }),
    ))

    const { container, rerender } = render(
      <HireInterviewRecordingPanel
        applicationId="application-1"
        recording={{
          status: 'ready',
          assetId: 'asset-1',
          capturedAt: '2026-08-17T12:00:00.000Z',
          bytes: 42_000_000,
        }}
        playbackRequest={{ id: 1, startMs: 5_000 }}
        captions={[{
          startMs: 1_000,
          endMs: 4_000,
          text: 'Candidate: A synchronized answer',
        }]}
      />,
    )

    const video = await screen.findByLabelText('Private full interview recording')
    Object.defineProperties(video, {
      readyState: { configurable: true, value: 1 },
      duration: { configurable: true, value: 30 },
      play: { configurable: true, value: vi.fn().mockResolvedValue(undefined) },
    })
    fireEvent.loadedMetadata(video)

    expect((video as HTMLVideoElement).currentTime).toBe(5)
    expect(document.activeElement).toBe(video)
    expect(video.getAttribute('tabindex')).toBe('0')
    expect(container.querySelector('track')?.getAttribute('src')).toBe(
      'blob:interview-captions',
    )
    expect(screen.getByText(/Candidate: A synchronized answer/)).toBeTruthy()

    ;(video as HTMLVideoElement).currentTime = 11
    rerender(
      <HireInterviewRecordingPanel
        applicationId="application-1"
        recording={{
          status: 'ready',
          assetId: 'asset-1',
          capturedAt: '2026-08-17T12:00:00.000Z',
          bytes: 42_000_000,
        }}
        playbackRequest={{ id: 1, startMs: 5_000 }}
        captions={[{
          startMs: 1_000,
          endMs: 4_000,
          text: 'Candidate: A synchronized answer',
        }]}
      />,
    )
    expect((video as HTMLVideoElement).currentTime).toBe(11)
    expect(fetch).toHaveBeenCalledTimes(1)

    fireEvent.error(video)
    await screen.findByText(/temporary playback link expired/i)
    expect(fetch).toHaveBeenCalledTimes(1)

    rerender(
      <HireInterviewRecordingPanel
        applicationId="application-1"
        recording={{
          status: 'ready',
          assetId: 'asset-2',
          capturedAt: '2026-08-17T12:01:00.000Z',
          bytes: 43_000_000,
        }}
        playbackRequest={{ id: 1, startMs: 5_000 }}
      />,
    )
    await Promise.resolve()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('discards a capability response for an asset replaced while the request is pending', async () => {
    let resolveCapability!: (response: Response) => void
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveCapability = resolve
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { container, rerender } = render(
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
    fireEvent.click(screen.getByRole('button', { name: 'Play full interview' }))
    const signal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal

    rerender(
      <HireInterviewRecordingPanel
        applicationId="application-1"
        recording={{
          status: 'ready',
          assetId: 'asset-2',
          capturedAt: '2026-08-17T12:01:00.000Z',
          bytes: 43_000_000,
        }}
      />,
    )
    expect(signal.aborted).toBe(true)

    resolveCapability(json({
      url: 'https://private-r2.example/stale.webm',
      kind: 'camera_recording',
    }))
    await Promise.resolve()
    expect(container.querySelector('video')).toBeNull()
    expect(screen.getByRole('button', { name: 'Play full interview' })).toBeTruthy()
  })
})
