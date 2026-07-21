import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Apply-link validation (ruling #22, founder directive 2026-07-16).
 * Invariants: absence of proof is NEVER death (bot-blocks/5xx/timeouts →
 * unverifiable); dead needs a positive signal (404/410, NXDOMAIN,
 * ECONNREFUSED, expiry-200); two strikes ≥20h apart to close and hourly
 * re-checks must not reset the clock; one alive rung keeps a posting
 * alive; SSRF guard rejects private targets before any fetch.
 */

const { mockPostingFind, mockPostingExists, mockPostingUpdateOne, mockCycleCreate } = vi.hoisted(() => ({
  mockPostingFind: vi.fn(),
  mockPostingExists: vi.fn(),
  mockPostingUpdateOne: vi.fn(),
  mockCycleCreate: vi.fn(),
}))
vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@shared/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@shared/services/inngest', () => ({ inngest: { createFunction: vi.fn(() => ({})), send: vi.fn() } }))
vi.mock('@shared/db/models', () => ({
  JobPosting: { find: mockPostingFind, exists: mockPostingExists, updateOne: mockPostingUpdateOne },
  JobIngestCycle: { create: mockCycleCreate },
}))

import { checkApplyLink, LinkCheckAuthorityChangedError, nextApplyCheckState, isCheckableUrl, MIN_RESTRIKE_MS, resolvesToPublicAddress } from '../services/linkCheckService'

// Tests must never hit live DNS: a stub resolver answering a public IP.
const pubResolve = async () => [{ address: '93.184.216.34' }]
import { postingOutcome, runLinkCheckHandler } from '../jobs/linkCheckJobs'

const NOW = new Date('2026-07-16T12:00:00Z')

function fetchStub(status: number, body = ''): typeof fetch {
  return vi.fn().mockResolvedValue({ status, ok: status >= 200 && status < 300, text: async () => body }) as never
}
function fetchThrow(code: string): typeof fetch {
  const err = new Error(code) as Error & { cause: { code: string } }
  err.cause = { code }
  return vi.fn().mockRejectedValue(err) as never
}

describe('checkApplyLink classifier', () => {
  it('404/410 are dead; NXDOMAIN and connection-refused are dead (the vacancy-spam class)', async () => {
    expect(await checkApplyLink('https://x.example/a', fetchStub(404), pubResolve)).toBe('dead')
    expect(await checkApplyLink('https://x.example/a', fetchStub(410), pubResolve)).toBe('dead')
    expect(await checkApplyLink('https://gone.example/a', fetchThrow('ENOTFOUND'), pubResolve)).toBe('dead')
    expect(await checkApplyLink('https://refused.example/a', fetchThrow('ECONNREFUSED'), pubResolve)).toBe('dead')
  })

  it('a 200 body announcing closure is dead — real rot hides behind 200s', async () => {
    expect(await checkApplyLink('https://x.example/a', fetchStub(200, 'This job is no longer accepting applications.'), pubResolve)).toBe('dead')
    expect(await checkApplyLink('https://x.example/a', fetchStub(200, 'Apply now — great role!'), pubResolve)).toBe('alive')
  })

  it('bot-blocks, 5xx, and network timeouts are UNVERIFIABLE — never dead (false-positive safety)', async () => {
    for (const s of [403, 406, 429, 999, 500, 503]) {
      expect(await checkApplyLink('https://ats.example/a', fetchStub(s), pubResolve)).toBe('unverifiable')
    }
    expect(await checkApplyLink('https://slow.example/a', fetchThrow('ETIMEDOUT'), pubResolve)).toBe('unverifiable')
  })

  it('Codex #543 P1: a redirect to a PRIVATE target is never followed — each hop re-passes the SSRF guard', async () => {
    const redirectRes = { status: 302, ok: false, headers: { get: (k: string) => (k === 'location' ? 'http://169.254.169.254/latest/meta-data' : null) }, text: async () => '' }
    const fetchSpy = vi.fn().mockResolvedValue(redirectRes)
    expect(await checkApplyLink('https://public.example/jobs/1', fetchSpy as never, pubResolve)).toBe('unverifiable')
    expect(fetchSpy).toHaveBeenCalledTimes(1) // the private hop was NEVER fetched
  })

  it('a legitimate redirect chain still resolves: public 301 → public 404 = dead', async () => {
    const hop = { status: 301, ok: false, headers: { get: (k: string) => (k === 'location' ? '/careers/closed' : null) }, text: async () => '' }
    const final = { status: 404, ok: false, headers: { get: () => null }, text: async () => '' }
    const fetchSpy = vi.fn().mockResolvedValueOnce(hop).mockResolvedValueOnce(final)
    expect(await checkApplyLink('https://public.example/jobs/1', fetchSpy as never, pubResolve)).toBe('dead')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(String(fetchSpy.mock.calls[1][0])).toBe('https://public.example/careers/closed')
  })

  it('rechecks authority before DNS and HTTP on every redirect hop', async () => {
    const hop = { status: 301, ok: false, headers: { get: () => '/careers/closed' }, text: async () => '' }
    const final = { status: 404, ok: false, headers: { get: () => null }, text: async () => '' }
    const fetchSpy = vi.fn().mockResolvedValueOnce(hop).mockResolvedValueOnce(final)
    const authority = vi.fn().mockResolvedValue(true)

    await expect(checkApplyLink('https://public.example/jobs/1', fetchSpy as never, pubResolve, authority)).resolves.toBe('dead')

    expect(authority).toHaveBeenCalledTimes(4) // DNS + HTTP for both hops
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('a revoke while DNS is in flight blocks the following HTTP request', async () => {
    const fetchSpy = vi.fn()
    const authority = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    await expect(checkApplyLink('https://public.example/jobs/1', fetchSpy as never, pubResolve, authority))
      .rejects.toBeInstanceOf(LinkCheckAuthorityChangedError)

    expect(authority).toHaveBeenCalledTimes(2)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a redirect loop exhausts the hop cap → unverifiable, never dead', async () => {
    const loop = { status: 302, ok: false, headers: { get: (k: string) => (k === 'location' ? 'https://public.example/a' : null) }, text: async () => '' }
    const fetchSpy = vi.fn().mockResolvedValue(loop)
    expect(await checkApplyLink('https://public.example/a', fetchSpy as never, pubResolve)).toBe('unverifiable')
  })

  it('Codex #543 r2: a HOSTNAME resolving to a private address is never fetched (DNS-rebind class)', async () => {
    const spy = vi.fn()
    const privResolve = async () => [{ address: '169.254.169.254' }]
    expect(await checkApplyLink('https://evil-but-public-looking.example/a', spy as never, privResolve)).toBe('unverifiable')
    expect(spy).not.toHaveBeenCalled()
    // Mixed answers: ONE private address poisons the set.
    const mixedResolve = async () => [{ address: '93.184.216.34' }, { address: '10.0.0.5' }]
    expect(await checkApplyLink('https://mixed.example/a', spy as never, mixedResolve)).toBe('unverifiable')
    expect(spy).not.toHaveBeenCalled()
    // v4-mapped v6 private is caught too — dotted AND hex/compressed forms
    // (Codex #543 r3: '::ffff:a9fe:a9fe' bypassed the dotted-only regex).
    const mappedResolve = async () => [{ address: '::ffff:192.168.1.7' }]
    expect(await resolvesToPublicAddress('https://mapped.example/a', mappedResolve)).toBe(false)
    const hexMapped = async () => [{ address: '::ffff:a9fe:a9fe' }] // 169.254.169.254
    expect(await resolvesToPublicAddress('https://hex.example/a', hexMapped)).toBe(false)
    const hexLoop = async () => [{ address: '::ffff:7f00:1' }] // 127.0.0.1
    expect(await resolvesToPublicAddress('https://loop.example/a', hexLoop)).toBe(false)
    const uncompressed = async () => [{ address: '0:0:0:0:0:ffff:a9fe:a9fe' }]
    expect(await resolvesToPublicAddress('https://unc.example/a', uncompressed)).toBe(false)
    const hexPublic = async () => [{ address: '::ffff:5db8:d822' }] // 93.184.216.34
    expect(await resolvesToPublicAddress('https://pub.example/a', hexPublic)).toBe(true)
    // NXDOMAIN fails open — the fetch itself surfaces ENOTFOUND as the dead signal.
    const nxResolve = async () => { throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }) }
    expect(await checkApplyLink('https://gone.example/a', fetchThrow('ENOTFOUND'), nxResolve as never)).toBe('dead')
  })

  it("Codex #543 r2: an unverifiable RESTRIKE keeps status 'dead' — the row must stay in the pick pool", () => {
    const strike1 = nextApplyCheckState(undefined, 'dead', NOW).state
    const later = new Date(NOW.getTime() + MIN_RESTRIKE_MS + 1000)
    const r = nextApplyCheckState(strike1, 'unverifiable', later)
    expect(r.state.status).toBe('dead') // NOT overwritten
    expect(r.state.deadStreak).toBe(1)
    expect(r.state.lastDeadAt).toEqual(strike1.lastDeadAt)
    expect(r.shouldClose).toBe(false)
  })

  it('Codex #543 r4: the body sniff cap binds DURING the read — a huge streaming body is cancelled at the cap', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(64 * 1024))
    let reads = 0
    const cancel = vi.fn()
    const res = {
      status: 200, ok: true,
      body: { getReader: () => ({ read: async () => { reads += 1; return { done: false, value: chunk } }, cancel }) },
      headers: { get: () => null },
      text: async () => { throw new Error('text() must not be used when a stream exists') },
    }
    const outcome = await checkApplyLink('https://big.example/a', vi.fn().mockResolvedValue(res) as never, pubResolve)
    expect(outcome).toBe('alive')
    expect(reads).toBeLessThanOrEqual(3) // 100KB cap / 64KB chunks — never unbounded
    expect(cancel).toHaveBeenCalled()
  })

  it('Codex #543 r4: dead-link closes of unpinned rows enter the 7-day purge lifecycle', async () => {
    // covered in the handler suite below via the purgeAt assertion
    expect(true).toBe(true)
  })

  it('Codex #543 r5: a STALLED DNS lookup is bounded by the preflight timeout — unverifiable, never a hang, never fetched', async () => {
    const spy = vi.fn()
    const hangingResolve = () => new Promise<never>(() => {}) // never settles
    const ok = await resolvesToPublicAddress('https://lame-dns.example/a', hangingResolve as never, 20)
    expect(ok).toBe(false) // cannot verify publicness → refuse the fetch
    expect(spy).not.toHaveBeenCalled()
    // NXDOMAIN still fails OPEN (fetch owns the ENOTFOUND dead signal).
    const nx = async () => { throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }) }
    expect(await resolvesToPublicAddress('https://gone.example/a', nx as never, 20)).toBe(true)
  })

  it('SSRF guard: private/loopback/non-http targets never reach fetch', async () => {
    const spy = vi.fn()
    for (const u of ['http://localhost/x', 'http://127.0.0.1/x', 'http://10.0.0.5/x', 'http://172.20.1.1/x', 'http://192.168.1.1/x', 'http://169.254.1.1/x', 'ftp://x.example/a', 'javascript:alert(1)']) {
      expect(isCheckableUrl(u)).toBe(false)
      expect(await checkApplyLink(u, spy as never, pubResolve)).toBe('unverifiable')
    }
    expect(spy).not.toHaveBeenCalled()
    expect(isCheckableUrl('https://boards.greenhouse.io/x/1')).toBe(true)
  })
})

describe('two-strike close policy', () => {
  it('first dead = streak 1, never a close', () => {
    const r = nextApplyCheckState(undefined, 'dead', NOW)
    expect(r.state.deadStreak).toBe(1)
    expect(r.shouldClose).toBe(false)
  })

  it('a second dead WITHIN 20h neither closes nor resets the clock (hourly re-checks must not push the window)', () => {
    const first = nextApplyCheckState(undefined, 'dead', NOW).state
    const oneHourLater = new Date(NOW.getTime() + 3600_000)
    const r = nextApplyCheckState(first, 'dead', oneHourLater)
    expect(r.shouldClose).toBe(false)
    expect(r.state.deadStreak).toBe(1)
    expect(r.state.lastDeadAt).toEqual(first.lastDeadAt) // clock NOT reset
  })

  it('a second dead ≥20h later closes', () => {
    const first = nextApplyCheckState(undefined, 'dead', NOW).state
    const later = new Date(NOW.getTime() + MIN_RESTRIKE_MS + 1000)
    const r = nextApplyCheckState(first, 'dead', later)
    expect(r.shouldClose).toBe(true)
    expect(r.state.deadStreak).toBe(2)
  })

  it('alive resets the streak; unverifiable only stamps the timestamp', () => {
    const first = nextApplyCheckState(undefined, 'dead', NOW).state
    const alive = nextApplyCheckState(first, 'alive', new Date(NOW.getTime() + 1000))
    expect(alive.state.deadStreak).toBe(0)
    const unv = nextApplyCheckState(first, 'unverifiable', new Date(NOW.getTime() + 1000))
    expect(unv.state.deadStreak).toBe(1)
    expect(unv.shouldClose).toBe(false)
  })
})

describe('postingOutcome', () => {
  it('one alive rung keeps the posting alive; all-dead = dead; mixed dead/unverifiable = unverifiable; none checkable = unverifiable', () => {
    expect(postingOutcome(['dead', 'alive'])).toBe('alive')
    expect(postingOutcome(['dead', 'dead'])).toBe('dead')
    expect(postingOutcome(['dead', 'unverifiable'])).toBe('unverifiable')
    expect(postingOutcome([])).toBe('unverifiable')
  })
})

describe('runLinkCheckHandler', () => {
  const step = { run: <T,>(_n: string, fn: () => Promise<T> | T) => Promise.resolve(fn()) }
  const chain = (docs: unknown[]) => ({
    select: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue({ limit: vi.fn().mockReturnValue({ lean: () => Promise.resolve(docs) }) }),
    }),
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockPostingExists.mockResolvedValue({ _id: 'authorized' })
    mockPostingUpdateOne.mockResolvedValue({ matchedCount: 1 })
    mockCycleCreate.mockResolvedValue({})
  })

  it('a dead-everywhere posting on its SECOND ≥20h strike closes with dead-apply-link, status-guarded; telemetry row written', async () => {
    const doc = {
      _id: 'p1',
      provenance: [{ applyUrl: 'https://dead.example/a' }],
      applyCheck: { status: 'dead', deadStreak: 1, lastCheckedAt: new Date(NOW.getTime() - 25 * 3600_000), lastDeadAt: new Date(NOW.getTime() - 25 * 3600_000) },
    }
    mockPostingFind
      .mockReturnValueOnce(chain([doc])) // reported
      .mockReturnValueOnce(chain([])) // restrikes
      .mockReturnValueOnce(chain([])) // unchecked
      .mockReturnValueOnce(chain([])) // stale unverifiable
      .mockReturnValueOnce(chain([])) // stale alive
    const r = await runLinkCheckHandler(step, fetchThrow('ENOTFOUND'), new Date(), pubResolve, 0)
    expect(r.closed).toBe(1)
    const [filter, update] = mockPostingUpdateOne.mock.calls[0]
    expect(filter).toMatchObject({ _id: 'p1', status: 'open' }) // guarded
    expect((update as { $set: Record<string, unknown> }).$set).toMatchObject({ status: 'closed', closedReason: 'dead-apply-link' })
    // Close first clears every TTL, then current DB pin state determines
    // whether a second conditional write may stamp a new one.
    expect((update as { $unset: Record<string, unknown> }).$unset).toEqual({ purgeAt: 1 })
    expect(mockPostingUpdateOne.mock.calls[1][0]).toMatchObject({ provenance: doc.provenance, userReferenced: true })
    expect(mockPostingUpdateOne.mock.calls[2][0]).toMatchObject({ provenance: doc.provenance, userReferenced: { $ne: true } })
    expect(mockPostingUpdateOne.mock.calls[2][1].$set.purgeAt).toBeInstanceOf(Date)
    expect(mockCycleCreate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'link-check', linkCheck: expect.objectContaining({ checked: 1, dead: 1, closedNow: 1 }) }))
  })

  it('Codex #543 P1: the picker has a restrike bucket — dead rows past the 20h window are re-picked (strike 2 is reachable)', async () => {
    mockPostingFind
      .mockReturnValueOnce(chain([])) // reported
      .mockReturnValueOnce(chain([])) // restrikes
      .mockReturnValueOnce(chain([])) // unchecked
      .mockReturnValueOnce(chain([])) // stale unverifiable
      .mockReturnValueOnce(chain([])) // stale alive
    await runLinkCheckHandler(step, vi.fn() as never, new Date(), pubResolve, 0)
    expect(mockPostingFind).toHaveBeenCalledTimes(5)
    // Codex #543 r3: transient results re-enter the pool.
    const unvFilter = mockPostingFind.mock.calls[3][0] as Record<string, unknown>
    expect(unvFilter['applyCheck.status']).toBe('unverifiable')
    const restrikeFilter = mockPostingFind.mock.calls[1][0] as Record<string, unknown>
    expect(restrikeFilter['applyCheck.status']).toBe('dead')
    expect(restrikeFilter['applyCheck.lastDeadAt']).toBeDefined()
  })

  it('Codex #543 r6: a 4-URL all-dead posting is judged in ONE step — extra URLs never make it uncloseable', async () => {
    const doc = {
      _id: 'p4',
      provenance: [1, 2, 3, 4].map((i) => ({ applyUrl: `https://dead${i}.example/a` })),
      applyCheck: { status: 'dead', deadStreak: 1, lastCheckedAt: new Date(NOW.getTime() - 25 * 3600_000), lastDeadAt: new Date(NOW.getTime() - 25 * 3600_000) },
    }
    mockPostingFind
      .mockReturnValueOnce(chain([doc]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
    const fetchSpy = vi.fn().mockRejectedValue(Object.assign(new Error('nx'), { cause: { code: 'ENOTFOUND' } }))
    const r = await runLinkCheckHandler(step, fetchSpy as never, new Date(), pubResolve, 0)
    expect(fetchSpy).toHaveBeenCalledTimes(4) // ALL urls checked, none sliced away
    expect(r.closed).toBe(1)
  })

  it('Codex #543 r6: the close write carries an optimistic token — a mid-sweep URL refresh voids stale evidence', async () => {
    const prevChecked = new Date(NOW.getTime() - 25 * 3600_000)
    const doc = {
      _id: 'p5',
      provenance: [{ applyUrl: 'https://dead.example/a' }],
      applyCheck: { status: 'dead', deadStreak: 1, lastCheckedAt: prevChecked, lastDeadAt: prevChecked },
    }
    mockPostingFind
      .mockReturnValueOnce(chain([doc]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
    await runLinkCheckHandler(step, fetchThrow('ENOTFOUND'), new Date(), pubResolve, 0)
    const [filter] = mockPostingUpdateOne.mock.calls[0]
    expect((filter as Record<string, unknown>)['applyCheck.lastCheckedAt']).toEqual(prevChecked)
    expect(filter).toMatchObject({ status: 'open', provenance: doc.provenance })
  })

  it('a source revoke between DNS and HTTP aborts the posting with no result write', async () => {
    const provenance = [{ applyUrl: 'https://revoked.example/a', sourceId: 'revoked-source' }]
    const doc = { _id: 'p-revoked', provenance }
    mockPostingFind
      .mockReturnValueOnce(chain([doc]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
    mockPostingExists
      .mockResolvedValueOnce({ _id: 'p-revoked' }) // immediately before DNS
      .mockResolvedValueOnce(null) // revoked before HTTP
    const fetchSpy = vi.fn()

    const result = await runLinkCheckHandler(step, fetchSpy as never, new Date(), pubResolve, 0)

    expect(result).toEqual({ checked: 0, closed: 0 })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(mockPostingUpdateOne).not.toHaveBeenCalled()
    expect(mockPostingExists.mock.calls[0][0]).toMatchObject({
      _id: 'p-revoked',
      status: 'open',
      provenance,
      'provenance.applyUrl': 'https://revoked.example/a',
    })
    expect(mockCycleCreate).toHaveBeenCalledWith(expect.objectContaining({
      linkCheck: expect.objectContaining({ checked: 0, closedNow: 0 }),
    }))
  })

  it('does not stamp TTL or closed telemetry when the optimistic close loses its race', async () => {
    const prevChecked = new Date(NOW.getTime() - 25 * 3600_000)
    const doc = {
      _id: 'p-race',
      provenance: [{ applyUrl: 'https://dead.example/a' }],
      applyCheck: { status: 'dead', deadStreak: 1, lastCheckedAt: prevChecked, lastDeadAt: prevChecked },
    }
    mockPostingFind
      .mockReturnValueOnce(chain([doc]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
    mockPostingUpdateOne.mockResolvedValueOnce({ matchedCount: 0 })

    const result = await runLinkCheckHandler(step, fetchThrow('ENOTFOUND'), new Date(), pubResolve, 0)

    expect(result.closed).toBe(0)
    expect(mockPostingUpdateOne).toHaveBeenCalledTimes(1)
    expect(mockCycleCreate).toHaveBeenCalledWith(expect.objectContaining({
      linkCheck: expect.objectContaining({ closedNow: 0 }),
    }))
  })

  it('blocklisted URLs are skipped entirely — a blocklist-only posting is unverifiable, never fetched', async () => {
    const spy = vi.fn()
    const doc = { _id: 'p2', provenance: [{ applyUrl: 'https://vacancyglobal.up.railway.app/x' }] }
    mockPostingFind
      .mockReturnValueOnce(chain([doc]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
    const r = await runLinkCheckHandler(step, spy as never, new Date(), pubResolve, 0)
    // r3: a malformed stored URL is excluded — outcome derives from checkable rungs only.
    void r
    expect(spy).not.toHaveBeenCalled()
    expect(r.closed).toBe(0)
    const [filter, update] = mockPostingUpdateOne.mock.calls[0]
    expect(filter).toMatchObject({ status: 'open', provenance: doc.provenance })
    expect((update as { $set: { applyCheck: { status: string } } }).$set.applyCheck.status).toBe('unverifiable')
  })
})
