import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import VideoPlayer from '../VideoPlayer'

// Mock lucide-react to avoid import issues in test
vi.mock('lucide-react', () => ({
  Play: () => <span data-testid="play-icon">Play</span>,
  Pause: () => <span data-testid="pause-icon">Pause</span>,
  Volume2: () => <span data-testid="volume-icon">Vol</span>,
  VolumeX: () => <span data-testid="mute-icon">Mute</span>,
  Loader2: () => <span data-testid="loader-icon">Loading</span>,
}))

describe('VideoPlayer', () => {
  it('renders video element with correct src', () => {
    render(
      <VideoPlayer
        src="https://example.com/video.webm"
        questionMarkers={[]}
      />
    )

    const video = document.querySelector('video')
    expect(video).toBeTruthy()
    expect(video?.src).toBe('https://example.com/video.webm')
  })

  it('renders play button', () => {
    render(
      <VideoPlayer
        src="https://example.com/video.webm"
        questionMarkers={[]}
      />
    )

    expect(screen.getByLabelText('Play')).toBeTruthy()
  })

  it('renders question markers', () => {
    render(
      <VideoPlayer
        src="https://example.com/video.webm"
        questionMarkers={[
          { label: 'Q1', offsetSeconds: 10 },
          { label: 'Q2', offsetSeconds: 60 },
        ]}
      />
    )

    // Question markers are rendered as divs with title attributes
    const markers = document.querySelectorAll('[title]')
    const markerTitles = Array.from(markers).map((m) => m.getAttribute('title'))
    expect(markerTitles).toContain('Q1')
    expect(markerTitles).toContain('Q2')
  })

  it('renders speed control', () => {
    render(
      <VideoPlayer
        src="https://example.com/video.webm"
        questionMarkers={[]}
      />
    )

    expect(screen.getByText('1x')).toBeTruthy()
  })
})
