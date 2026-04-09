// ─── TOON (Token-Oriented Object Notation) Encoder ──────────────────────────
// Compact tabular encoding of JSON arrays for LLM input. Saves ~30-40% tokens
// on uniform arrays of objects (e.g. evaluations, segments, metrics).
//
// Falls back silently to JSON.stringify if:
// - Data is not an array or is empty
// - Array items are non-uniform (different keys)
// - TOON encoding throws for any reason

import { encode } from '@toon-format/toon'

export interface EncodeResult {
  encoded: string
  format: 'toon' | 'json'
}

/**
 * TOON-encode if data is a non-empty uniform array of objects.
 * Falls back to JSON.stringify for anything else.
 */
export function encodeSafe(data: unknown): EncodeResult {
  if (!Array.isArray(data) || data.length === 0) {
    return { encoded: JSON.stringify(data, null, 0), format: 'json' }
  }

  try {
    const encoded = encode(data)
    return { encoded, format: 'toon' }
  } catch {
    // Non-uniform array, nested objects too deep, or other TOON limitation
    return { encoded: JSON.stringify(data, null, 0), format: 'json' }
  }
}

/**
 * Encode multiple named data arrays. Returns a formatted string block
 * ready to append to an LLM user message.
 *
 * If any array encodes as TOON, prepends a one-line format preamble.
 * Arrays that fail TOON encoding fall back to JSON inline.
 */
export function encodeContextData(
  data: Record<string, unknown>,
): string {
  const entries = Object.entries(data).filter(([, v]) => v != null)
  if (entries.length === 0) return ''

  let usedToon = false
  const blocks: string[] = []

  for (const [label, value] of entries) {
    const result = encodeSafe(value)
    if (result.format === 'toon') usedToon = true

    const displayLabel = label
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, (s) => s.toUpperCase())
      .trim()

    blocks.push(`${displayLabel}:\n${result.encoded}`)
  }

  const preamble = usedToon
    ? '(Structured data below uses TOON format — a compact tabular encoding of JSON.)\n\n'
    : ''

  return '\n\n' + preamble + blocks.join('\n\n')
}
