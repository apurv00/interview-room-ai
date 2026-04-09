import type { WhisperSegment, ProsodySegment } from '@shared/types/multimodal'

// ─── Filler Words (reuses list from speechMetrics.ts) ───────────────────────

const FILLER_WORDS_SINGLE = new Set([
  'um', 'uh', 'er', 'ah', 'like',
])

const FILLER_WORDS_BIGRAM = new Set([
  'you know', 'i mean', 'sort of', 'kind of',
])

// Minimum gap between words to count as a pause (seconds)
const PAUSE_THRESHOLD_SEC = 0.5

/**
 * Extract prosody features from Whisper word-level timestamps.
 *
 * @param segments  Whisper transcript segments with word timestamps
 * @param questionBoundaries  Timestamps (seconds) marking the start of each question window.
 *                            Each window runs from questionBoundaries[i] to questionBoundaries[i+1]
 *                            (or end of recording for the last window).
 * @param totalDurationSec  Total recording duration in seconds
 */
export function extractProsody(
  segments: WhisperSegment[],
  questionBoundaries: number[],
  totalDurationSec: number
): ProsodySegment[] {
  // Flatten all words from all segments
  const allWords = segments.flatMap((seg) => seg.words)

  if (allWords.length === 0 || questionBoundaries.length === 0) {
    return []
  }

  // Build time windows from question boundaries
  const windows: Array<{ startSec: number; endSec: number; questionIndex: number }> = []
  for (let i = 0; i < questionBoundaries.length; i++) {
    const start = questionBoundaries[i]
    const end = i < questionBoundaries.length - 1 ? questionBoundaries[i + 1] : totalDurationSec
    windows.push({ startSec: start, endSec: end, questionIndex: i })
  }

  return windows.map((window) => {
    // Get words in this time window
    const windowWords = allWords.filter(
      (w) => w.start >= window.startSec && w.start < window.endSec
    )

    if (windowWords.length === 0) {
      return {
        startSec: window.startSec,
        endSec: window.endSec,
        wpm: 0,
        fillerWords: [],
        pauseDurationSec: 0,
        confidenceMarker: 'low' as const,
        questionIndex: window.questionIndex,
      }
    }

    // WPM: words per minute based on actual speech span
    const speechSpanSec = windowWords[windowWords.length - 1].end - windowWords[0].start
    const wpm = speechSpanSec > 0 ? Math.round((windowWords.length / speechSpanSec) * 60) : 0

    // Filler word detection
    const fillerWords: ProsodySegment['fillerWords'] = []
    for (let i = 0; i < windowWords.length; i++) {
      const word = windowWords[i].word.toLowerCase().replace(/[^a-z]/g, '')

      // Check bigrams first
      if (i < windowWords.length - 1) {
        const nextWord = windowWords[i + 1].word.toLowerCase().replace(/[^a-z]/g, '')
        const bigram = `${word} ${nextWord}`
        if (FILLER_WORDS_BIGRAM.has(bigram)) {
          fillerWords.push({ word: bigram, timestampSec: windowWords[i].start })
          i++ // Skip next word
          continue
        }
      }

      if (FILLER_WORDS_SINGLE.has(word)) {
        fillerWords.push({ word, timestampSec: windowWords[i].start })
      }
    }

    // Pause detection: sum gaps between consecutive words > threshold
    let pauseDurationSec = 0
    for (let i = 1; i < windowWords.length; i++) {
      const gap = windowWords[i].start - windowWords[i - 1].end
      if (gap > PAUSE_THRESHOLD_SEC) {
        pauseDurationSec += gap
      }
    }
    pauseDurationSec = parseFloat(pauseDurationSec.toFixed(2))

    // Confidence marker: derived from pace consistency and filler density
    const fillerRate = windowWords.length > 0 ? fillerWords.length / windowWords.length : 0
    const wpmDeviation = Math.abs(wpm - 140) // ideal WPM ~140
    const pauseRatio = speechSpanSec > 0 ? pauseDurationSec / speechSpanSec : 0

    let confidenceMarker: ProsodySegment['confidenceMarker'] = 'high'
    if (fillerRate > 0.08 || wpmDeviation > 60 || pauseRatio > 0.3) {
      confidenceMarker = 'low'
    } else if (fillerRate > 0.04 || wpmDeviation > 30 || pauseRatio > 0.15) {
      confidenceMarker = 'medium'
    }

    return {
      startSec: window.startSec,
      endSec: window.endSec,
      wpm,
      fillerWords,
      pauseDurationSec,
      confidenceMarker,
      questionIndex: window.questionIndex,
    }
  })
}
