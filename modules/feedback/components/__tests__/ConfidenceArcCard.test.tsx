import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import ConfidenceArcCard from '../ConfidenceArcCard'

describe('ConfidenceArcCard (Round 5a feature #2)', () => {
  it('renders nothing when both narrative and per-Q sparkline data are absent', () => {
    const { container } = render(<ConfidenceArcCard />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when narrative is empty string and sparkline is empty', () => {
    const { container } = render(
      <ConfidenceArcCard confidenceProgression="" perQuestionConfidence={[]} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when narrative is whitespace and no sparkline', () => {
    const { container } = render(<ConfidenceArcCard confidenceProgression="   " />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders only the narrative when sparkline data is missing', () => {
    render(<ConfidenceArcCard confidenceProgression="Started shaky, found rhythm by Q3, closed strong." />)
    expect(screen.getByText(/Started shaky/)).toBeInTheDocument()
    expect(screen.queryByLabelText(/sparkline/i)).toBeNull()
  })

  it('renders only the sparkline when narrative is missing', () => {
    render(<ConfidenceArcCard perQuestionConfidence={['low', 'medium', 'high', 'high']} />)
    const sparkline = screen.getByLabelText(/sparkline/i)
    expect(sparkline).toBeInTheDocument()
    expect(sparkline.children).toHaveLength(4)
  })

  it('renders both the narrative and the sparkline when both are present', () => {
    render(
      <ConfidenceArcCard
        confidenceProgression="Started shaky, found rhythm by Q3."
        perQuestionConfidence={['low', 'medium', 'high', 'high']}
      />
    )
    expect(screen.getByText(/Started shaky/)).toBeInTheDocument()
    expect(screen.getByLabelText(/sparkline/i).children).toHaveLength(4)
    expect(screen.getByTestId('confidence-arc-card')).toBeInTheDocument()
  })

  it('renders sparkline bars with distinct heights for high vs medium vs low', () => {
    render(<ConfidenceArcCard perQuestionConfidence={['low', 'medium', 'high']} />)
    const sparkline = screen.getByLabelText(/sparkline/i)
    const bars = Array.from(sparkline.children) as HTMLElement[]
    const heights = bars.map((b) => parseInt(b.style.height, 10))
    expect(heights[0]).toBeLessThan(heights[1])
    expect(heights[1]).toBeLessThan(heights[2])
  })

  it('annotates each sparkline bar with a Q-numbered title for hover discoverability', () => {
    render(<ConfidenceArcCard perQuestionConfidence={['high', 'low']} />)
    const sparkline = screen.getByLabelText(/sparkline/i)
    const bars = Array.from(sparkline.children) as HTMLElement[]
    expect(bars[0].title).toBe('Q1: high')
    expect(bars[1].title).toBe('Q2: low')
  })
})
