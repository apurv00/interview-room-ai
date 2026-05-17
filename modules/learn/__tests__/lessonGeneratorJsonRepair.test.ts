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
  it('returns the parsed object for already-valid JSON', () => {
    const result = parseLessonJsonWithRepair('{"title":"X","n":1}')
    expect(result).toEqual({ title: 'X', n: 1 })
  })

  it('returns null when input is not even close to valid JSON', () => {
    expect(parseLessonJsonWithRepair('I cannot help with that.')).toBeNull()
  })

  it('repairs JSON truncated mid-array (the most common production shape)', () => {
    const truncated = '{"title":"X","keyTakeaways":["a","b"'
    const result = parseLessonJsonWithRepair(truncated) as Record<string, unknown>
    expect(result).toBeTruthy()
    expect(result.title).toBe('X')
    expect(result.keyTakeaways).toEqual(['a', 'b'])
  })

  it('repairs JSON truncated mid-object field (mid-string value)', () => {
    const truncated = '{"title":"X","conceptSummary":"A long incomplete summary that runs'
    const result = parseLessonJsonWithRepair(truncated) as Record<string, unknown>
    expect(result).toBeTruthy()
    expect(result.title).toBe('X')
    // The half-written field is dropped, leaving only the complete prefix
    expect(result.conceptSummary).toBeUndefined()
  })

  it('repairs JSON truncated immediately after a comma', () => {
    const truncated = '{"a":1,"b":2,'
    const result = parseLessonJsonWithRepair(truncated) as Record<string, unknown>
    expect(result).toEqual({ a: 1, b: 2 })
  })

  it('repairs JSON truncated inside a nested object', () => {
    const truncated =
      '{"title":"X","example":{"question":"Q","goodAnswer":"A","annotations":["x","y"'
    const result = parseLessonJsonWithRepair(truncated) as Record<string, unknown>
    expect(result).toBeTruthy()
    expect(result.title).toBe('X')
    expect(result.example).toMatchObject({
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
})
