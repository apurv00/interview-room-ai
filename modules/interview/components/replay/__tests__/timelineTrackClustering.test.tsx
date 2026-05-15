import { describe, it, expect } from 'vitest'
import { clusterByPosition } from '../TimelineTrack'
import type { TimelineEvent } from '@shared/types/multimodal'

function makeEvent(startSec: number, type: TimelineEvent['type'], title = 'evt'): TimelineEvent {
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

describe('clusterByPosition', () => {
  it('returns empty for empty input', () => {
    expect(clusterByPosition([], 100, 1)).toEqual([])
  })

  it('returns empty when totalDurationSec is 0', () => {
    expect(clusterByPosition([makeEvent(10, 'strength')], 0, 1)).toEqual([])
  })

  it('keeps separated events as singleton clusters', () => {
    const events = [
      makeEvent(0, 'strength', 'a'),
      makeEvent(60, 'improvement', 'b'),
      makeEvent(120, 'coaching_tip', 'c'),
    ]
    const clusters = clusterByPosition(events, 200, 1)
    expect(clusters).toHaveLength(3)
    expect(clusters.map((c) => c.length)).toEqual([1, 1, 1])
  })

  it('clusters events with identical startSec (the "8 events, 6 dots" bug fix)', () => {
    // Mirrors the live preview: two cards both at 2:12 stacked on the timeline
    const events = [
      makeEvent(0, 'strength', 'a'),
      makeEvent(132, 'improvement', 'b'),     // 2:12
      makeEvent(132, 'coaching_tip', 'c'),    // 2:12 again
      makeEvent(241, 'strength', 'd'),
    ]
    const clusters = clusterByPosition(events, 339, 1)
    expect(clusters).toHaveLength(3) // a, [b,c], d
    expect(clusters[0]).toHaveLength(1)
    expect(clusters[1]).toHaveLength(2)
    expect(clusters[2]).toHaveLength(1)
    expect(clusters[1].map((e) => e.title)).toEqual(['b', 'c'])
  })

  it('clusters events within the threshold percentage', () => {
    // Total duration 100s; threshold 1% = 1 second of timeline width.
    // Events at 50s and 50.5s are 0.5% apart → cluster.
    // Event at 52s is 2% from 50s → separate.
    const events = [
      makeEvent(50, 'strength', 'a'),
      makeEvent(50.5, 'improvement', 'b'),
      makeEvent(52, 'coaching_tip', 'c'),
    ]
    const clusters = clusterByPosition(events, 100, 1)
    expect(clusters).toHaveLength(2)
    expect(clusters[0].map((e) => e.title)).toEqual(['a', 'b'])
    expect(clusters[1].map((e) => e.title)).toEqual(['c'])
  })

  it('preserves chronological order within each cluster', () => {
    const events = [
      makeEvent(132, 'strength', 'first'),
      makeEvent(132, 'improvement', 'second'),
      makeEvent(133, 'coaching_tip', 'third'),
    ]
    const clusters = clusterByPosition(events, 339, 1)
    // All three within 1% (~3.4s window). Single cluster, in chronological order.
    expect(clusters).toHaveLength(1)
    expect(clusters[0].map((e) => e.title)).toEqual(['first', 'second', 'third'])
  })
})
