/**
 * Tests for the extracted pathway-context URL parser.
 *
 * Pathway P2 Wave 5 — `readPathwaySetupContext` previously lived inside
 * `InterviewSetupForm.tsx` and only the form consumed it. Moving it
 * into a shared util so the Drill page can reuse the same parser is the
 * extraction half; THIS test file is the other half — locks behavior
 * so the original form's flows can't silently regress.
 *
 * `validateReturnTo` is new: it closes a latent open-redirect risk the
 * Plan agent flagged on PR #387 (the original form clamped `returnTo`
 * to 500 chars but never validated the path, so a forged
 * `?returnTo=https://evil.com` would render a Back button that
 * redirected off-domain).
 */

import { describe, it, expect } from 'vitest'
import {
  readPathwaySetupContext,
  validateReturnTo,
} from '../lib/pathwaySetupContext'
import { INTERVIEW_ROLE_SLUG_MAX_CHARS } from '@shared/interviewContract'

function params(map: Record<string, string>): URLSearchParams {
  return new URLSearchParams(map)
}

describe('readPathwaySetupContext', () => {
  it('returns null when source is not "pathway"', () => {
    expect(readPathwaySetupContext(params({ source: 'direct' }))).toBeNull()
    expect(readPathwaySetupContext(params({}))).toBeNull()
    expect(readPathwaySetupContext(null)).toBeNull()
    expect(readPathwaySetupContext(undefined)).toBeNull()
  })

  it('returns shape with source when only the source param is present', () => {
    const ctx = readPathwaySetupContext(params({ source: 'pathway' }))
    expect(ctx?.source).toBe('pathway')
    expect(ctx?.actionId).toBeUndefined()
    expect(ctx?.focus).toBeUndefined()
  })

  it('parses all optional fields when present', () => {
    const ctx = readPathwaySetupContext(
      params({
        source: 'pathway',
        actionId: 'task-1',
        domain: 'pm',
        interviewType: 'behavioral',
        difficulty: 'medium',
        focus: 'communication,structure,specificity',
        returnTo: '/learn/pathway',
      }),
    )
    expect(ctx).toMatchObject({
      source: 'pathway',
      actionId: 'task-1',
      domain: 'pm',
      interviewType: 'behavioral',
      difficulty: 'medium',
      focus: ['communication', 'structure', 'specificity'],
      returnTo: '/learn/pathway',
    })
  })

  it('clamps each field to the documented max length', () => {
    const long = 'x'.repeat(200)
    const ctx = readPathwaySetupContext(
      params({
        source: 'pathway',
        actionId: long, // cap 120
        domain: long,
        difficulty: long, // cap 40
        returnTo: long, // cap 500
      }),
    )
    expect(ctx?.actionId?.length).toBe(120)
    expect(ctx?.domain?.length).toBe(INTERVIEW_ROLE_SLUG_MAX_CHARS)
    expect(ctx?.difficulty?.length).toBe(40)
    expect(ctx?.returnTo?.length).toBe(200) // 200 < 500 cap
  })

  it('preserves an exact-max CMS role through the pathway URL contract', () => {
    const role = 'r'.repeat(INTERVIEW_ROLE_SLUG_MAX_CHARS)
    const ctx = readPathwaySetupContext(params({ source: 'pathway', domain: role }))

    expect(ctx?.domain).toBe(role)
  })

  it('splits focus on commas, trims items, drops empties, caps to 10', () => {
    const ctx = readPathwaySetupContext(
      params({
        source: 'pathway',
        focus: 'a, b , ,c,d,e,f,g,h,i,j,k,l',
      }),
    )
    expect(ctx?.focus).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'])
  })
})

describe('validateReturnTo', () => {
  it('returns null for missing/empty input', () => {
    expect(validateReturnTo(undefined)).toBeNull()
    expect(validateReturnTo(null)).toBeNull()
    expect(validateReturnTo('')).toBeNull()
    expect(validateReturnTo('   ')).toBeNull()
  })

  it('rejects any URL with a protocol (https/http/etc.)', () => {
    expect(validateReturnTo('https://evil.example.com')).toBeNull()
    expect(validateReturnTo('http://evil.example.com')).toBeNull()
    expect(validateReturnTo('javascript://alert(1)')).toBeNull()
  })

  it('rejects protocol-relative URLs (//evil.com/...)', () => {
    expect(validateReturnTo('//evil.example.com/path')).toBeNull()
  })

  it('rejects javascript: and other scheme-less schemes', () => {
    // No leading / so it can't be a same-origin path. Caught by the
    // startsWith('/') check.
    expect(validateReturnTo('javascript:alert(1)')).toBeNull()
    expect(validateReturnTo('data:text/html,<script>')).toBeNull()
  })

  it('rejects same-origin paths that do not match the allowlist', () => {
    expect(validateReturnTo('/some-random-page')).toBeNull()
    expect(validateReturnTo('/admin/secrets')).toBeNull()
  })

  it('accepts allowlisted same-origin paths', () => {
    expect(validateReturnTo('/learn/pathway')).toBe('/learn/pathway')
    expect(validateReturnTo('/feedback/abc123')).toBe('/feedback/abc123')
    expect(validateReturnTo('/interview/setup')).toBe('/interview/setup')
    expect(validateReturnTo('/practice/drill')).toBe('/practice/drill')
    expect(validateReturnTo('/dashboard')).toBe('/dashboard')
  })

  it('accepts query strings + fragments on allowlisted paths', () => {
    expect(validateReturnTo('/learn/pathway?fromFeedback=abc#top')).toBe(
      '/learn/pathway?fromFeedback=abc#top',
    )
  })
})
