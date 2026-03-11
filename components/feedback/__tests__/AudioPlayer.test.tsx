import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import AudioPlayer from '../AudioPlayer'

// Mock HTMLAudioElement
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})

describe('AudioPlayer', () => {
  const defaultProps = {
    src: '/test-audio.webm',
    questionMarkers: [
      { label: 'Q1', offsetSeconds: 10 },
      { label: 'Q2', offsetSeconds: 30 },
    ],
  }

  it('renders play button', () => {
    render(<AudioPlayer {...defaultProps} />)
    const playBtn = screen.getByRole('button', { name: /loading audio|^play$/i })
    expect(playBtn).toBeInTheDocument()
  })

  it('renders seek bar', () => {
    render(<AudioPlayer {...defaultProps} />)
    const seekBar = screen.getByLabelText('Seek audio position')
    expect(seekBar).toBeInTheDocument()
    expect(seekBar).toHaveAttribute('type', 'range')
  })

  it('renders speed controls', () => {
    render(<AudioPlayer {...defaultProps} />)
    expect(screen.getByText('0.5x')).toBeInTheDocument()
    expect(screen.getByText('1x')).toBeInTheDocument()
    expect(screen.getByText('1.25x')).toBeInTheDocument()
    expect(screen.getByText('1.5x')).toBeInTheDocument()
    expect(screen.getByText('2x')).toBeInTheDocument()
  })

  it('renders time display', () => {
    render(<AudioPlayer {...defaultProps} />)
    expect(screen.getByText('0:00 / 0:00')).toBeInTheDocument()
  })

  it('has accessible speed buttons', () => {
    render(<AudioPlayer {...defaultProps} />)
    const btn = screen.getByLabelText('Playback speed 1.5x')
    expect(btn).toBeInTheDocument()
  })

  it('has aria attributes on seek bar', () => {
    render(<AudioPlayer {...defaultProps} />)
    const seekBar = screen.getByLabelText('Seek audio position')
    expect(seekBar).toHaveAttribute('aria-valuemin', '0')
    expect(seekBar).toHaveAttribute('aria-valuenow', '0')
  })

  it('calls onSeek callback with seekTo function', () => {
    const onSeek = vi.fn()
    render(<AudioPlayer {...defaultProps} onSeek={onSeek} />)
    expect(onSeek).toHaveBeenCalledWith(expect.any(Function))
  })

  it('speed button marks active speed with aria-pressed', () => {
    render(<AudioPlayer {...defaultProps} />)
    const activeBtn = screen.getByLabelText('Playback speed 1x')
    expect(activeBtn).toHaveAttribute('aria-pressed', 'true')

    const inactiveBtn = screen.getByLabelText('Playback speed 1.5x')
    expect(inactiveBtn).toHaveAttribute('aria-pressed', 'false')
  })

  it('clicking a speed button changes active speed', () => {
    render(<AudioPlayer {...defaultProps} />)
    const btn = screen.getByLabelText('Playback speed 1.5x')
    fireEvent.click(btn)
    expect(btn).toHaveAttribute('aria-pressed', 'true')

    const oldBtn = screen.getByLabelText('Playback speed 1x')
    expect(oldBtn).toHaveAttribute('aria-pressed', 'false')
  })
})
