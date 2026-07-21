import { describe, expect, it } from 'vitest'
import {
  applyOptionIdOf,
  canonicalApplyOptionsOf,
  parseApplyOptionMutation,
  resolveApplyOption,
} from '../services/applyOptionIdentity'

const SOURCE = {
  sourceKey: 'greenhouse:company:123',
  applyUrl: 'https://boards.greenhouse.io/company/jobs/123',
  applyTier: 'direct-ats' as const,
  viaSite: 'Greenhouse',
}

describe('canonical apply-option identity', () => {
  it('is deterministic and opaque while binding source key, URL, and tier', () => {
    const input = { sourceKey: SOURCE.sourceKey, url: SOURCE.applyUrl, tier: SOURCE.applyTier }
    const id = applyOptionIdOf(input)

    expect(id).toMatch(/^ao1_[A-Za-z0-9_-]{43}$/)
    expect(applyOptionIdOf(input)).toBe(id)
    expect(id).not.toContain('greenhouse')
    expect(id).not.toContain('boards')
    expect(applyOptionIdOf({ ...input, sourceKey: 'greenhouse:company:456' })).not.toBe(id)
    expect(applyOptionIdOf({ ...input, url: `${SOURCE.applyUrl}?new=1` })).not.toBe(id)
    expect(applyOptionIdOf({ ...input, tier: 'employer' })).not.toBe(id)
  })

  it('builds and resolves only current safe canonical provenance options', () => {
    const options = canonicalApplyOptionsOf([
      SOURCE,
      SOURCE, // a duplicated provenance tuple is one public option
      { ...SOURCE, sourceKey: '', applyUrl: 'https://example.com/missing-key' },
      { ...SOURCE, sourceKey: 'evil:1', applyUrl: 'javascript:alert(1)' },
      { ...SOURCE, sourceKey: 'private:1', applyUrl: 'http://127.0.0.1/admin' },
      { ...SOURCE, sourceKey: 'metadata:1', applyUrl: 'http://169.254.169.254/latest' },
      { ...SOURCE, sourceKey: 'credentials:1', applyUrl: 'https://user:secret@example.com/apply' },
      { ...SOURCE, sourceKey: 'port:1', applyUrl: 'https://example.com:8443/apply' },
      { ...SOURCE, sourceKey: 'blocklisted:1', applyUrl: 'https://wa.me/919876543210' },
      { ...SOURCE, sourceKey: 'bad-tier:1', applyTier: 'sponsored' },
    ])

    expect(options).toHaveLength(1)
    expect(options[0]).toMatchObject({
      sourceKey: SOURCE.sourceKey,
      url: SOURCE.applyUrl,
      tier: SOURCE.applyTier,
      viaSite: SOURCE.viaSite,
      broken: false,
    })
    expect(resolveApplyOption([SOURCE], options[0].optionId)).toEqual(options[0])
    expect(resolveApplyOption([{ ...SOURCE, applyUrl: 'https://example.com/replaced' }], options[0].optionId)).toBeNull()
    const blockedSource = { ...SOURCE, sourceKey: 'blocklisted:1', applyUrl: 'https://wa.me/919876543210' }
    expect(resolveApplyOption([blockedSource], applyOptionIdOf({
      sourceKey: blockedSource.sourceKey,
      url: blockedSource.applyUrl,
      tier: blockedSource.applyTier,
    }))).toBeNull()
  })

  it('accepts exactly one well-formed optionId and rejects legacy/spoofed mutation fields', () => {
    const optionId = applyOptionIdOf({
      sourceKey: SOURCE.sourceKey,
      url: SOURCE.applyUrl,
      tier: SOURCE.applyTier,
    })
    expect(parseApplyOptionMutation({ optionId })).toEqual({ optionId })

    for (const invalid of [
      null,
      undefined,
      '',
      [],
      {},
      { optionId: '' },
      { optionId: 'ao1_short' },
      { optionId, url: SOURCE.applyUrl },
      { optionId, tier: 'direct-ats' },
      { url: SOURCE.applyUrl, tier: 'direct-ats' },
    ]) {
      expect(parseApplyOptionMutation(invalid)).toBeNull()
    }
  })
})
