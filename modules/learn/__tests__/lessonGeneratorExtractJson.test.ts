/**
 * Regression tests for `extractJsonObject` in lessonGenerator.
 *
 * Production diagnosis 2026-05-17 — every lesson on /learn/pathway
 * returned 502 because the model occasionally wraps its JSON output
 * in prose or fence variants that the previous strip-regex couldn't
 * handle, JSON.parse threw SyntaxError, and getOrGenerateLesson
 * returned null. Vercel runtime logs confirmed the error message
 * contained "SyntaxError" + "position" — classic JSON.parse failure.
 *
 * These tests lock the parser's behaviour on every wrapping shape we
 * know production models actually emit.
 */

import { describe, it, expect } from 'vitest'
import { extractJsonObject } from '../services/lessonGenerator'

describe('extractJsonObject', () => {
  it('passes through bare JSON unchanged', () => {
    const input = '{"title":"X"}'
    expect(extractJsonObject(input)).toBe(input)
  })

  it('strips a leading ```json fence', () => {
    const input = '```json\n{"title":"X"}\n```'
    expect(extractJsonObject(input)).toBe('{"title":"X"}')
  })

  it('strips a leading ``` fence with no language hint', () => {
    const input = '```\n{"title":"X"}\n```'
    expect(extractJsonObject(input)).toBe('{"title":"X"}')
  })

  it('handles fences with extra surrounding whitespace', () => {
    const input = '   ```json   \n{"title":"X"}\n   ```   '
    expect(extractJsonObject(input)).toBe('{"title":"X"}')
  })

  it('handles a missing trailing newline before the fence', () => {
    const input = '```json\n{"title":"X"}```'
    expect(extractJsonObject(input)).toBe('{"title":"X"}')
  })

  it('extracts JSON from prose-wrapped output (the production failure mode)', () => {
    const input = `Here is the lesson you requested:

{"title":"Sharpen STAR","conceptSummary":"…"}

Hope this helps!`
    const out = extractJsonObject(input)
    expect(out.startsWith('{')).toBe(true)
    expect(out.endsWith('}')).toBe(true)
    expect(JSON.parse(out)).toMatchObject({ title: 'Sharpen STAR' })
  })

  it('extracts JSON from prose + fenced output (worst-case combination)', () => {
    const input = `Sure, here you go:

\`\`\`json
{"title":"Sharpen STAR","conceptSummary":"…"}
\`\`\`

Let me know if you need anything else.`
    // Fence strip removes the FRONT fence; the trailing prose still wraps
    // the closer. Verify the balanced-brace fallback handles this.
    const out = extractJsonObject(input)
    expect(JSON.parse(out)).toMatchObject({ title: 'Sharpen STAR' })
  })

  it('handles uppercase JSON fence hint', () => {
    const input = '```JSON\n{"title":"X"}\n```'
    expect(extractJsonObject(input)).toBe('{"title":"X"}')
  })

  it('returns the raw string when no { is present (caller decides what to do)', () => {
    // Lets JSON.parse fail downstream with a useful error, and the catch
    // block in generateLessonContent logs the raw text for debugging.
    const input = 'I cannot help with that request.'
    expect(extractJsonObject(input)).toBe('I cannot help with that request.')
  })

  it('handles JSON containing nested objects (first-{ to last-} cut is safe)', () => {
    const input = `Sure:
{"title":"X","example":{"question":"Q","goodAnswer":"A","annotations":["x"]}}
Done.`
    const out = extractJsonObject(input)
    expect(JSON.parse(out)).toMatchObject({
      title: 'X',
      example: { question: 'Q' },
    })
  })
})
