import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mergeWithLocalData, readLocalInterviewData, cleanupLocalInterviewData } from '../mergeSessionData'
import type { StoredInterviewData } from '@shared/types'

function makeData(overrides: Partial<StoredInterviewData> = {}): StoredInterviewData {
  return {
    config: { role: 'SWE', experience: '3-6', duration: 10 } as StoredInterviewData['config'],
    transcript: [],
    evaluations: [],
    speechMetrics: [],
    ...overrides,
  }
}

const transcript = [
  { speaker: 'interviewer' as const, text: 'Tell me about yourself', timestamp: 1000 },
  { speaker: 'candidate' as const, text: 'I am a software engineer', timestamp: 2000 },
]

describe('mergeWithLocalData', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns DB data unchanged when transcript is non-empty', () => {
    const dbData = makeData({ transcript })
    const result = mergeWithLocalData(dbData, 'sess-1')
    expect(result).toBe(dbData) // same reference, not merged
  })

  it('merges localStorage data when DB transcript is empty', () => {
    const dbData = makeData({ transcript: [] })
    // Store scoped data
    localStorage.setItem('interviewData:sess-1', JSON.stringify(makeData({ transcript })))

    const result = mergeWithLocalData(dbData, 'sess-1')
    expect(result.transcript).toEqual(transcript)
  })

  it('falls back to unscoped key when scoped key is absent', () => {
    const dbData = makeData({ transcript: [] })
    localStorage.setItem('interviewData', JSON.stringify(makeData({ transcript })))

    const result = mergeWithLocalData(dbData, 'sess-1')
    expect(result.transcript).toEqual(transcript)
  })

  it('prefers scoped key over unscoped key', () => {
    const scopedTranscript = [{ speaker: 'candidate' as const, text: 'scoped', timestamp: 3000 }]
    const unscopedTranscript = [{ speaker: 'candidate' as const, text: 'unscoped', timestamp: 4000 }]

    localStorage.setItem('interviewData:sess-1', JSON.stringify(makeData({ transcript: scopedTranscript })))
    localStorage.setItem('interviewData', JSON.stringify(makeData({ transcript: unscopedTranscript })))

    const dbData = makeData({ transcript: [] })
    const result = mergeWithLocalData(dbData, 'sess-1')
    expect(result.transcript[0].text).toBe('scoped')
  })

  it('returns DB data when localStorage is also empty', () => {
    const dbData = makeData({ transcript: [] })
    const result = mergeWithLocalData(dbData, 'sess-1')
    expect(result.transcript).toEqual([])
  })

  it('does not mutate the original DB data object', () => {
    const dbData = makeData({ transcript: [] })
    localStorage.setItem('interviewData:sess-1', JSON.stringify(makeData({ transcript })))

    const result = mergeWithLocalData(dbData, 'sess-1')
    expect(result).not.toBe(dbData)
    expect(dbData.transcript).toEqual([]) // original unchanged
  })
})

describe('readLocalInterviewData', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns null when nothing stored', () => {
    expect(readLocalInterviewData('sess-1')).toBeNull()
  })

  it('reads scoped key first', () => {
    localStorage.setItem('interviewData:sess-1', JSON.stringify(makeData({ transcript })))
    const result = readLocalInterviewData('sess-1')
    expect(result?.transcript).toEqual(transcript)
  })

  it('reads unscoped key when no session ID provided', () => {
    localStorage.setItem('interviewData', JSON.stringify(makeData({ transcript })))
    const result = readLocalInterviewData()
    expect(result?.transcript).toEqual(transcript)
  })

  it('handles malformed JSON gracefully', () => {
    localStorage.setItem('interviewData:sess-1', 'not json')
    localStorage.setItem('interviewData', JSON.stringify(makeData({ transcript })))
    const result = readLocalInterviewData('sess-1')
    // Falls back to unscoped key
    expect(result?.transcript).toEqual(transcript)
  })
})

describe('cleanupLocalInterviewData', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('removes both scoped and unscoped keys', () => {
    localStorage.setItem('interviewData:sess-1', 'data')
    localStorage.setItem('interviewData', 'data')

    cleanupLocalInterviewData('sess-1')

    expect(localStorage.getItem('interviewData:sess-1')).toBeNull()
    expect(localStorage.getItem('interviewData')).toBeNull()
  })

  it('removes only unscoped key when no session ID', () => {
    localStorage.setItem('interviewData', 'data')

    cleanupLocalInterviewData()

    expect(localStorage.getItem('interviewData')).toBeNull()
  })
})
