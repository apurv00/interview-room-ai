import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import EngagementHeatmap from '../EngagementHeatmap'
import type { FacialSegment } from '@shared/types/multimodal'

function seg(start: number, end: number, eye: number): FacialSegment {
  return {
    startSec: start,
    endSec: end,
    avgEyeContact: eye,
    dominantExpression: 'neutral',
    headStability: 0.9,
    gestureLevel: 'moderate',
  } as FacialSegment
}

describe('EngagementHeatmap (Round 5c #7)', () => {
  it('renders nothing when no facialTimeseries is provided', () => {
    const { container } = render(
      <EngagementHeatmap totalDurationSec={300} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when facialTimeseries is empty', () => {
    const { container } = render(
      <EngagementHeatmap facialTimeseries={[]} totalDurationSec={300} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when totalDurationSec is 0 (would div by zero)', () => {
    const { container } = render(
      <EngagementHeatmap
        facialTimeseries={[seg(0, 1, 0.8)]}
        totalDurationSec={0}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders one bucket span per timeseries entry under the cap', () => {
    const ts = [seg(0, 1, 0.9), seg(1, 2, 0.5), seg(2, 3, 0.2)]
    render(<EngagementHeatmap facialTimeseries={ts} totalDurationSec={3} />)
    const strip = screen.getByTestId('engagement-heatmap')
    expect(strip.querySelectorAll('button')).toHaveLength(3)
  })

  it('color-codes each span by band via data-band', () => {
    const ts = [
      seg(0, 1, 0.9), // strong
      seg(1, 2, 0.6), // okay
      seg(2, 3, 0.3), // weak
      seg(3, 4, -1),  // no-data sentinel
    ]
    render(<EngagementHeatmap facialTimeseries={ts} totalDurationSec={4} />)
    const buttons = Array.from(
      screen.getByTestId('engagement-heatmap').querySelectorAll('button')
    )
    expect(buttons.map((b) => b.getAttribute('data-band'))).toEqual([
      'strong',
      'okay',
      'weak',
      'no-data',
    ])
  })

  it('positions each bucket at (startSec / totalDurationSec * 100)%', () => {
    const ts = [seg(0, 50, 0.8), seg(50, 100, 0.5)]
    render(<EngagementHeatmap facialTimeseries={ts} totalDurationSec={200} />)
    const buttons = Array.from(
      screen.getByTestId('engagement-heatmap').querySelectorAll('button')
    ) as HTMLElement[]
    expect(buttons[0].style.left).toBe('0%')
    expect(buttons[1].style.left).toBe('25%') // 50/200 = 25%
  })

  it('renders the "Attention" left label', () => {
    render(
      <EngagementHeatmap facialTimeseries={[seg(0, 1, 0.8)]} totalDurationSec={1} />
    )
    expect(screen.getByText('Attention')).toBeInTheDocument()
  })

  it('clicking a bucket calls onSeek with that bucket\'s startSec', () => {
    const onSeek = vi.fn()
    const ts = [seg(0, 1, 0.9), seg(1, 2, 0.5), seg(2, 3, 0.2)]
    render(
      <EngagementHeatmap
        facialTimeseries={ts}
        totalDurationSec={3}
        onSeek={onSeek}
      />
    )
    const buttons = Array.from(
      screen.getByTestId('engagement-heatmap').querySelectorAll('button')
    )
    fireEvent.click(buttons[1])
    expect(onSeek).toHaveBeenCalledWith(1)
  })

  it('does not throw when onSeek is omitted', () => {
    const ts = [seg(0, 1, 0.9)]
    render(<EngagementHeatmap facialTimeseries={ts} totalDurationSec={1} />)
    const button = screen.getByTestId('engagement-heatmap').querySelector('button')!
    expect(() => fireEvent.click(button)).not.toThrow()
  })

  it('exposes per-bucket title with formatted time + band + percentage', () => {
    const ts = [seg(75, 76, 0.83)]
    render(<EngagementHeatmap facialTimeseries={ts} totalDurationSec={120} />)
    const button = screen.getByTestId('engagement-heatmap').querySelector('button')!
    // 75s = 1:15; 0.83 → strong; rendered as "1:15 · strong 83%"
    expect(button.getAttribute('title')).toContain('1:15')
    expect(button.getAttribute('title')).toContain('strong')
    expect(button.getAttribute('title')).toContain('83%')
  })

  it('no-data buckets render with a sentinel-friendly hover label', () => {
    const ts = [seg(0, 1, -1)]
    render(<EngagementHeatmap facialTimeseries={ts} totalDurationSec={1} />)
    const button = screen.getByTestId('engagement-heatmap').querySelector('button')!
    expect(button.getAttribute('title')).toContain('no data')
  })

  it('downsamples when timeseries exceeds the bucket cap', () => {
    // 1200 segments → downsampled to ≤600 buckets
    const ts = Array.from({ length: 1200 }, (_, i) => seg(i, i + 1, 0.8))
    render(<EngagementHeatmap facialTimeseries={ts} totalDurationSec={1200} />)
    const buttons = screen.getByTestId('engagement-heatmap').querySelectorAll('button')
    expect(buttons.length).toBeLessThanOrEqual(600)
    expect(buttons.length).toBeGreaterThan(0)
  })
})
