/**
 * Live caption derivation — true word-level rolling window.
 *
 * The previous overlay showed the *entire* active WhisperSegment's text,
 * which (a) made the caption box up to 3 long lines tall and (b) didn't
 * actually feel "live" — the text jumped in chunks at segment boundaries
 * instead of streaming word-by-word with playback.
 *
 * Whisper already gives us word-level timestamps (`WhisperSegment.words`).
 * We flatten them into a single array, take only the words whose
 * `word.start <= currentTimeSec`, and keep the most recent `maxWords` of
 * those. Result: a karaoke-style caption that grows word-by-word and
 * clips at a stable 2 lines.
 *
 * Backward-compat: when a segment's `words` array is empty (older sessions
 * pre-word-level-Whisper), we fall back to the segment's whole `text`
 * for the active segment only — same single-line behavior as the legacy
 * overlay, just without the multi-line bloat.
 */

import type { WhisperSegment } from '@shared/types/multimodal'

export const DEFAULT_LIVE_CAPTION_MAX_WORDS = 25

export function getLiveCaptionText(
  segments: ReadonlyArray<WhisperSegment> | undefined,
  currentTimeSec: number,
  maxWords: number = DEFAULT_LIVE_CAPTION_MAX_WORDS,
): string {
  if (!segments || segments.length === 0) return ''

  // Try the word-level path first.
  const spoken: string[] = []
  let anyWords = false
  for (const seg of segments) {
    if (!seg.words || seg.words.length === 0) continue
    anyWords = true
    for (const w of seg.words) {
      if (w.start > currentTimeSec) {
        // Words are time-ordered within a segment; segments are time-ordered
        // overall — but a later segment might still have an early word if data
        // is malformed, so we don't `break` out of the outer loop.
        break
      }
      spoken.push(w.word)
    }
  }

  if (anyWords) {
    return spoken
      .slice(-maxWords)
      .join(' ')
      .replace(/\s+([,.!?;:])/g, '$1') // pull punctuation tight (Whisper outputs " ," sometimes)
      .trim()
  }

  // Fallback: legacy segment-level. Show the active segment's text (the one
  // we're currently inside). Pre-Round-4 behavior, kept so we don't break
  // sessions recorded before word-level Whisper.
  let active: WhisperSegment | null = null
  for (const seg of segments) {
    if (seg.start <= currentTimeSec) active = seg
    else break
  }
  return active?.text ?? ''
}
