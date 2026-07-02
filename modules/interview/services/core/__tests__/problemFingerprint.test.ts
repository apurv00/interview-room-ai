/**
 * PR "seeded problem generation" — semantic near-duplicate detection.
 *
 * The avoid-list in the generation prompt is advisory; this fingerprint is the
 * post-parse guard that catches "URL Shortener" regenerated as "Design a Link
 * Compression Service"-style renames that keep the load-bearing nouns.
 */
import { describe, it, expect } from 'vitest'
import {
  fingerprintTokens,
  jaccard,
  findNearDuplicate,
} from '../problemFingerprint'

describe('fingerprintTokens', () => {
  it('lowercases, splits on whitespace/hyphens, strips punctuation', () => {
    expect(fingerprintTokens('Rate-Limiter: Sliding Window!')).toEqual(
      new Set(['rate', 'limiter', 'sliding', 'window'])
    )
  })

  it('drops stopwords and short tokens', () => {
    expect(fingerprintTokens('Design a URL Shortener for the Web')).toEqual(
      new Set(['url', 'shortener', 'web'])
    )
  })

  it('merges tags into the token set', () => {
    expect(fingerprintTokens('Two Sum', ['arrays', 'hash-map'])).toEqual(
      new Set(['two', 'sum', 'arrays', 'hash', 'map'])
    )
  })
})

describe('jaccard', () => {
  it('is 1 for identical sets and 0 for disjoint sets', () => {
    const a = new Set(['x', 'y'])
    expect(jaccard(a, new Set(['x', 'y']))).toBe(1)
    expect(jaccard(a, new Set(['z']))).toBe(0)
  })

  it('is 0 when either set is empty', () => {
    expect(jaccard(new Set(), new Set(['x']))).toBe(0)
  })

  it('computes intersection over union', () => {
    // {a,b,c} vs {b,c,d}: 2 shared / 4 total
    expect(jaccard(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']))).toBe(0.5)
  })
})

describe('findNearDuplicate', () => {
  const served = [
    { title: 'Design a URL Shortener' },
    { title: 'Rate Limiter with Sliding Window' },
    { title: undefined },
  ]

  it('flags a renamed variant that keeps the core nouns', () => {
    const hit = findNearDuplicate(
      { title: 'URL Shortener at Scale', tags: [] },
      served
    )
    expect(hit).toEqual({ title: 'Design a URL Shortener' })
  })

  it('passes a genuinely different scenario', () => {
    const hit = findNearDuplicate(
      { title: 'Cohort Retention Aggregator', tags: ['pandas'] },
      served
    )
    expect(hit).toBeNull()
  })

  it('uses tags to catch title-evasive duplicates', () => {
    const hit = findNearDuplicate(
      { title: 'Throttle It', tags: ['rate', 'limiter', 'sliding', 'window'] },
      served
    )
    expect(hit).toEqual({ title: 'Rate Limiter with Sliding Window' })
  })

  it('tags never dilute a plain title match (Codex P2 on #486)', () => {
    // Title-only score vs 'Design a URL Shortener' = {url,shortener}/{url,shortener} = 1.0;
    // the merged title∪tags set alone would score 2/5 = 0.4 and miss.
    const hit = findNearDuplicate(
      { title: 'URL Shortener', tags: ['arrays', 'hash-map', 'strings'] },
      served
    )
    expect(hit).toEqual({ title: 'Design a URL Shortener' })
  })

  it('returns the first (most recent) collision', () => {
    const hit = findNearDuplicate(
      { title: 'URL Shortener Rate Limiter Sliding Window' },
      served,
      0.3
    )
    expect(hit).toEqual({ title: 'Design a URL Shortener' })
  })

  it('handles empty candidate and empty served lists', () => {
    expect(findNearDuplicate({ title: 'a of the' }, served)).toBeNull()
    expect(findNearDuplicate({ title: 'URL Shortener' }, [])).toBeNull()
  })
})
