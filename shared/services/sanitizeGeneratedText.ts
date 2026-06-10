/**
 * Strip stray non-English glyphs and control characters that occasionally leak
 * from LLM generation (the QA matrix found a stray CJK word mid-sentence in a
 * generated question). The product runs English interviews, so removing CJK /
 * fullwidth / control / zero-width characters is safe; printable Latin text and
 * standard whitespace (tab, newline, carriage return) are preserved.
 *
 * The character class is built from numeric code-point ranges so no literal
 * CJK or control characters appear in this source file.
 */
const STRAY_RANGES: Array<[number, number]> = [
  [0x3000, 0x303f], // CJK symbols & punctuation
  [0x3040, 0x30ff], // hiragana + katakana
  [0x3400, 0x4dbf], // CJK ext-A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xff00, 0xffef], // fullwidth / halfwidth forms
  [0x200b, 0x200d], // zero-width space / joiners
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
  [0x0000, 0x0008], // C0 control (keep \t=09, \n=0a, \r=0d)
  [0x000b, 0x000c],
  [0x000e, 0x001f],
]

const hex = (n: number) => '\\u' + n.toString(16).padStart(4, '0')
const STRAY = new RegExp('[' + STRAY_RANGES.map(([a, b]) => `${hex(a)}-${hex(b)}`).join('') + ']', 'g')

export function sanitizeGeneratedText(input: unknown): string {
  if (typeof input !== 'string') return ''
  return input
    .replace(STRAY, '')
    .replace(/[ \t]{2,}/g, ' ')          // collapse gaps left by removed glyphs
    .replace(/\s+([,.!?;:])/g, '$1')     // tidy any space-before-punctuation
    .trim()
}
