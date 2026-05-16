/**
 * Per-word clarity (ASR-confidence) lookup for transcript rendering.
 *
 * Round 5b feature #4. Whisper emits a confidence score per word; when the
 * confidence is low (the model wasn't sure what was said), it's almost
 * always a mumble signal — the audio was unclear. Surfacing those words
 * visually (dotted underline + reduced opacity) gives the user information
 * they cannot generate themselves: they can't hear their own mumbling, but
 * the ASR can.
 *
 *   Subtle, not alarming. No red — uncertainty, not error.
 *   Tufte: "show the data the user can't generate themselves."
 *
 * Data join problem:
 *   - `data.transcript` is speaker-paired lines with line-level timestamps
 *   - `analysis.whisperTranscript[].words[]` is per-word with confidence
 *     (candidate side only — interviewer audio isn't ASR'd)
 *
 * Approach: build a flat sorted index of whisper words, then for each
 * line walk the line's words and the index pointer in lock-step within
 * the line's [start, end) window. Match by lowercased + punctuation-
 * stripped string; pointer advances on every match so a word repeating
 * in a line maps to its own ASR occurrence rather than both mapping to
 * the first.
 *
 * Imperfect cases (acceptable v1 trade-offs):
 *   - Multi-word whisper tokens like "you know" (rare) — split by
 *     whitespace before matching, so "you" and "know" each get looked up.
 *   - Whisper-side missing words — line word renders normal (no underline).
 *   - Transcript words not in whisper — line word renders normal.
 *
 * Performance: O(n + m) per line (n = line words, m = whisper words in
 * the line window), linear walk. Indexes are bounded by transcript
 * length so this is cheap.
 */

import type { WhisperSegment } from '@shared/types/multimodal'

/** Whisper words below this confidence are styled as "AI heard unclearly". */
export const LOW_CLARITY_THRESHOLD = 0.8

export interface WhisperWordRecord {
  word: string // lowercased + punctuation-stripped
  startSec: number
  confidence: number
}

/**
 * Normalize a token for matching: lowercase, strip leading/trailing
 * punctuation, drop bracketed filler markers (handled separately by the
 * transcript renderer).
 */
export function normalizeToken(s: string): string {
  if (!s) return ''
  // Strip wrapping brackets entirely — they're filler markers, not words.
  const noBrackets = s.replace(/^\[|\]$/g, '')
  return noBrackets
    .toLowerCase()
    .replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '')
}

/**
 * Flatten all whisper segments into a single sorted array. Used as the
 * lookup source for line-level clarity calls. Returns [] when no whisper
 * data exists; callers should treat that as "no clarity info" and render
 * the transcript normally.
 */
export function buildWhisperWordIndex(
  segments: ReadonlyArray<WhisperSegment> | undefined,
): WhisperWordRecord[] {
  if (!segments || segments.length === 0) return []
  const out: WhisperWordRecord[] = []
  for (const seg of segments) {
    if (!seg.words || seg.words.length === 0) continue
    for (const w of seg.words) {
      if (!Number.isFinite(w.start) || !Number.isFinite(w.confidence)) continue
      const norm = normalizeToken(w.word)
      if (!norm) continue
      out.push({ word: norm, startSec: w.start, confidence: w.confidence })
    }
  }
  // Already roughly sorted (segments are time-ordered), but be defensive.
  out.sort((a, b) => a.startSec - b.startSec)
  return out
}

export interface LineWord {
  /** The original token as it appears in the transcript line (with
   *  punctuation, original casing). The renderer uses this verbatim. */
  raw: string
  /** True when this token's normalized form matches a whisper word
   *  inside the line's window with confidence below the threshold. */
  isLowClarity: boolean
}

/**
 * For one transcript line, return a per-token annotation marking which
 * tokens are below the clarity threshold. Pointer-based matching so
 * repeated words in the line align with repeated whisper occurrences.
 *
 * Tokens that aren't found in the whisper index (interviewer lines,
 * out-of-window matches, etc.) are returned with `isLowClarity: false`.
 *
 * @param lineText      The raw transcript line text.
 * @param lineStartSec  The line's start time in seconds (used as the
 *                      lower bound of the search window).
 * @param lineEndSec    The line's end time in seconds (or
 *                      Number.POSITIVE_INFINITY for the last line).
 * @param index         Flat whisper word index from buildWhisperWordIndex.
 * @param threshold     Clarity threshold; defaults to LOW_CLARITY_THRESHOLD.
 */
export function clarityForLine(
  lineText: string,
  lineStartSec: number,
  lineEndSec: number,
  index: ReadonlyArray<WhisperWordRecord>,
  threshold: number = LOW_CLARITY_THRESHOLD,
): LineWord[] {
  // Split the line on whitespace, preserving the raw tokens for rendering.
  // Bracketed filler markers ([uh], [like]) are passed through verbatim
  // — the renderer chips them; we don't want to mark them low-clarity.
  const tokens = lineText.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return []

  // Walk the index forward; for each line token, find the next index
  // entry whose word matches AND falls inside the line's time window.
  let p = 0
  // Skip ahead in the index to the line's window start.
  while (p < index.length && index[p].startSec < lineStartSec) p++

  return tokens.map((raw) => {
    // Filler markers — never flagged as low-clarity here.
    if (raw.startsWith('[') && raw.endsWith(']')) {
      return { raw, isLowClarity: false }
    }
    const norm = normalizeToken(raw)
    if (!norm) return { raw, isLowClarity: false }

    // Linear scan from p forward within the window.
    let q = p
    while (q < index.length && index[q].startSec < lineEndSec) {
      if (index[q].word === norm) {
        const low = index[q].confidence < threshold
        p = q + 1 // advance the pointer past this match
        return { raw, isLowClarity: low }
      }
      q++
    }
    // No match in the window — leave normal.
    return { raw, isLowClarity: false }
  })
}
