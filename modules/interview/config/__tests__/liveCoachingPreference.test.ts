/**
 * Feedback #1 — live-coaching master switch preference.
 *
 * The interview room lets a candidate silence all mid-interview coaching.
 * The choice is a device-wide localStorage flag that must:
 *   1. default to ON (true) when unset/malformed — never silently hide an
 *      advertised feature, and match the SSR default to avoid hydration drift;
 *   2. only treat an explicit 'false' as off;
 *   3. round-trip through write/read;
 *   4. degrade gracefully (return ON, swallow errors) when localStorage throws
 *      (SSR / private browsing / quota).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  LIVE_COACHING_STORAGE_KEY,
  readLiveCoachingPreference,
  writeLiveCoachingPreference,
} from '../liveCoachingPreference'

describe('liveCoachingPreference', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('readLiveCoachingPreference', () => {
    it('defaults to ON when the flag is unset', () => {
      expect(readLiveCoachingPreference()).toBe(true)
    })

    it('returns OFF only for an explicit "false"', () => {
      window.localStorage.setItem(LIVE_COACHING_STORAGE_KEY, 'false')
      expect(readLiveCoachingPreference()).toBe(false)
    })

    it('returns ON for "true"', () => {
      window.localStorage.setItem(LIVE_COACHING_STORAGE_KEY, 'true')
      expect(readLiveCoachingPreference()).toBe(true)
    })

    it('treats any non-"false" value as ON (malformed flag is safe)', () => {
      window.localStorage.setItem(LIVE_COACHING_STORAGE_KEY, 'garbage')
      expect(readLiveCoachingPreference()).toBe(true)
    })

    it('returns ON when localStorage access throws', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('SecurityError: storage disabled')
      })
      expect(readLiveCoachingPreference()).toBe(true)
    })
  })

  describe('writeLiveCoachingPreference', () => {
    it('persists "true" / "false"', () => {
      writeLiveCoachingPreference(false)
      expect(window.localStorage.getItem(LIVE_COACHING_STORAGE_KEY)).toBe('false')
      writeLiveCoachingPreference(true)
      expect(window.localStorage.getItem(LIVE_COACHING_STORAGE_KEY)).toBe('true')
    })

    it('round-trips through read', () => {
      writeLiveCoachingPreference(false)
      expect(readLiveCoachingPreference()).toBe(false)
      writeLiveCoachingPreference(true)
      expect(readLiveCoachingPreference()).toBe(true)
    })

    it('swallows write errors (quota / private browsing)', () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError')
      })
      expect(() => writeLiveCoachingPreference(false)).not.toThrow()
    })
  })
})
