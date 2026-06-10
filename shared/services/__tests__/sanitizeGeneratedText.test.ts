import { describe, it, expect } from 'vitest'
import { sanitizeGeneratedText } from '../sanitizeGeneratedText'

// Build special characters from code points so the source stays pure ASCII.
const cjk = String.fromCharCode(0x5177, 0x4f53)   // the CJK word QA found injected
const zwsp = String.fromCharCode(0x200b)          // zero-width space
const bel = String.fromCharCode(0x0007)           // C0 control (BEL)
const fwDollar = String.fromCharCode(0xff04)      // fullwidth dollar sign

describe('sanitizeGeneratedText', () => {
  it('strips a stray CJK ideograph word mid-sentence (the QA glitch)', () => {
    expect(sanitizeGeneratedText('what ' + cjk + ' steps would you take')).toBe('what steps would you take')
  })

  it('strips fullwidth, zero-width, and C0 control characters', () => {
    expect(sanitizeGeneratedText('a' + zwsp + 'b')).toBe('ab')
    expect(sanitizeGeneratedText('a' + bel + 'b')).toBe('ab')
    expect(sanitizeGeneratedText('price' + fwDollar + '100')).toBe('price100')
  })

  it('preserves newlines, tabs, and normal punctuation', () => {
    expect(sanitizeGeneratedText('line1\nline2\twords, ok.')).toBe('line1\nline2\twords, ok.')
  })

  it('leaves clean English text unchanged', () => {
    const s = 'Design a rate limiter for the API.'
    expect(sanitizeGeneratedText(s)).toBe(s)
  })

  it('returns empty string for non-string input', () => {
    expect(sanitizeGeneratedText(undefined)).toBe('')
    expect(sanitizeGeneratedText(null)).toBe('')
    expect(sanitizeGeneratedText(42)).toBe('')
    expect(sanitizeGeneratedText({ a: 1 })).toBe('')
  })
})
