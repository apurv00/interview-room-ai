/**
 * Append an incoming Deepgram `is_final` transcript to an accumulating
 * buffer, stripping any word-aligned prefix overlap with the existing
 * tail.
 *
 * Deepgram's streaming endpointer occasionally emits two successive
 * `is_final: true` packets whose transcripts overlap at the seam. E.g.:
 *
 *   final 1 transcript: "Oh,"
 *   final 2 transcript: "Oh, So NorthStar was"
 *   final 3 transcript: "NorthStar was the user."
 *
 * Naive concatenation with a single space produced
 *   "Oh, Oh, So NorthStar was NorthStar was the user."
 * — the doubled-word pattern seen in production session
 * 69e36b369c13dfe7e7ea90a3. This helper finds the longest word-aligned
 * suffix of `existing` that matches the prefix of `incoming` (case-
 * and trailing-punctuation-insensitive), drops that prefix from
 * `incoming`, and appends what remains.
 *
 * Non-overlapping calls are byte-identical to the previous
 * `${existing} ${incoming}` concatenation — the helper only modifies
 * behavior when an overlap actually exists.
 */
export function appendTranscriptWithoutDuplicates(
  existing: string,
  incoming: string,
): string {
  const existingTrimmed = existing.trim()
  const incomingTrimmed = incoming.trim()
  if (!existingTrimmed) return incomingTrimmed
  if (!incomingTrimmed) return existingTrimmed

  const existingWords = existingTrimmed.split(/\s+/)
  const incomingWords = incomingTrimmed.split(/\s+/)
  const maxOverlap = Math.min(existingWords.length, incomingWords.length)

  let overlapLen = 0
  for (let k = maxOverlap; k > 0; k--) {
    const tailStart = existingWords.length - k
    let matches = true
    for (let i = 0; i < k; i++) {
      if (normalizeWord(existingWords[tailStart + i]) !== normalizeWord(incomingWords[i])) {
        matches = false
        break
      }
    }
    if (matches) {
      overlapLen = k
      break
    }
  }

  if (overlapLen === 0) {
    return `${existingTrimmed} ${incomingTrimmed}`
  }

  const remaining = incomingWords.slice(overlapLen)
  if (remaining.length === 0) {
    // Incoming is fully absorbed by the overlap. Two sub-cases:
    //  (A) Incoming matches only a TAIL of existing → existing already
    //      holds the full content, return existing unchanged.
    //  (B) Incoming matches ALL of existing → same utterance, but
    //      Deepgram's later emission typically carries improved casing
    //      and smart_format punctuation ("can you repeat that" →
    //      "Can you repeat that?"). Return incoming so the `?` and
    //      capitalization are preserved. Critical because the hook's
    //      early-question detection (useDeepgramRecognition.ts:475)
    //      fires on `accumulated.endsWith('?')` — dropping the `?` here
    //      would add ~3 s of grace-timer latency to every short
    //      question. Codex review on PR #285.
    if (overlapLen === existingWords.length) {
      return incomingTrimmed
    }
    return existingTrimmed
  }
  return `${existingTrimmed} ${remaining.join(' ')}`
}

/**
 * Tolerant of the two variations Deepgram commonly produces across
 * overlapping finals: case differences ("Oh" vs "oh") and trailing
 * punctuation ("was" vs "was,"). Internal punctuation (apostrophes)
 * is preserved — "don't" ≠ "dont".
 */
function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/[.,!?;:]+$/, '')
}
