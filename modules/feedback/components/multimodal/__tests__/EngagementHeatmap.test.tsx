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

/**
 * Bucket selector. After the Codex P2 a11y refactor (Round 5c fix-ups),
 * buckets are non-interactive `<span data-band data-start>` rather than
 * `<button>` — the per-bucket button design polluted Tab order with up
 * to 600 stops on long sessions. Tests now select by data-band.
 */
function buckets(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-band]'))
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
    expect(buckets(strip)).toHaveLength(3)
  })

  it('color-codes each span by band via data-band', () => {
    const ts = [
      seg(0, 1, 0.9), // strong
      seg(1, 2, 0.6), // okay
      seg(2, 3, 0.3), // weak
      seg(3, 4, -1),  // no-data sentinel
    ]
    render(<EngagementHeatmap facialTimeseries={ts} totalDurationSec={4} />)
    expect(buckets(screen.getByTestId('engagement-heatmap')).map((b) => b.getAttribute('data-band'))).toEqual([
      'strong',
      'okay',
      'weak',
      'no-data',
    ])
  })

  it('positions each bucket at (startSec / totalDurationSec * 100)%', () => {
    const ts = [seg(0, 50, 0.8), seg(50, 100, 0.5)]
    render(<EngagementHeatmap facialTimeseries={ts} totalDurationSec={200} />)
    const bs = buckets(screen.getByTestId('engagement-heatmap'))
    expect(bs[0].style.left).toBe('0%')
    expect(bs[1].style.left).toBe('25%') // 50/200 = 25%
  })

  it('renders the "Attention" left label', () => {
    render(
      <EngagementHeatmap facialTimeseries={[seg(0, 1, 0.8)]} totalDurationSec={1} />
    )
    expect(screen.getByText('Attention')).toBeInTheDocument()
  })

  it('exposes per-bucket title with formatted time + band + percentage', () => {
    const ts = [seg(75, 76, 0.83)]
    render(<EngagementHeatmap facialTimeseries={ts} totalDurationSec={120} />)
    const b = buckets(screen.getByTestId('engagement-heatmap'))[0]
    // 75s = 1:15; 0.83 → strong; rendered as "1:15 · strong 83%"
    expect(b.getAttribute('title')).toContain('1:15')
    expect(b.getAttribute('title')).toContain('strong')
    expect(b.getAttribute('title')).toContain('83%')
  })

  it('no-data buckets render with a sentinel-friendly hover label', () => {
    const ts = [seg(0, 1, -1)]
    render(<EngagementHeatmap facialTimeseries={ts} totalDurationSec={1} />)
    const b = buckets(screen.getByTestId('engagement-heatmap'))[0]
    expect(b.getAttribute('title')).toContain('no data')
  })

  it('downsamples when timeseries exceeds the bucket cap', () => {
    // 1200 segments → downsampled to ≤600 buckets
    const ts = Array.from({ length: 1200 }, (_, i) => seg(i, i + 1, 0.8))
    render(<EngagementHeatmap facialTimeseries={ts} totalDurationSec={1200} />)
    const bs = buckets(screen.getByTestId('engagement-heatmap'))
    expect(bs.length).toBeLessThanOrEqual(600)
    expect(bs.length).toBeGreaterThan(0)
  })

  // Codex P2 a11y review on Round 5c — buckets must NOT be in the
  // tab order or screen-reader rotor. Single click target = strip wrapper.
  describe('accessibility — buckets are non-interactive (event delegation)', () => {
    it('does NOT render <button> elements per bucket', () => {
      const ts = Array.from({ length: 50 }, (_, i) => seg(i, i + 1, 0.6))
      const { container } = render(
        <EngagementHeatmap facialTimeseries={ts} totalDurationSec={50} onSeek={vi.fn()} />
      )
      // No interactive button descendants — tab order stays clean.
      expect(container.querySelectorAll('button').length).toBe(0)
    })

    it('exposes exactly one role="group" wrapper with a single aria-label for the whole strip', () => {
      const ts = [seg(0, 1, 0.9), seg(1, 2, 0.5)]
      render(<EngagementHeatmap facialTimeseries={ts} totalDurationSec={2} onSeek={vi.fn()} />)
      const groups = screen.getAllByRole('group')
      expect(groups.length).toBe(1)
      expect(groups[0].getAttribute('aria-label')).toMatch(/engagement/i)
    })

    it('individual buckets have no aria-label or role (no rotor pollution)', () => {
      const ts = Array.from({ length: 10 }, (_, i) => seg(i, i + 1, 0.6))
      render(<EngagementHeatmap facialTimeseries={ts} totalDurationSec={10} onSeek={vi.fn()} />)
      const bs = buckets(screen.getByTestId('engagement-heatmap'))
      for (const b of bs) {
        expect(b.hasAttribute('aria-label')).toBe(false)
        expect(b.hasAttribute('role')).toBe(false)
      }
    })
  })

  describe('event-delegated click', () => {
    it('clicking a bucket bubbles up and onSeek is called with that bucket\'s startSec', () => {
      const onSeek = vi.fn()
      const ts = [seg(0, 1, 0.9), seg(1, 2, 0.5), seg(2, 3, 0.2)]
      render(
        <EngagementHeatmap facialTimeseries={ts} totalDurationSec={3} onSeek={onSeek} />
      )
      const bs = buckets(screen.getByTestId('engagement-heatmap'))
      fireEvent.click(bs[1])
      expect(onSeek).toHaveBeenCalledWith(1)
    })

    it('clicking the wrapper background (not a bucket) is a safe no-op', () => {
      const onSeek = vi.fn()
      const ts = [seg(0, 1, 0.9)]
      render(
        <EngagementHeatmap facialTimeseries={ts} totalDurationSec={1} onSeek={onSeek} />
      )
      const wrapper = screen.getByRole('group')
      fireEvent.click(wrapper) // hits the strip wrapper, not a bucket span
      expect(onSeek).not.toHaveBeenCalled()
    })

    it('does not throw when onSeek is omitted', () => {
      const ts = [seg(0, 1, 0.9)]
      render(<EngagementHeatmap facialTimeseries={ts} totalDurationSec={1} />)
      const b = buckets(screen.getByTestId('engagement-heatmap'))[0]
      expect(() => fireEvent.click(b)).not.toThrow()
    })
  })
})
