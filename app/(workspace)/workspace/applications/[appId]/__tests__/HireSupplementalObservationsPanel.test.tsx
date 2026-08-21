import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import HireSupplementalObservationsPanel from '../HireSupplementalObservationsPanel'

describe('HireSupplementalObservationsPanel', () => {
  it('renders a bounded neutral validation timeline separately from assessment scores', () => {
    const onReviewRecording = vi.fn()
    render(
      <HireSupplementalObservationsPanel
        recordingAvailability={{ camera: true, screen: true }}
        onReviewRecording={onReviewRecording}
        observations={[
          {
            observedAt: '2026-08-17T12:00:00.000Z',
            report: {
              status: 'completed',
              capture: {
                camera: 'captured',
                browserVisibility: 'captured',
                displayShare: 'captured',
              },
              playbackClock: {
                protocolVersion: 1,
                cameraRecorderStartOffsetMs: 1_000,
                screenRecorderStartOffsetMs: 1_250,
              },
              events: [
                {
                  kind: 'browser_window_not_visible',
                  source: 'browser_visibility',
                  startMs: 5_000,
                  endMs: 8_000,
                },
              ],
            },
          },
        ]}
      />,
    )

    expect(
      screen.getByRole('region', { name: 'Interview validation timeline' }),
    ).toBeTruthy()
    expect(screen.getByText(/Assessment window was not visible/i)).toBeTruthy()
    expect(screen.getByText(/0:05–0:08/)).toBeTruthy()
    expect(screen.getByText(/Signal: window visibility/i)).toBeTruthy()
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Review shared display recording for event at 0:05',
      }),
    )
    expect(onReviewRecording).toHaveBeenCalledWith({ kind: 'screen', startMs: 3_750 })
    expect(screen.getByText(/not interview scores/i)).toBeTruthy()
    expect(screen.getByText(/do not automatically determine a hiring decision, stage, ranking, recommendation, or export/i)).toBeTruthy()
    expect(screen.queryByText(/did not affect/i)).toBeNull()
    expect(screen.queryByText(/confidence/i)).toBeNull()
  })

  it('does not claim an exact seek for a legacy report without a recorder clock', () => {
    const onReviewRecording = vi.fn()
    render(
      <HireSupplementalObservationsPanel
        recordingAvailability={{ camera: true, screen: true }}
        onReviewRecording={onReviewRecording}
        observations={[
          {
            observedAt: '2026-08-17T12:00:00.000Z',
            report: {
              status: 'completed',
              capture: { camera: 'captured', browserVisibility: 'captured' },
              events: [{
                kind: 'camera_interrupted',
                source: 'camera_track',
                startMs: 5_000,
                endMs: 5_500,
              }],
            },
          },
        ]}
      />,
    )

    expect(screen.queryByRole('button', { name: /Review .* recording/i })).toBeNull()
    expect(
      screen.getByText(/Exact recording time unavailable for this capture/i),
    ).toBeTruthy()
    expect(onReviewRecording).not.toHaveBeenCalled()
  })

  it('does not seek an event that predates every available recorder', () => {
    const onReviewRecording = vi.fn()
    render(
      <HireSupplementalObservationsPanel
        recordingAvailability={{ camera: true, screen: false }}
        onReviewRecording={onReviewRecording}
        observations={[{
          observedAt: '2026-08-17T12:00:00.000Z',
          report: {
            status: 'completed',
            capture: { camera: 'captured', browserVisibility: 'captured' },
            playbackClock: {
              protocolVersion: 1,
              cameraRecorderStartOffsetMs: 1_000,
            },
            events: [{
              kind: 'camera_interrupted',
              source: 'camera_track',
              startMs: 500,
              endMs: 750,
            }],
          },
        }]}
      />,
    )

    expect(screen.queryByRole('button', { name: /Review .* recording/i })).toBeNull()
    expect(
      screen.getByText(/Exact recording time unavailable for this capture/i),
    ).toBeTruthy()
    expect(onReviewRecording).not.toHaveBeenCalled()
  })

  it('explains insufficient signal without inventing a conclusion', () => {
    render(
      <HireSupplementalObservationsPanel
        observations={[
          {
            observedAt: '2026-08-17T12:00:00.000Z',
            report: {
              status: 'insufficient_signal',
              capture: { camera: 'unavailable', browserVisibility: 'unavailable' },
              events: [],
            },
          },
        ]}
      />,
    )

    expect(screen.getByText(/not enough supplemental signal/i)).toBeTruthy()
  })

  it('renders new full-screen, device, and speech-validation signals as neutral review timestamps', () => {
    render(
      <HireSupplementalObservationsPanel
        observations={[
          {
            observedAt: '2026-08-19T12:00:00.000Z',
            report: {
              status: 'completed',
              capture: { camera: 'captured', browserVisibility: 'captured' },
              events: [
                {
                  kind: 'fullscreen_exited',
                  source: 'fullscreen',
                  startMs: 10_000,
                  endMs: 10_000,
                },
                {
                  kind: 'microphone_interrupted',
                  source: 'microphone_track',
                  startMs: 12_000,
                  endMs: 15_000,
                },
                {
                  kind: 'speech_video_unverified',
                  source: 'speech_video_corroboration',
                  startMs: 30_000,
                  endMs: 33_000,
                },
                {
                  kind: 'screen_share_wrong_surface',
                  source: 'display_surface',
                  startMs: 40_000,
                  endMs: 42_000,
                },
                {
                  kind: 'screen_share_interrupted',
                  source: 'display_track',
                  startMs: 45_000,
                  endMs: 47_000,
                },
                {
                  kind: 'screen_recording_interrupted',
                  source: 'display_recorder',
                  startMs: 48_000,
                  endMs: 48_000,
                },
              ],
            },
          },
        ]}
      />,
    )

    expect(screen.getByText(/Full-screen mode was exited/i)).toBeTruthy()
    expect(screen.getByText(/Microphone capture was interrupted/i)).toBeTruthy()
    expect(
      screen.getByText(/Spoken audio could not be verified against the visible candidate/i),
    ).toBeTruthy()
    expect(screen.getByText(/Signal: audio-video corroboration/i)).toBeTruthy()
    expect(screen.getByText(/The required entire display was not shared/i)).toBeTruthy()
    expect(screen.getByText(/Entire-display sharing was interrupted/i)).toBeTruthy()
    expect(screen.getByText(/Shared-display recording was interrupted/i)).toBeTruthy()
    expect(screen.getByText(/Signal: display surface/i)).toBeTruthy()
    expect(screen.getByText(/Signal: display capture/i)).toBeTruthy()
    expect(screen.getByText(/Signal: display recording/i)).toBeTruthy()
    expect(screen.queryByText(/someone else was speaking/i)).toBeNull()
  })
})
