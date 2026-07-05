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
  // Strips only LEADING/TRAILING non-alphanumerics — internal hyphens survive,
  // so Deepgram backchannels like "uh-huh"/"mm-hmm" reach canonicalFiller intact.
  return word
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '')
}

/**
 * Canonicalize a normalized token to a filler word, folding the elongated and
 * variant spellings STT actually emits (umm, uhh, uhm, hmm, mhm, uh-huh, …).
 * Returns the canonical filler ('um' | 'uh' | 'er' | 'ah' | 'hmm' | 'mhm' |
 * 'uh-huh' | 'uh-uh') or null when the token is not a filler.
 *
 * Why: the counter runs over the Deepgram transcript, which carries fillers
 * (filler_words=true; smart_format is on but does NOT strip them). The base
 * lexicon only matched {um, uh, er, ah}, so the elongated/variant spellings a
 * real transcript carries ("umm"/"uhh"/"uhm"/"hmm"/"mhm"/"uh-huh") slipped
 * through — that was the reported undercount. Folding them to a canonical form
 * both counts them AND groups the per-moment chips (umm + um → "um").
 */
function canonicalFiller(normalized: string): string | null {
  if (!normalized) return null
  if (FILLER_WORDS_SINGLE.has(normalized)) return normalized
  // Deepgram hyphenated backchannels (internal hyphen survives normalizeWord).
  if (/^uh-huh$/.test(normalized)) return 'uh-huh'
  if (/^(uh-uh|nuh-uh)$/.test(normalized)) return 'uh-uh'
  if (/^mm-?hmm?$/.test(normalized) || /^m+h+m*$/.test(normalized)) return 'mhm'
  // Elongated single-token fillers.
  if (/^u+h+m+$/.test(normalized)) return 'um'   // uhm, uhmm → um
  if (/^u+m+$/.test(normalized)) return 'um'      // um, umm, ummm
  if (/^u+h+$/.test(normalized)) return 'uh'      // uh, uhh, uhhh
  if (/^e+r+m*$/.test(normalized)) return 'er'    // er, err, erm
  if (/^a+h+$/.test(normalized)) return 'ah'      // ah, ahh
  if (/^h+m+$/.test(normalized)) return 'hmm'     // hm, hmm, hmmm
  return null
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
  if (next && canonicalFiller(normalizeWord(next.word)) !== null) return true

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

    const canonical = canonicalFiller(word.normalized)
    if (
      word.isFiller === true ||
      canonical !== null ||
      isContextualLikeFiller(words, i)
    ) {
      fillerWords.push({
        // Canonical form ('umm'/'uhm' → 'um') so per-moment chips group cleanly;
        // fall back to the raw token for Deepgram-flagged (isFiller) words we
        // don't otherwise recognize.
        word: canonical ?? word.normalized,
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
