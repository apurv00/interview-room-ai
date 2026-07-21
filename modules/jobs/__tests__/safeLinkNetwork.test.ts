import { describe, expect, it, vi } from 'vitest'
import {
  LINK_BODY_CAP_BYTES,
  buildPinnedRequestOptions,
  canonicalizeCheckableLink,
  createSafeLinkRequest,
  isGlobalUnicastAddress,
  readCappedLinkBody,
  type PinnedRequestImpl,
} from '../services/safeLinkNetwork'

const signal = () => new AbortController().signal

describe('safe apply-link URL policy', () => {
  it('canonicalizes credential-free HTTP(S) and explicit default ports', () => {
    expect(canonicalizeCheckableLink('HTTPS://Careers.Example.:443/jobs/1#apply')?.toString())
      .toBe('https://careers.example/jobs/1')
    expect(canonicalizeCheckableLink('http://careers.example:80/jobs/1')?.toString())
      .toBe('http://careers.example/jobs/1')
    expect(canonicalizeCheckableLink('https://[2606:4700:4700::1111]/jobs/1')).not.toBeNull()
  })

  it.each([
    'relative/path',
    'ftp://public.example/job',
    'javascript:alert(1)',
    'http://user:secret@public.example/job',
    'http://localhost/job',
    'http://localhost./job',
    'http://api.localhost./job',
    'http://127.1/job',
    'http://2130706433/job',
    'http://0x7f000001/job',
    'http://017700000001/job',
    'http://[::1]/job',
    'http://[::ffff:7f00:1]/job',
    'http://public.example:22/job',
    'http://public.example:2375/job',
    'http://public.example:3000/job',
    'http://public.example:5432/job',
    'http://public.example:6379/job',
    'http://public.example:8080/job',
    'http://public.example:9200/job',
    'http://public.example:27017/job',
  ])('rejects %s before DNS or connection', (url) => {
    expect(canonicalizeCheckableLink(url)).toBeNull()
  })
})

describe('global-unicast address policy', () => {
  it.each([
    '8.8.8.8',
    '93.184.216.34',
    '2001:4860:4860::8888',
    '2606:4700:4700::1111',
    '::ffff:5db8:d822', // mapped 93.184.216.34
  ])('allows global unicast %s', (address) => {
    expect(isGlobalUnicastAddress(address)).toBe(true)
  })

  it.each([
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '192.168.0.1', '192.0.0.1', '192.0.2.1', '198.18.0.1',
    '198.51.100.1', '203.0.113.1', '224.0.0.1', '239.255.255.250',
    '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fd00::1', 'fe80::1', 'fec0::1', 'ff02::1',
    '100::1', '2001:2::1', '2001:db8::1',
    '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:a9fe:a9fe',
    '::808:808', // deprecated IPv4-compatible transition form
    '64:ff9b::a9fe:a9fe', // NAT64 transition form embedding link-local IPv4
    '2002:a9fe:a9fe::1', // 6to4 transition form embedding link-local IPv4
    '2001:0000:4136:e378:8000:63bf:3fff:fdd2', // Teredo
    '4000::1', // unallocated space outside the IPv6 global-unicast 2000::/3
  ])('rejects non-global or transition address %s', (address) => {
    expect(isGlobalUnicastAddress(address)).toBe(false)
  })
})

describe('resolve-once and pinned-connect boundary', () => {
  it('builds a no-pool connector that preserves Host/SNI/cert checks and returns only the pinned IP', () => {
    const url = new URL('https://careers.example/jobs/1?q=backend')
    const options = buildPinnedRequestOptions(url, { address: '93.184.216.34', family: 4 })
    expect(options).toMatchObject({
      hostname: 'careers.example',
      port: 443,
      path: '/jobs/1?q=backend',
      method: 'GET',
      agent: false,
      family: 4,
      autoSelectFamily: false,
      rejectUnauthorized: true,
      servername: 'careers.example',
    })
    expect(options.headers).toMatchObject({
      Host: 'careers.example',
      'Accept-Encoding': 'identity',
    })

    let chosen: { address?: string; family?: number; error?: Error | null } = {}
    const callback = (error: Error | null, address?: string, family?: number) => {
      chosen = { error, address, family }
    }
    ;(options.lookup as never as (
      hostname: string,
      options: Record<string, unknown>,
      callback: (error: Error | null, address?: string, family?: number) => void,
    ) => void)('careers.example', {}, callback)
    expect(chosen).toEqual({ error: null, address: '93.184.216.34', family: 4 })

    ;(options.lookup as never as (
      hostname: string,
      options: Record<string, unknown>,
      callback: (error: Error | null, address?: string, family?: number) => void,
    ) => void)('rebound.example', {}, callback)
    expect(chosen.error).toMatchObject({ code: 'PINNED_HOSTNAME_MISMATCH' })
  })

  it('passes only the vetted public answer set to the connector and never resolves twice', async () => {
    const resolve = vi.fn()
      // A second call would be the attacker-controlled rebound answer.
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }])
    const requestPinned = vi.fn().mockImplementation(async (
      url: URL,
      address: { address: string; family: number },
    ) => {
      expect(url.hostname).toBe('rebind.example')
      expect(address).toEqual({ address: '93.184.216.34', family: 4 })
      return { status: 200, bodyText: 'Apply now' }
    }) as PinnedRequestImpl
    const request = createSafeLinkRequest({ resolve, requestPinned })

    await expect(request(new URL('https://rebind.example/job'), { signal: signal() }))
      .resolves.toMatchObject({ kind: 'response', status: 200 })
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(requestPinned).toHaveBeenCalledTimes(1)
  })

  it.each([
    [[{ address: '10.0.0.1', family: 4 }]],
    [[{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }]],
    [[{ address: 'ff02::1', family: 6 }]],
    [[{ address: '93.184.216.34', family: 6 }]], // family mismatch
    [[]],
  ])('never connects for a private, mixed, malformed or empty DNS set', async (answers) => {
    const requestPinned = vi.fn()
    const request = createSafeLinkRequest({ resolve: async () => answers as never, requestPinned })
    const result = await request(new URL('https://unsafe-answer.example/job'), { signal: signal() })
    expect(result.kind).toBe('unverifiable')
    expect(requestPinned).not.toHaveBeenCalled()
  })

  it('classifies only authoritative NXDOMAIN as dead evidence; other DNS failures fail closed', async () => {
    const requestPinned = vi.fn()
    const withError = (code: string) => createSafeLinkRequest({
      resolve: async () => { throw Object.assign(new Error(code), { code }) },
      requestPinned,
      dnsTimeoutMs: 10,
    })

    await expect(withError('ENOTFOUND')(new URL('https://gone.example/job'), { signal: signal() }))
      .resolves.toEqual({ kind: 'nxdomain' })
    for (const code of ['ESERVFAIL', 'EAI_AGAIN', 'ETIMEOUT']) {
      await expect(withError(code)(new URL('https://flaky.example/job'), { signal: signal() }))
        .resolves.toMatchObject({ kind: 'unverifiable', code })
    }
    const hanging = createSafeLinkRequest({
      resolve: () => new Promise<never>(() => {}),
      requestPinned,
      dnsTimeoutMs: 5,
    })
    await expect(hanging(new URL('https://lame-dns.example/job'), { signal: signal() }))
      .resolves.toMatchObject({ kind: 'unverifiable', code: 'DNS_TIMEOUT' })
    expect(requestPinned).not.toHaveBeenCalled()
  })

  it('checks posting authority before DNS and again immediately before connect', async () => {
    const resolve = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    const requestPinned = vi.fn()
    const authority = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const request = createSafeLinkRequest({ resolve, requestPinned })

    await expect(request(new URL('https://public.example/job'), {
      signal: signal(),
      beforePhysicalRequest: authority,
    })).resolves.toEqual({ kind: 'authority-changed' })
    expect(authority).toHaveBeenCalledTimes(2)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(requestPinned).not.toHaveBeenCalled()
  })

  it('fails over from a refused vetted address to a live vetted address', async () => {
    const authority = vi.fn().mockResolvedValue(true)
    const requestPinned = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))
      .mockResolvedValueOnce({ status: 200, bodyText: 'Apply now' }) as PinnedRequestImpl
    const request = createSafeLinkRequest({
      resolve: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '8.8.8.8', family: 4 },
      ],
      requestPinned,
    })

    await expect(request(new URL('https://cdn.example/job'), {
      signal: signal(),
      beforePhysicalRequest: authority,
    })).resolves.toMatchObject({ kind: 'response', status: 200 })
    expect(requestPinned.mock.calls.map((call) => call[1])).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '8.8.8.8', family: 4 },
    ])
    expect(authority).toHaveBeenCalledTimes(3) // before DNS + before each socket
  })

  it('returns refused only when every vetted attempt refused; mixed failures stay unverifiable', async () => {
    const answers = async () => [
      { address: '93.184.216.34', family: 4 as const },
      { address: '8.8.8.8', family: 4 as const },
    ]
    const refused = () => Promise.reject(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))
    const allRefused = createSafeLinkRequest({ resolve: answers, requestPinned: vi.fn(refused) })
    await expect(allRefused(new URL('https://refused.example/job'), { signal: signal() }))
      .resolves.toEqual({ kind: 'unverifiable', code: 'ECONNREFUSED' })

    const mixedConnector = vi.fn()
      .mockImplementationOnce(refused)
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))
    const mixed = createSafeLinkRequest({ resolve: answers, requestPinned: mixedConnector })
    await expect(mixed(new URL('https://mixed-failure.example/job'), { signal: signal() }))
      .resolves.toEqual({ kind: 'unverifiable', code: 'ETIMEDOUT' })
  })
})

describe('bounded response handling', () => {
  it('caps by bytes during streaming and tears down at the cap', async () => {
    let reads = 0
    async function* chunks() {
      while (true) {
        reads += 1
        yield Buffer.alloc(64 * 1024, 0x78)
      }
    }
    const onCap = vi.fn()
    const body = await readCappedLinkBody(chunks(), onCap)
    expect(Buffer.byteLength(body)).toBe(LINK_BODY_CAP_BYTES)
    expect(reads).toBe(2)
    expect(onCap).toHaveBeenCalledTimes(1)
  })
})
