import { describe, expect, it } from 'vitest'
import {
  clickAgeLabel,
  interviewDateLabel,
  postedAgeLabel,
  practiceProgressLabel,
} from '../config/truthfulLabels'

describe('Jobs truthful labels', () => {
  it('makes freshness claims only from valid, non-future listing dates', () => {
    const now = new Date('2026-07-22T06:30:00.000Z').getTime()
    expect(postedAgeLabel(undefined, now)).toBeNull()
    expect(postedAgeLabel('invalid', now)).toBeNull()
    expect(postedAgeLabel('2026-07-23T00:00:00.000Z', now)).toBeNull()
    expect(postedAgeLabel('2026-07-22T01:00:00.000Z', now)).toBe('Listed today')
    expect(postedAgeLabel('2026-07-21T01:00:00.000Z', now)).toBe('Listed yesterday')
  })

  it('uses IST calendar boundaries for listing dates', () => {
    const now = new Date('2026-07-20T19:00:00.000Z').getTime() // Jul 21 00:30 IST
    expect(postedAgeLabel('2026-07-20T18:00:00.000Z', now)).toBe('Listed yesterday')
  })

  it('renders the supplied click age instead of a seven-day yesterday bucket', () => {
    expect(clickAgeLabel(20)).toBe('20 hours ago')
    expect(clickAgeLabel(24)).toBe('1 day ago')
    expect(clickAgeLabel(72)).toBe('3 days ago')
    expect(clickAgeLabel(Number.NaN)).toBe('less than an hour ago')
  })

  it('keeps exact dates, coarse preferences, and legacy week rows distinct', () => {
    expect(interviewDateLabel('2026-07-30T00:00:00.000Z', 'exact')).toBe('Interview date: 30 Jul 2026')
    expect(interviewDateLabel(undefined, 'week', 'this-week')).toBe('Preferred interview window: this week')
    expect(interviewDateLabel(undefined, 'week', 'next-week')).toBe('Preferred interview window: next week')
    expect(interviewDateLabel('2026-07-24T00:00:00.000Z', 'week')).toBe('Interview week preference saved — exact date not set')
    expect(interviewDateLabel(undefined, 'unknown', 'unknown')).toBe('Exact interview date not set')
  })

  it('labels and bounds only the projected job-specific practice count', () => {
    expect(practiceProgressLabel(-2)).toBe('Job-specific practice completed: 0/3 sessions')
    expect(practiceProgressLabel(2)).toBe('Job-specific practice completed: 2/3 sessions')
    expect(practiceProgressLabel(12)).toBe('Job-specific practice completed: 3/3 sessions')
  })
})
