import type { SpeechMetrics } from '@shared/types'

export interface CoachingNudge {
  id: string
  message: string
  type: 'pace' | 'filler' | 'length' | 'detail'
  severity: 'info' | 'warning'
}

/**
 * Derive a real-time coaching nudge from live speech metrics.
 * Returns null if no nudge is warranted. Rules are prioritized.
 */
export function deriveNudge(metrics: SpeechMetrics, elapsedSeconds: number): CoachingNudge | null {
  if (metrics.totalWords < 5) return null

  if (metrics.wpm > 180) {
    return {
      id: 'slow-down',
      message: 'Slow down a bit — take a breath between points.',
      type: 'pace',
      severity: 'warning',
    }
  }

  if (metrics.wpm > 0 && metrics.wpm < 100 && elapsedSeconds > 10) {
    return {
      id: 'speed-up',
      message: 'Pick up the pace — add more detail.',
      type: 'pace',
      severity: 'info',
    }
  }

  if (metrics.fillerRate > 0.08) {
    return {
      id: 'fillers',
      message: 'Watch your filler words (um, like, you know).',
      type: 'filler',
      severity: 'warning',
    }
  }

  if (metrics.totalWords > 150) {
    return {
      id: 'wrap-up',
      message: 'Consider wrapping up — keep it concise.',
      type: 'length',
      severity: 'info',
    }
  }

  if (metrics.totalWords < 30 && elapsedSeconds > 30) {
    return {
      id: 'more-detail',
      message: 'Add more detail or a specific example.',
      type: 'detail',
      severity: 'info',
    }
  }

  return null
}
