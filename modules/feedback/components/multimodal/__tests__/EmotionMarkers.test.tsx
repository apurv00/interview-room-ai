import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import EmotionMarkers from '../EmotionMarkers'
import type { EmotionMarker } from '../emotionChangeMarkers'

describe('EmotionMarkers', () => {
  it('renders nothing when there are no markers', () => {
    const { container } = render(<EmotionMarkers markers={[]} totalDurationSec={600} onSeek={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when totalDurationSec <= 0', () => {
    const markers: EmotionMarker[] = [{ sec: 60, expression: 'smile' }]
    const { container } = render(<EmotionMarkers markers={markers} totalDurationSec={0} onSeek={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders one emoji per marker, positioned by timestamp', () => {
    const markers: EmotionMarker[] = [
      { sec: 150, expression: 'smile' }, // 150/600 = 25%
      { sec: 300, expression: 'focused' }, // 50%
    ]
    render(<EmotionMarkers markers={markers} totalDurationSec={600} onSeek={vi.fn()} />)
    const buttons = screen.getAllByRole('button')
    expect(buttons.length).toBe(2)
    expect(buttons[0]).toHaveStyle({ left: '25%' })
    expect(buttons[0].textContent).toBe('🙂')
    expect(buttons[1].textContent).toBe('🤔')
    // honest hover label with the timestamp
    expect(buttons[0].getAttribute('title')).toContain('2:30')
  })

  it('seeks to the marker timestamp on click', () => {
    const onSeek = vi.fn()
    render(<EmotionMarkers markers={[{ sec: 90, expression: 'frown' }]} totalDurationSec={600} onSeek={onSeek} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onSeek).toHaveBeenCalledWith(90)
  })
})
