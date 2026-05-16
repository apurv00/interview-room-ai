import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import Scrubber from '../Scrubber'
import type { TimelineEvent } from '@shared/types/multimodal'

function makeMoment(startSec: number, type: TimelineEvent['type'], title = 'evt'): TimelineEvent {
  return {
    startSec,
    endSec: startSec + 5,
    type,
    severity: 'neutral',
    signal: 'fused',
    title,
    description: '',
    questionIndex: 0,
  } as TimelineEvent
}

const QUESTIONS = [
  { label: 'Q1', offsetSeconds: 0 },
  { label: 'Q2', offsetSeconds: 60 },
  { label: 'Q3', offsetSeconds: 120 },
]

describe('Scrubber', () => {
  it('renders play button + time readout + speed pill', () => {
    render(
      <Scrubber
        currentTimeSec={30}
        totalDurationSec={180}
        onSeek={vi.fn()}
        playing={false}
        setPlaying={vi.fn()}
        questions={QUESTIONS}
        keyMoments={[]}
      />
    )
    expect(screen.getByLabelText('Play')).toBeInTheDocument()
    expect(screen.getByText('0:30 / 3:00')).toBeInTheDocument()
    expect(screen.getByText('1×')).toBeInTheDocument()
  })

  it('shows Pause label when playing=true', () => {
    render(
      <Scrubber
        currentTimeSec={0}
        totalDurationSec={100}
        onSeek={vi.fn()}
        playing
        setPlaying={vi.fn()}
        questions={[]}
        keyMoments={[]}
      />
    )
    expect(screen.getByLabelText('Pause')).toBeInTheDocument()
  })

  it('renders one question boundary mark per question', () => {
    const { container } = render(
      <Scrubber
        currentTimeSec={0}
        totalDurationSec={180}
        onSeek={vi.fn()}
        playing={false}
        setPlaying={vi.fn()}
        questions={QUESTIONS}
        keyMoments={[]}
      />
    )
    // Three thin vertical ticks for three questions
    const slider = container.querySelector('[role="slider"]')!
    const ticks = slider.querySelectorAll('.w-px.h-3\\.5')
    expect(ticks.length).toBe(3)
  })

  it('renders a colored tick per key moment', () => {
    const { container } = render(
      <Scrubber
        currentTimeSec={0}
        totalDurationSec={180}
        onSeek={vi.fn()}
        playing={false}
        setPlaying={vi.fn()}
        questions={[]}
        keyMoments={[
          makeMoment(30, 'strength'),
          makeMoment(90, 'improvement'),
          makeMoment(150, 'coaching_tip'),
        ]}
      />
    )
    const slider = container.querySelector('[role="slider"]')!
    const ticks = slider.querySelectorAll('.w-0\\.5.h-2\\.5')
    expect(ticks.length).toBe(3)
  })

  it('exposes ARIA slider values', () => {
    render(
      <Scrubber
        currentTimeSec={42}
        totalDurationSec={120}
        onSeek={vi.fn()}
        playing={false}
        setPlaying={vi.fn()}
        questions={[]}
        keyMoments={[]}
      />
    )
    const slider = screen.getByRole('slider')
    expect(slider).toHaveAttribute('aria-valuemin', '0')
    expect(slider).toHaveAttribute('aria-valuemax', '120')
    expect(slider).toHaveAttribute('aria-valuenow', '42')
  })

  it('keyboard arrows seek by ±5s', () => {
    const onSeek = vi.fn()
    render(
      <Scrubber
        currentTimeSec={50}
        totalDurationSec={300}
        onSeek={onSeek}
        playing={false}
        setPlaying={vi.fn()}
        questions={[]}
        keyMoments={[]}
      />
    )
    const slider = screen.getByRole('slider')
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(onSeek).toHaveBeenCalledWith(55)
    fireEvent.keyDown(slider, { key: 'ArrowLeft' })
    expect(onSeek).toHaveBeenCalledWith(45)
  })

  it('play button toggles playing state', () => {
    const setPlaying = vi.fn()
    render(
      <Scrubber
        currentTimeSec={0}
        totalDurationSec={100}
        onSeek={vi.fn()}
        playing={false}
        setPlaying={setPlaying}
        questions={[]}
        keyMoments={[]}
      />
    )
    fireEvent.click(screen.getByLabelText('Play'))
    expect(setPlaying).toHaveBeenCalledWith(true)
  })
})
