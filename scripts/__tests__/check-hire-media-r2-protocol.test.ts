import { describe, expect, it, vi } from 'vitest'
import {
  CONFORMANCE_ROOT,
  assertOwnedCanaryKey,
  cleanupCanaries,
  expirationBlockers,
} from '../check-hire-media-r2-protocol.mjs'

describe('Hire media R2 lifecycle audit', () => {
  it('blocks every enabled expiration prefix that can select a v2 seal', () => {
    const blockers = expirationBlockers([
      { ID: 'bucket-wide', Status: 'Enabled', Expiration: { Days: 30 } },
      {
        ID: 'parent',
        Status: 'Enabled',
        Filter: { Prefix: 'hire-media/' },
        Expiration: { Days: 30 },
      },
      {
        ID: 'exact',
        Status: 'Enabled',
        Filter: { Prefix: 'hire-media/v2/' },
        Expiration: { Days: 30 },
      },
      {
        ID: 'child',
        Status: 'Enabled',
        Filter: { And: { Prefix: 'hire-media/v2/a' } },
        Expiration: { Days: 30 },
      },
      {
        ID: 'tag-only-is-conservative',
        Status: 'Enabled',
        Filter: { Tag: { Key: 'temporary', Value: 'true' } },
        Expiration: { Days: 30 },
      },
    ])

    expect(blockers.map(({ id }: { id: string }) => id)).toEqual([
      'bucket-wide',
      'parent',
      'exact',
      'child',
      'tag-only-is-conservative',
    ])
  })

  it('allows disabled, non-expiring, and provably disjoint rules', () => {
    expect(expirationBlockers([
      {
        ID: 'disabled',
        Status: 'Disabled',
        Filter: { Prefix: 'hire-media/v2/' },
        Expiration: { Days: 1 },
      },
      {
        ID: 'transition-only',
        Status: 'Enabled',
        Filter: { Prefix: 'hire-media/v2/' },
        Transitions: [{ Days: 30, StorageClass: 'STANDARD_IA' }],
      },
      {
        ID: 'sibling',
        Status: 'Enabled',
        Filter: { Prefix: 'hire-media/v2-legacy/' },
        Expiration: { Days: 1 },
      },
      {
        ID: 'conformance-only',
        Status: 'Enabled',
        Prefix: 'hire-media-conformance/',
        Expiration: { Days: 1 },
      },
    ])).toEqual([])
  })
})

describe('Hire media R2 canary ownership guard', () => {
  const runPrefix = `${CONFORMANCE_ROOT}123e4567-e89b-42d3-a456-426614174000/`

  it('accepts an object strictly inside the random run prefix', () => {
    expect(() => assertOwnedCanaryKey(
      `${runPrefix}conditional-then-seal`,
      runPrefix,
    )).not.toThrow()
  })

  it.each([
    ['hire-media/v2/' + 'a'.repeat(64), runPrefix],
    [CONFORMANCE_ROOT, CONFORMANCE_ROOT],
    [`${CONFORMANCE_ROOT}another-run/canary`, runPrefix],
    [runPrefix, runPrefix],
    [`${runPrefix}unexpected-canary`, runPrefix],
  ])('rejects an unowned key', (key, prefix) => {
    expect(() => assertOwnedCanaryKey(key, prefix)).toThrow(/Refusing/)
  })
})

describe('Hire media R2 canary cleanup', () => {
  const runPrefix = `${CONFORMANCE_ROOT}123e4567-e89b-42d3-a456-426614174000/`
  const ownedKeys = [
    `${runPrefix}conditional-then-seal`,
    `${runPrefix}seal-then-conditional`,
    `${runPrefix}in-flight-then-seal`,
  ]

  it('deletes and verifies only the three exact owned keys', async () => {
    const deleted = [] as string[]
    const client = {
      send: vi.fn(async (command: { input: { Key: string } }) => {
        deleted.push(command.input.Key)
        return {}
      }),
    }
    const observer = {
      send: vi.fn(async () => {
        throw Object.assign(new Error('not found'), {
          name: 'NotFound',
          $metadata: { httpStatusCode: 404 },
        })
      }),
    }

    await cleanupCanaries(client, observer, 'test-bucket', runPrefix, ownedKeys)

    expect(deleted).toEqual(ownedKeys)
    expect(observer.send).toHaveBeenCalledTimes(3)
  })

  it('refuses a production key before issuing any delete', async () => {
    const client = { send: vi.fn() }
    const observer = { send: vi.fn() }

    await expect(cleanupCanaries(
      client,
      observer,
      'test-bucket',
      runPrefix,
      [`hire-media/v2/${'a'.repeat(64)}`],
    )).rejects.toThrow(/Refusing/)
    expect(client.send).not.toHaveBeenCalled()
    expect(observer.send).not.toHaveBeenCalled()
  })

  it('fails the gate when deletion is not independently observable', async () => {
    const client = { send: vi.fn().mockResolvedValue({}) }
    const observer = { send: vi.fn().mockResolvedValue({ ContentLength: 0 }) }

    await expect(cleanupCanaries(
      client,
      observer,
      'test-bucket',
      runPrefix,
      [ownedKeys[0]],
    )).rejects.toThrow(/Failed to clean every random R2 conformance canary/)
    expect(client.send).toHaveBeenCalledOnce()
    expect(observer.send).toHaveBeenCalledOnce()
  })
})
