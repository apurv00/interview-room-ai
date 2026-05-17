/**
 * Pathway P2 Wave 3 (feature #2) — MomentumSparkline.
 *
 * The component is tiny but its presence-rules are load-bearing:
 *
 *   1. <2 points → renders nothing (a single dot isn't a trend)
 *   2. >=2 points → renders an SVG with N-1 line segments + a
 *      final-point dot, with an accessible label describing trend
 *   3. Trend color: emerald when last > first by >2, red when down
 *      by >2, zinc when ±2 (flat)
 *   4. Optional targetScore renders a dashed reference line
 */

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import MomentumSparkline from '../components/pathway/MomentumSparkline'

describe('MomentumSparkline', () => {
  it('renders nothing for empty input', () => {
    const { container } = render(<MomentumSparkline points={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing for a single point (not a trend)', () => {
    const { container } = render(
      <MomentumSparkline points={[{ score: 50, at: '2026-05-10T00:00:00Z' }]} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders an SVG with an accessible label naming each score and the trend (up)', () => {
    render(
      <MomentumSparkline
        points={[
          { score: 40, at: '2026-04-01T00:00:00Z' },
          { score: 55, at: '2026-04-15T00:00:00Z' },
          { score: 70, at: '2026-05-01T00:00:00Z' },
        ]}
      />,
    )
    const svg = screen.getByRole('img')
    expect(svg.getAttribute('aria-label')).toContain('40')
    expect(svg.getAttribute('aria-label')).toContain('70')
    expect(svg.getAttribute('aria-label')).toMatch(/up/i)
  })

  it('labels the trend "down" when last < first by more than 2', () => {
    render(
      <MomentumSparkline
        points={[
          { score: 70, at: '2026-04-01T00:00:00Z' },
          { score: 60, at: '2026-05-01T00:00:00Z' },
        ]}
      />,
    )
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/down/i)
  })

  it('labels the trend "flat" when the delta is within ±2', () => {
    render(
      <MomentumSparkline
        points={[
          { score: 60, at: '2026-04-01T00:00:00Z' },
          { score: 61, at: '2026-05-01T00:00:00Z' },
        ]}
      />,
    )
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/flat/i)
  })

  it('draws a dashed target reference line when targetScore is provided', () => {
    const { container } = render(
      <MomentumSparkline
        points={[
          { score: 40, at: '2026-04-01T00:00:00Z' },
          { score: 55, at: '2026-04-15T00:00:00Z' },
        ]}
        targetScore={70}
      />,
    )
    const line = container.querySelector('line')
    expect(line).not.toBeNull()
    expect(line?.getAttribute('stroke-dasharray')).toBe('2 2')
  })
})
