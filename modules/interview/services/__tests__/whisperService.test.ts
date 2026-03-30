import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock OpenAI
vi.mock('openai', () => ({
  default: class {
    audio = {
      transcriptions: {
        create: vi.fn().mockResolvedValue({
          text: 'Hello, I am a software engineer.',
          duration: 120,
          segments: [
            { id: 0, start: 0, end: 5, text: 'Hello, I am' },
            { id: 1, start: 5, end: 10, text: 'a software engineer.' },
          ],
          words: [
            { word: 'Hello,', start: 0, end: 0.5 },
            { word: 'I', start: 0.6, end: 0.7 },
            { word: 'am', start: 0.8, end: 1.0 },
            { word: 'a', start: 5.0, end: 5.2 },
            { word: 'software', start: 5.3, end: 5.8 },
            { word: 'engineer.', start: 5.9, end: 6.5 },
          ],
        }),
      },
    }
  },
}))

// Mock R2
vi.mock('@shared/storage/r2', () => ({
  getDownloadPresignedUrl: vi.fn().mockResolvedValue('https://example.com/recording.webm'),
}))

// Mock fetch for downloading recording
const mockArrayBuffer = new ArrayBuffer(100)
global.fetch = vi.fn().mockResolvedValue({
  ok: true,
  arrayBuffer: () => Promise.resolve(mockArrayBuffer),
})

vi.mock('@shared/logger', () => ({
  aiLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

import { transcribeRecording } from '../whisperService'

describe('whisperService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('transcribes a recording and returns segments with words', async () => {
    const result = await transcribeRecording('recordings/user1/session1.webm')

    expect(result.segments).toHaveLength(2)
    expect(result.segments[0].text).toBe('Hello, I am')
    expect(result.segments[0].words).toHaveLength(3)
    expect(result.durationSeconds).toBe(120)
    expect(result.costUsd).toBeGreaterThan(0)
  })

  it('computes cost based on duration', async () => {
    const result = await transcribeRecording('recordings/user1/session1.webm')

    // 120 seconds = 2 minutes, at $0.006/min = $0.012
    expect(result.costUsd).toBeCloseTo(0.012, 3)
  })
})
