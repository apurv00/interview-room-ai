/**
 * Azure TTS (feedback #4) — the SSML builder. The XML escaping is the
 * load-bearing, security-relevant part: an interview question containing `<`,
 * `&`, quotes, etc. must be escaped so it cannot break the SSML payload or
 * inject markup into the Azure request.
 */
import { describe, it, expect } from 'vitest'
import { buildSsml } from '../azureTTS'

describe('azureTTS.buildSsml', () => {
  it('wraps text in en-IN speak/voice SSML with the given voice', () => {
    const ssml = buildSsml('Hello there', 'en-IN-NeerjaNeural')
    expect(ssml.startsWith('<speak')).toBe(true)
    expect(ssml.endsWith('</speak>')).toBe(true)
    expect(ssml).toContain("xml:lang='en-IN'")
    expect(ssml).toContain("<voice name='en-IN-NeerjaNeural'>Hello there</voice>")
  })

  it('escapes XML-significant chars so a question cannot break the SSML', () => {
    const ssml = buildSsml('A & B <tag> "q" O\'Brien', 'v')
    expect(ssml).toContain('A &amp; B')
    expect(ssml).toContain('&lt;tag&gt;')
    expect(ssml).toContain('&quot;q&quot;')
    expect(ssml).toContain('O&apos;Brien')
    // No raw markup leaks through, and every '&' is a proper entity.
    expect(ssml).not.toContain('<tag>')
    expect(ssml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/)
  })

  it('defaults the voice when none is passed (uses the configured AZURE_SPEECH_VOICE)', () => {
    const ssml = buildSsml('hi')
    expect(ssml).toMatch(/<voice name='[^']+'>hi<\/voice>/)
  })
})
