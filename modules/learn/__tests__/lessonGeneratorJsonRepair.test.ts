/**
 * Regression tests for parseLessonJsonWithRepair + repairTruncatedJson.
 *
 * Production diagnosis 2026-05-17 (post-PR #386) — lessons STILL
 * returned 502 after the wrapping fix. Vercel logs showed the new
 * error was "Unexpected end of JSON input" — the LLM was generating
 * VALID JSON shape but running out of tokens mid-output.
 *
 * Primary fix: bump lesson token budgets in lessonBudgets.ts so the
 * model has room to finish (~500-700 tokens needed; was capped at 350).
 *
 * Defence-in-depth: even with bumped budgets, a verbose model could
 * still overflow. parseLessonJsonWithRepair attempts a best-effort
 * close on the truncated JSON before giving up. These tests lock the
 * repair behaviour on the truncation shapes we've seen + variants.
 */

import { describe, it, expect } from 'vitest'
import {
  parseLessonJsonWithRepair,
  repairTruncatedJson,
} from '../services/lessonGenerator'

describe('parseLessonJsonWithRepair', () => {
  it('returns { value, repaired: false } for already-valid JSON', () => {
    const result = parseLessonJsonWithRepair('{"title":"X","n":1}')
    expect(result).toEqual({ value: { title: 'X', n: 1 }, repaired: false })
  })

  it('returns null when input is not even close to valid JSON', () => {
    expect(parseLessonJsonWithRepair('I cannot help with that.')).toBeNull()
  })

  it('repairs JSON truncated mid-array and flags repaired=true (Codex P2 PR #387)', () => {
    // Codex P2 — repaired output must be distinguishable from clean
    // output so generateAndCache can mark it as 'flagged' instead of
    // caching as a fully-successful lesson. The validator alone can't
    // tell — `keyTakeaways` of length 1 passes isValidLesson but is
    // missing 3 trailing items the prompt asked for.
    const truncated = '{"title":"X","keyTakeaways":["a","b"'
    const result = parseLessonJsonWithRepair(truncated)
    expect(result).not.toBeNull()
    expect(result?.repaired).toBe(true)
    const value = result?.value as Record<string, unknown>
    expect(value.title).toBe('X')
    expect(value.keyTakeaways).toEqual(['a', 'b'])
  })

  it('repairs JSON truncated mid-object field (mid-string value)', () => {
    const truncated = '{"title":"X","conceptSummary":"A long incomplete summary that runs'
    const result = parseLessonJsonWithRepair(truncated)
    expect(result?.repaired).toBe(true)
    const value = result?.value as Record<string, unknown>
    expect(value.title).toBe('X')
    expect(value.conceptSummary).toBeUndefined()
  })

  it('repairs JSON truncated immediately after a comma', () => {
    const truncated = '{"a":1,"b":2,'
    const result = parseLessonJsonWithRepair(truncated)
    expect(result?.repaired).toBe(true)
    expect(result?.value).toEqual({ a: 1, b: 2 })
  })

  it('repairs JSON truncated inside a nested object', () => {
    const truncated =
      '{"title":"X","example":{"question":"Q","goodAnswer":"A","annotations":["x","y"'
    const result = parseLessonJsonWithRepair(truncated)
    expect(result?.repaired).toBe(true)
    const value = result?.value as Record<string, unknown>
    expect(value.title).toBe('X')
    expect(value.example).toMatchObject({
      question: 'Q',
      goodAnswer: 'A',
      annotations: ['x', 'y'],
    })
  })
})

describe('repairTruncatedJson', () => {
  it('returns input unchanged when it does not start with {', () => {
    expect(repairTruncatedJson('not json')).toBe('not json')
  })

  it('closes a single open object', () => {
    expect(repairTruncatedJson('{"a":1')).toBe('{"a":1}')
  })

  it('closes object + array together', () => {
    expect(repairTruncatedJson('{"a":[1,2')).toBe('{"a":[1,2]}')
  })

  it('strips trailing comma before closing', () => {
    expect(repairTruncatedJson('{"a":1,')).toBe('{"a":1}')
  })

  it('handles escape sequences inside strings without confusing the state machine', () => {
    // The string contains an escaped quote — the parser must not
    // treat it as a string boundary, otherwise depth tracking is wrong.
    const out = repairTruncatedJson('{"q":"He said \\"hi\\"","next":')
    expect(out).toMatch(/}$/)
  })

  it('closes an unclosed string when no safe boundary exists (Vercel Agent PR #387)', () => {
    // Regression: `{"title":"unfinished` — truncation hits inside the
    // FIRST string value, so lastSafeBoundary stays at -1 (no comma
    // or closing-brace ever seen outside a string). Pre-fix output
    // was `{"title":"unfinished}` (invalid: string never closes).
    // Post-fix output must close the string AND the object.
    const out = repairTruncatedJson('{"title":"unfinished')
    // Must be valid parseable JSON
    expect(() => JSON.parse(out)).not.toThrow()
    const parsed = JSON.parse(out) as { title: string }
    expect(parsed.title).toBe('unfinished')
  })

  it('handles `{"title":"X","conceptSummary":"truncated` (string-in-second-field, has safe boundary)', () => {
    // Counterpart to the test above — when a safe boundary DOES exist,
    // the trim path should engage and the half-written string is
    // dropped entirely (we don't fabricate a closing quote for content
    // we can safely discard).
    const out = repairTruncatedJson('{"title":"X","conceptSummary":"truncated')
    expect(() => JSON.parse(out)).not.toThrow()
    const parsed = JSON.parse(out) as Record<string, unknown>
    expect(parsed.title).toBe('X')
    expect(parsed.conceptSummary).toBeUndefined()
  })
})
