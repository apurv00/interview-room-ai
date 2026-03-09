import type { SpeechMetrics } from './types'

// ─── Filler word list ─────────────────────────────────────────────────────────

const FILLER_WORDS = new Set([
  'um', 'uh', 'er', 'ah', 'like', 'you know', 'i mean', 'basically',
  'literally', 'actually', 'sort of', 'kind of', 'right', 'okay so',
  'so yeah', 'anyway', 'whatever', 'stuff', 'things',
])

// ─── Analyze a transcript text segment ────────────────────────────────────────

export function analyzeSpeech(text: string, durationMinutes: number): SpeechMetrics {
  const cleaned = text.trim().toLowerCase()
  const words = cleaned.split(/\s+/).filter(Boolean)
  const totalWords = words.length

  if (totalWords === 0 || durationMinutes === 0) {
    return {
      wpm: 0,
      fillerRate: 0,
      pauseScore: 50,
      ramblingIndex: 0,
      totalWords: 0,
      fillerWordCount: 0,
      durationMinutes,
    }
  }

  // WPM
  const wpm = Math.round(totalWords / durationMinutes)

  // Filler word count — check single words + bigrams
  let fillerWordCount = 0
  for (let i = 0; i < words.length; i++) {
    if (FILLER_WORDS.has(words[i])) {
      fillerWordCount++
    }
    if (i < words.length - 1) {
      const bigram = `${words[i]} ${words[i + 1]}`
      if (FILLER_WORDS.has(bigram)) {
        fillerWordCount++
      }
    }
  }

  const fillerRate = parseFloat((fillerWordCount / totalWords).toFixed(3))

  // Pause score: ideal WPM is 120–160. Penalize too fast (>180) or too slow (<100).
  let pauseScore: number
  if (wpm >= 120 && wpm <= 160) {
    pauseScore = 90
  } else if (wpm > 160 && wpm <= 180) {
    pauseScore = 75
  } else if (wpm > 180) {
    pauseScore = Math.max(30, 75 - (wpm - 180) * 0.5)
  } else if (wpm >= 100) {
    pauseScore = 70
  } else {
    pauseScore = Math.max(20, 50 - (100 - wpm) * 0.5)
  }

  // Rambling index: long answers (>200 words for a single Q) tend to ramble
  // 0 = tight, 1 = very rambling
  const expectedWords = 100 // ~45 second target answer
  const ramblingIndex = parseFloat(
    Math.min(1, Math.max(0, (totalWords - expectedWords) / 200)).toFixed(2)
  )

  return {
    wpm,
    fillerRate,
    pauseScore: Math.round(pauseScore),
    ramblingIndex,
    totalWords,
    fillerWordCount,
    durationMinutes,
  }
}

// ─── Aggregate multiple answer metrics ────────────────────────────────────────

export function aggregateMetrics(metrics: SpeechMetrics[]): SpeechMetrics {
  if (metrics.length === 0) {
    return {
      wpm: 0, fillerRate: 0, pauseScore: 50, ramblingIndex: 0,
      totalWords: 0, fillerWordCount: 0, durationMinutes: 0,
    }
  }

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length

  return {
    wpm: Math.round(avg(metrics.map(m => m.wpm))),
    fillerRate: parseFloat(avg(metrics.map(m => m.fillerRate)).toFixed(3)),
    pauseScore: Math.round(avg(metrics.map(m => m.pauseScore))),
    ramblingIndex: parseFloat(avg(metrics.map(m => m.ramblingIndex)).toFixed(2)),
    totalWords: metrics.reduce((a, m) => a + m.totalWords, 0),
    fillerWordCount: metrics.reduce((a, m) => a + m.fillerWordCount, 0),
    durationMinutes: metrics.reduce((a, m) => a + m.durationMinutes, 0),
  }
}

// ─── Communication dimension score (0–100) ────────────────────────────────────

export function communicationScore(agg: SpeechMetrics): number {
  const wpmPenalty = agg.wpm > 180 ? (agg.wpm - 180) * 0.3 : 0
  const fillerPenalty = agg.fillerRate * 200
  const ramblingPenalty = agg.ramblingIndex * 20

  const raw = 100 - wpmPenalty - fillerPenalty - ramblingPenalty
  return Math.round(Math.max(0, Math.min(100, raw)))
}
