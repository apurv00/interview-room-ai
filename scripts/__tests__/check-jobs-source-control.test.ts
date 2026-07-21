import { describe, expect, it } from 'vitest'
import {
  admissionStateIsConsistent,
  controlSequenceIsConsistent,
  invalidSourceLineageFilter,
  validateAuditHistory,
} from '../check-jobs-source-control'
import {
  hasSafeExactIndex,
  hasSingleSafeNamedIndex,
} from '../jobs-source-control-index-policy'

describe('jobs source-control deploy gate', () => {
  const revoke = (revision: number, overrides: Record<string, unknown> = {}) => ({
    action: 'revoke',
    previousRevision: revision - 1,
    revision,
    from: { enabled: true, health: 'active' },
    to: { enabled: false, health: 'revoked' },
    ...overrides,
  })
  const restore = (revision: number, overrides: Record<string, unknown> = {}) => ({
    action: 'restore',
    previousRevision: revision - 1,
    revision,
    from: { enabled: false, health: 'revoked' },
    to: { enabled: false, health: 'quarantined' },
    ...overrides,
  })

  it('accepts only an exact match between the global marker and permanent audit count', () => {
    expect(controlSequenceIsConsistent({ controlWriteSeq: 4 }, 4)).toBe(true)
    expect(controlSequenceIsConsistent({ controlWriteSeq: 3 }, 4)).toBe(false)
    expect(controlSequenceIsConsistent({ controlWriteSeq: 5 }, 4)).toBe(false)
    expect(controlSequenceIsConsistent(null, 0)).toBe(false)
  })

  it('accepts admission state only with a nonnegative integer sequence and exact corpus count', () => {
    expect(admissionStateIsConsistent(
      { ingestWriteSeq: 7, retainedPostings: 19_999 },
      19_999,
    )).toBe(true)
    expect(admissionStateIsConsistent(
      { ingestWriteSeq: -1, retainedPostings: 19_999 },
      19_999,
    )).toBe(false)
    expect(admissionStateIsConsistent(
      { ingestWriteSeq: 1.5, retainedPostings: 19_999 },
      19_999,
    )).toBe(false)
    expect(admissionStateIsConsistent(
      { ingestWriteSeq: Number.MAX_SAFE_INTEGER, retainedPostings: 19_999 },
      19_999,
    )).toBe(false)
    expect(admissionStateIsConsistent(
      { ingestWriteSeq: 7, retainedPostings: 20_000 },
      19_999,
    )).toBe(false)
    expect(admissionStateIsConsistent(null, 0)).toBe(false)
  })

  it('accepts a complete alternating history and post-restore state evolution', () => {
    expect(validateAuditHistory([
      revoke(1),
      restore(2),
      revoke(3, { from: { enabled: true, health: 'degraded' } }),
      restore(4),
    ])).toEqual({ valid: true, invalidTransitions: 0 })
  })

  it('accepts adoption of an epoch-zero legacy revocation', () => {
    expect(validateAuditHistory([
      revoke(1, { from: { enabled: false, health: 'revoked' } }),
    ])).toEqual({ valid: true, invalidTransitions: 0 })
  })

  it.each([
    ['a negative first revision hidden behind a valid head', [
      revoke(-1, { previousRevision: -2 }),
      restore(2),
      revoke(3),
    ]],
    ['a missing middle revision', [revoke(1), revoke(3)]],
    ['wrong previous revision', [revoke(1), restore(2, { previousRevision: 0 })]],
    ['wrong parity and repeated action', [revoke(1), revoke(2)]],
    ['invalid revoke destination', [
      revoke(1, { to: { enabled: false, health: 'quarantined' } }),
    ]],
    ['invalid restore destination', [
      revoke(1),
      restore(2, { to: { enabled: true, health: 'active' } }),
    ]],
    ['restore not continuous with the revoked destination', [
      revoke(1),
      restore(2, { from: { enabled: true, health: 'revoked' } }),
    ]],
    ['later revoke originating from revoked', [
      revoke(1),
      restore(2),
      revoke(3, { from: { enabled: false, health: 'revoked' } }),
    ]],
    ['malformed state snapshot', [
      revoke(1, { from: { enabled: 'yes', health: 'active' } }),
    ]],
  ])('rejects a permanent history with %s', (_name, history) => {
    const result = validateAuditHistory(history)
    expect(result.valid).toBe(false)
    expect(result.invalidTransitions).toBeGreaterThan(0)
  })

  it('fails the gate for non-array, empty, non-string, or noncanonical source lineage', () => {
    const filter = JSON.stringify(invalidSourceLineageFilter())

    expect(filter).toContain('$isArray')
    expect(filter).toContain('$allElementsTrue')
    expect(filter).toContain('$type')
    expect(filter).toContain('$regexMatch')
  })

  it.each([
    ['partial', { partialFilterExpression: { status: 'open' } }],
    ['sparse', { sparse: true }],
    ['hidden', { hidden: true }],
    ['collated', { collation: { locale: 'en' } }],
    ['TTL', { expireAfterSeconds: 60 }],
  ])('rejects a key-identical %s legal index', (_name, unsafeOption) => {
    expect(hasSafeExactIndex(
      { key: { sourceIds: 1 }, ...unsafeOption },
      [['sourceIds', 1]],
      false,
    )).toBe(false)
  })

  it('requires one safe same-key index with the stable runtime name', () => {
    expect(hasSingleSafeNamedIndex(
      [{ name: 'sourceIds_1', key: { sourceIds: 1 } }],
      [['sourceIds', 1]],
      false,
      'sourceIds_1',
    )).toBe(true)

    expect(hasSingleSafeNamedIndex(
      [
        { name: 'sourceIds_1', key: { sourceIds: 1 } },
        { name: 'legacy_sourceIds_sparse', key: { sourceIds: 1 }, sparse: true },
      ],
      [['sourceIds', 1]],
      false,
      'sourceIds_1',
    )).toBe(false)

    expect(hasSingleSafeNamedIndex(
      [{ name: 'legacy_sourceIds', key: { sourceIds: 1 } }],
      [['sourceIds', 1]],
      false,
      'sourceIds_1',
    )).toBe(false)
  })
})
