export interface FillerWordInput {
  word: string
  start?: number
  end?: number
  isFiller?: boolean
}

export interface FillerOccurrence {
  word: string
  index: number
  timestampSec?: number
}

export interface FillerMetricsResult {
  totalWords: number
  fillerWordCount: number
  fillerRate: number
  fillerWords: FillerOccurrence[]
}

const FILLER_WORDS_SINGLE = new Set([
  'um', 'uh', 'er', 'ah',
])

const FILLER_WORDS_BIGRAM = new Set([
  'you know', 'i mean', 'sort of', 'kind of',
])

const LIKE_PAUSE_THRESHOLD_SEC = 0.35

function normalizeWord(word: string): string {
  return word
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '')
}

function wordsFromText(text: string): FillerWordInput[] {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => ({ word }))
}

function hasTrailingFillerPunctuation(rawWord: string): boolean {
  return /[,;:!?]$|\.{2,}$/.test(rawWord.trim())
}

function hasTiming(word: FillerWordInput): word is FillerWordInput & { start: number; end: number } {
  return Number.isFinite(word.start) && Number.isFinite(word.end)
}

function isContextualLikeFiller(words: FillerWordInput[], index: number): boolean {
  const current = words[index]
  if (normalizeWord(current.word) !== 'like') return false
  if (current.isFiller === true) return true
  if (hasTrailingFillerPunctuation(current.word)) return true

  const prev = words[index - 1]
  const next = words[index + 1]

  if (prev && normalizeWord(prev.word) === 'i') return true
  if (next && FILLER_WORDS_SINGLE.has(normalizeWord(next.word))) return true

  if (hasTiming(current)) {
    const pauseBefore = prev && hasTiming(prev) ? current.start - prev.end : 0
    const pauseAfter = next && hasTiming(next) ? next.start - current.end : 0
    return pauseBefore >= LIKE_PAUSE_THRESHOLD_SEC || pauseAfter >= LIKE_PAUSE_THRESHOLD_SEC
  }

  return false
}

export function computeFillerMetrics(input: string | FillerWordInput[]): FillerMetricsResult {
  const words = (typeof input === 'string' ? wordsFromText(input) : input)
    .map((word) => ({
      ...word,
      normalized: normalizeWord(word.word),
    }))
    .filter((word) => word.normalized)

  const fillerWords: FillerOccurrence[] = []

  for (let i = 0; i < words.length; i++) {
    const word = words[i]

    if (i < words.length - 1) {
      const nextWord = words[i + 1]
      const bigram = `${word.normalized} ${nextWord.normalized}`
      if (FILLER_WORDS_BIGRAM.has(bigram)) {
        fillerWords.push({
          word: bigram,
          index: i,
          ...(typeof word.start === 'number' ? { timestampSec: word.start } : {}),
        })
        i++
        continue
      }
    }

    if (
      word.isFiller === true ||
      FILLER_WORDS_SINGLE.has(word.normalized) ||
      isContextualLikeFiller(words, i)
    ) {
      fillerWords.push({
        word: word.normalized,
        index: i,
        ...(typeof word.start === 'number' ? { timestampSec: word.start } : {}),
      })
    }
  }

  const totalWords = words.length
  const fillerWordCount = fillerWords.length
  const fillerRate = totalWords > 0
    ? parseFloat((fillerWordCount / totalWords).toFixed(3))
    : 0

  return {
    totalWords,
    fillerWordCount,
    fillerRate,
    fillerWords,
  }
}
