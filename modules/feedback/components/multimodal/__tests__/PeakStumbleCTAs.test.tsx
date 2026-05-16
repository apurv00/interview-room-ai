import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import PeakStumbleCTAs from '../PeakStumbleCTAs'
import type { TimelineEvent } from '@shared/types/multimodal'

function ev(overrides: Partial<TimelineEvent>): TimelineEvent {
  return {
    startSec: 30,
    endSec: 35,
    type: 'strength',
    signal: 'fused',
    title: 'Strong opening',
    description: '',
    ...overrides,
  }
}

describe('PeakStumbleCTAs (Round 5a feature #10)', () => {
  it('renders nothing when both arrays are empty or missing', () => {
    const { container, rerender } = render(<PeakStumbleCTAs onSeek={() => {}} />)
    expect(container).toBeEmptyDOMElement()

    rerender(<PeakStumbleCTAs topMoments={[]} improvementMoments={[]} onSeek={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders only the Peak pill when only topMoments has entries', () => {
    render(
      <PeakStumbleCTAs
        topMoments={[ev({ startSec: 42, title: 'Strong opening presence' })]}
        improvementMoments={[]}
        onSeek={() => {}}
      />
    )
    expect(screen.getByText('▶ Peak')).toBeInTheDocument()
    expect(screen.getByText('Strong opening presence')).toBeInTheDocument()
    expect(screen.queryByText('▶ Stumble')).toBeNull()
  })

  it('renders only the Stumble pill when only improvementMoments has entries', () => {
    render(
      <PeakStumbleCTAs
        topMoments={[]}
        improvementMoments={[ev({ startSec: 128, title: 'Lost composure on hard question', type: 'improvement' })]}
        onSeek={() => {}}
      />
    )
    expect(screen.getByText('▶ Stumble')).toBeInTheDocument()
    expect(screen.getByText('Lost composure on hard question')).toBeInTheDocument()
    expect(screen.queryByText('▶ Peak')).toBeNull()
  })

  it('renders both pills with formatted timestamps when both arrays have entries', () => {
    render(
      <PeakStumbleCTAs
        topMoments={[ev({ startSec: 65, title: 'Concise STAR answer' })]}
        improvementMoments={[ev({ startSec: 195, title: 'Filler cluster', type: 'improvement' })]}
        onSeek={() => {}}
      />
    )
    expect(screen.getByText('1:05')).toBeInTheDocument()
    expect(screen.getByText('3:15')).toBeInTheDocument()
  })

  it('uses the FIRST element of each array (Claude pre-orders by severity)', () => {
    const onSeek = vi.fn()
    render(
      <PeakStumbleCTAs
        topMoments={[
          ev({ startSec: 10, title: 'BEST peak' }),
          ev({ startSec: 20, title: 'Lesser peak' }),
        ]}
        improvementMoments={[
          ev({ startSec: 30, title: 'WORST stumble', type: 'improvement' }),
          ev({ startSec: 40, title: 'Lesser stumble', type: 'improvement' }),
        ]}
        onSeek={onSeek}
      />
    )
    expect(screen.getByText('BEST peak')).toBeInTheDocument()
    expect(screen.getByText('WORST stumble')).toBeInTheDocument()
    expect(screen.queryByText('Lesser peak')).toBeNull()
    expect(screen.queryByText('Lesser stumble')).toBeNull()
  })

  it('clicking Peak calls onSeek with topMoments[0].startSec', () => {
    const onSeek = vi.fn()
    render(
      <PeakStumbleCTAs
        topMoments={[ev({ startSec: 42, title: 'Peak' })]}
        improvementMoments={[ev({ startSec: 100, title: 'Stumble', type: 'improvement' })]}
        onSeek={onSeek}
      />
    )
    fireEvent.click(screen.getByText('Peak'))
    expect(onSeek).toHaveBeenCalledWith(42)
  })

  it('clicking Stumble calls onSeek with improvementMoments[0].startSec', () => {
    const onSeek = vi.fn()
    render(
      <PeakStumbleCTAs
        topMoments={[ev({ startSec: 42, title: 'Peak' })]}
        improvementMoments={[ev({ startSec: 100, title: 'Stumble', type: 'improvement' })]}
        onSeek={onSeek}
      />
    )
    fireEvent.click(screen.getByText('Stumble'))
    expect(onSeek).toHaveBeenCalledWith(100)
  })
})
