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

import { checkApplyLink, LinkCheckAuthorityChangedError, nextApplyCheckState, isCheckableUrl, MIN_RESTRIKE_MS } from '../services/linkCheckService'
import { createSafeLinkRequest, type LinkRequestImpl, type PinnedRequestImpl } from '../services/safeLinkNetwork'
import { postingOutcome, runLinkCheckHandler } from '../jobs/linkCheckJobs'

const NOW = new Date('2026-07-16T12:00:00Z')

function requestStub(status: number, bodyText = '', location?: string): LinkRequestImpl {
  return vi.fn().mockResolvedValue({ kind: 'response', status, bodyText, location }) as never
}
function unavailableStub(code: string): LinkRequestImpl {
  return vi.fn().mockResolvedValue({ kind: 'unverifiable', code }) as never
}
const nxdomainStub = vi.fn().mockResolvedValue({ kind: 'nxdomain' }) as LinkRequestImpl

// Tests must never hit live DNS: a resolver and connector are always injected.
const publicResolver = async () => [{ address: '93.184.216.34', family: 4 as const }]

describe('checkApplyLink classifier', () => {
  it('404/410 are dead; NXDOMAIN and connection-refused are dead (the vacancy-spam class)', async () => {
    expect(await checkApplyLink('https://x.example/a', requestStub(404))).toBe('dead')
    expect(await checkApplyLink('https://x.example/a', requestStub(410))).toBe('dead')
    expect(await checkApplyLink('https://gone.example/a', nxdomainStub)).toBe('dead')
    expect(await checkApplyLink('https://refused.example/a', unavailableStub('ECONNREFUSED'))).toBe('dead')
  })

  it('a 200 body announcing closure is dead — real rot hides behind 200s', async () => {
    expect(await checkApplyLink('https://x.example/a', requestStub(200, 'This job is no longer accepting applications.'))).toBe('dead')
    expect(await checkApplyLink('https://x.example/a', requestStub(200, 'Apply now — great role!'))).toBe('alive')
  })

  it('bot-blocks, 5xx, and network timeouts are UNVERIFIABLE — never dead (false-positive safety)', async () => {
    for (const s of [403, 406, 429, 999, 500, 503]) {
      expect(await checkApplyLink('https://ats.example/a', requestStub(s))).toBe('unverifiable')
    }
    expect(await checkApplyLink('https://slow.example/a', unavailableStub('ETIMEDOUT'))).toBe('unverifiable')
  })

  it('Codex #543 P1: a redirect to a PRIVATE target is never followed — each hop re-passes the SSRF guard', async () => {
    const requestSpy = vi.fn().mockResolvedValue({ kind: 'response', status: 302, location: 'http://169.254.169.254/latest/meta-data', bodyText: '' })
    expect(await checkApplyLink('https://public.example/jobs/1', requestSpy as never)).toBe('unverifiable')
    expect(requestSpy).toHaveBeenCalledTimes(1) // the private hop was NEVER requested
  })

  it('a legitimate redirect chain still resolves: public 301 → public 404 = dead', async () => {
    const requestSpy = vi.fn()
      .mockResolvedValueOnce({ kind: 'response', status: 301, location: '/careers/closed', bodyText: '' })
      .mockResolvedValueOnce({ kind: 'response', status: 404, bodyText: '' })
    expect(await checkApplyLink('https://public.example/jobs/1', requestSpy as never)).toBe('dead')
    expect(requestSpy).toHaveBeenCalledTimes(2)
    expect(String(requestSpy.mock.calls[1][0])).toBe('https://public.example/careers/closed')
  })

  it('rejects a redirect to a non-default port or HTTPS downgrade before another request', async () => {
    for (const location of ['https://public.example:6379/internal', 'http://public.example/internal']) {
      const requestSpy = requestStub(302, '', location)
      await expect(checkApplyLink('https://public.example/jobs/1', requestSpy)).resolves.toBe('unverifiable')
      expect(requestSpy).toHaveBeenCalledTimes(1)
    }
  })

  it('resolves and pins each redirect host afresh; a private answer stops before the second connect', async () => {
    const resolve = vi.fn(async (hostname: string) => hostname === 'public.example'
      ? [{ address: '93.184.216.34', family: 4 as const }]
      : [{ address: '10.0.0.5', family: 4 as const }])
    const pinnedRequest = vi.fn().mockResolvedValue({
      status: 302,
      location: 'https://private-answer.example/internal',
      bodyText: '',
    }) as PinnedRequestImpl
    const request = createSafeLinkRequest({ resolve, requestPinned: pinnedRequest })

    await expect(checkApplyLink('https://public.example/jobs/1', request)).resolves.toBe('unverifiable')
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(pinnedRequest).toHaveBeenCalledTimes(1)
  })

  it('follows only 301/302/303/307/308 and enforces the five-hop boundary', async () => {
    const unsupported = requestStub(305, '', 'https://public.example/proxy')
    await expect(checkApplyLink('https://public.example/jobs/1', unsupported)).resolves.toBe('unverifiable')
    expect(unsupported).toHaveBeenCalledTimes(1)

    const fiveHops = vi.fn()
    for (let hop = 1; hop <= 5; hop++) {
      fiveHops.mockResolvedValueOnce({ kind: 'response', status: 302, location: `/hop-${hop}`, bodyText: '' })
    }
    fiveHops.mockResolvedValueOnce({ kind: 'response', status: 200, bodyText: 'Apply now' })
    await expect(checkApplyLink('https://public.example/start', fiveHops as never)).resolves.toBe('alive')
    expect(fiveHops).toHaveBeenCalledTimes(6)

    const sixthRedirect = vi.fn()
    for (let hop = 1; hop <= 6; hop++) {
      sixthRedirect.mockResolvedValueOnce({ kind: 'response', status: 302, location: `/too-many-${hop}`, bodyText: '' })
    }
    await expect(checkApplyLink('https://public.example/start', sixthRedirect as never)).resolves.toBe('unverifiable')
    expect(sixthRedirect).toHaveBeenCalledTimes(6)
  })

  it('rechecks authority before DNS and HTTP on every redirect hop', async () => {
    const pinnedRequest = vi.fn()
      .mockResolvedValueOnce({ status: 301, location: '/careers/closed', bodyText: '' })
      .mockResolvedValueOnce({ status: 404, bodyText: '' }) as PinnedRequestImpl
    const request = createSafeLinkRequest({ resolve: publicResolver, requestPinned: pinnedRequest })
    const authority = vi.fn().mockResolvedValue(true)

    await expect(checkApplyLink('https://public.example/jobs/1', request, authority)).resolves.toBe('dead')

    expect(authority).toHaveBeenCalledTimes(4) // DNS + HTTP for both hops
    expect(pinnedRequest).toHaveBeenCalledTimes(2)
  })

  it('a revoke while DNS is in flight blocks the following HTTP request', async () => {
    const pinnedRequest = vi.fn()
    const request = createSafeLinkRequest({ resolve: publicResolver, requestPinned: pinnedRequest })
    const authority = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    await expect(checkApplyLink('https://public.example/jobs/1', request, authority))
      .rejects.toBeInstanceOf(LinkCheckAuthorityChangedError)

    expect(authority).toHaveBeenCalledTimes(2)
    expect(pinnedRequest).not.toHaveBeenCalled()
  })

  it('a redirect loop exhausts the hop cap → unverifiable, never dead', async () => {
    const requestSpy = requestStub(302, '', 'https://public.example/a')
    expect(await checkApplyLink('https://public.example/a', requestSpy)).toBe('unverifiable')
    expect(requestSpy).toHaveBeenCalledTimes(1) // canonical cycle detected before a second request
  })

  it('private or mixed DNS answers never reach the pinned connector', async () => {
    const pinnedRequest = vi.fn()
    const privateRequest = createSafeLinkRequest({
      resolve: async () => [{ address: '169.254.169.254', family: 4 }],
      requestPinned: pinnedRequest,
    })
    const mixedRequest = createSafeLinkRequest({
      resolve: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ],
      requestPinned: pinnedRequest,
    })
    await expect(checkApplyLink('https://private-answer.example/a', privateRequest)).resolves.toBe('unverifiable')
    await expect(checkApplyLink('https://mixed-answer.example/a', mixedRequest)).resolves.toBe('unverifiable')
    expect(pinnedRequest).not.toHaveBeenCalled()
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

  it('Codex #543 r4: dead-link closes of unpinned rows enter the 7-day purge lifecycle', async () => {
    // covered in the handler suite below via the purgeAt assertion
    expect(true).toBe(true)
  })

  it('a stalled DNS lookup is bounded and never reaches the connector', async () => {
    const pinnedRequest = vi.fn()
    const hangingResolve = () => new Promise<never>(() => {}) // never settles
    const request = createSafeLinkRequest({ resolve: hangingResolve, requestPinned: pinnedRequest, dnsTimeoutMs: 20 })
    await expect(checkApplyLink('https://lame-dns.example/a', request)).resolves.toBe('unverifiable')
    expect(pinnedRequest).not.toHaveBeenCalled()
  })

  it('shape gate rejects private/special targets, credentials and non-default ports before networking', async () => {
    const spy = vi.fn()
    for (const u of [
      'http://localhost/x', 'http://localhost./x', 'http://127.0.0.1/x', 'http://10.0.0.5/x',
      'http://172.20.1.1/x', 'http://192.168.1.1/x', 'http://169.254.1.1/x',
      'http://user:password@public.example/x', 'http://public.example:2375/x',
      'https://public.example:8080/x', 'ftp://x.example/a', 'javascript:alert(1)',
    ]) {
      expect(isCheckableUrl(u)).toBe(false)
      expect(await checkApplyLink(u, spy as never)).toBe('unverifiable')
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
    const r = await runLinkCheckHandler(step, nxdomainStub, new Date(), 0)
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
    await runLinkCheckHandler(step, vi.fn() as never, new Date(), 0)
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
    const requestSpy = vi.fn().mockResolvedValue({ kind: 'nxdomain' })
    const r = await runLinkCheckHandler(step, requestSpy as never, new Date(), 0)
    expect(requestSpy).toHaveBeenCalledTimes(4) // ALL urls checked, none sliced away
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
    await runLinkCheckHandler(step, nxdomainStub, new Date(), 0)
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
    const pinnedRequest = vi.fn()
    const request = createSafeLinkRequest({ resolve: publicResolver, requestPinned: pinnedRequest })

    const result = await runLinkCheckHandler(step, request, new Date(), 0)

    expect(result).toEqual({ checked: 0, closed: 0 })
    expect(pinnedRequest).not.toHaveBeenCalled()
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

    const result = await runLinkCheckHandler(step, nxdomainStub, new Date(), 0)

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
    const r = await runLinkCheckHandler(step, spy as never, new Date(), 0)
    // r3: a malformed stored URL is excluded — outcome derives from checkable rungs only.
    void r
    expect(spy).not.toHaveBeenCalled()
    expect(r.closed).toBe(0)
    const [filter, update] = mockPostingUpdateOne.mock.calls[0]
    expect(filter).toMatchObject({ status: 'open', provenance: doc.provenance })
    expect((update as { $set: { applyCheck: { status: string } } }).$set.applyCheck.status).toBe('unverifiable')
  })
})
