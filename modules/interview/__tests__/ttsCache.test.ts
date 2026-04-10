// ─── Mocks (before imports) ────────────────────────────────────────────────

const mockSend = vi.fn()

vi.mock('@shared/storage/r2', () => ({
  isR2Configured: vi.fn(() => true),
}))

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send: mockSend })),
  GetObjectCommand: vi.fn(),
  PutObjectCommand: vi.fn(),
}))

vi.mock('@shared/logger', () => ({
  aiLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

import { ttsCacheKey, getCachedTTS, cacheTTS } from '@shared/services/ttsCache'
import { isR2Configured } from '@shared/storage/r2'

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('ttsCache', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isR2Configured).mockReturnValue(true)
    mockSend.mockReset()
  })

  // ── ttsCacheKey ──────────────────────────────────────────────────────────

  describe('ttsCacheKey', () => {
    it('generates deterministic hash — same text yields same key', () => {
      const key1 = ttsCacheKey('Hello world')
      const key2 = ttsCacheKey('Hello world')
      expect(key1).toBe(key2)
    })

    it('different text produces different keys', () => {
      const key1 = ttsCacheKey('Hello world')
      const key2 = ttsCacheKey('Goodbye world')
      expect(key1).not.toBe(key2)
    })

    it('includes encoding in key — mp3 vs opus produce different keys', () => {
      const keyMp3 = ttsCacheKey('Same text', 'mp3')
      const keyOpus = ttsCacheKey('Same text', 'opus')
      expect(keyMp3).not.toBe(keyOpus)
      expect(keyMp3).toContain('.mp3')
      expect(keyOpus).toContain('.opus')
    })

    it('key has expected prefix', () => {
      const key = ttsCacheKey('test')
      expect(key).toMatch(/^tts-cache\//)
    })
  })

  // ── getCachedTTS ─────────────────────────────────────────────────────────

  describe('getCachedTTS', () => {
    it('returns null when R2 is not configured', async () => {
      vi.mocked(isR2Configured).mockReturnValue(false)
      const result = await getCachedTTS('Hello')
      expect(result).toBeNull()
      expect(mockSend).not.toHaveBeenCalled()
    })

    it('returns null on S3 error (cache miss)', async () => {
      mockSend.mockRejectedValue(new Error('NoSuchKey'))
      const result = await getCachedTTS('Hello')
      expect(result).toBeNull()
    })
  })

  // ── cacheTTS ─────────────────────────────────────────────────────────────

  describe('cacheTTS', () => {
    it('does not throw on R2 error', async () => {
      mockSend.mockRejectedValue(new Error('R2 write failed'))
      // Should not throw — errors are swallowed with a warning log
      await expect(cacheTTS('Hello', Buffer.from('audio-data'))).resolves.toBeUndefined()
    })

    it('skips write when R2 is not configured', async () => {
      vi.mocked(isR2Configured).mockReturnValue(false)
      await cacheTTS('Hello', Buffer.from('audio-data'))
      expect(mockSend).not.toHaveBeenCalled()
    })
  })
})
