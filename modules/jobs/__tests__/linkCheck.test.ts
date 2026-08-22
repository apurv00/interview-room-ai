import { createHash } from 'crypto'
import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Apply-link validation (ruling #22, founder directive 2026-07-16).
 * Invariants: absence of proof is NEVER death (bot-blocks/5xx/timeouts →
 * unverifiable); dead needs a positive signal (404/410, NXDOMAIN,
 * ECONNREFUSED, expiry-200); two strikes ≥20h apart to close and hourly
 * re-checks must not reset the clock; one alive rung keeps a posting
 * alive; SSRF guard rejects private targets before any fetch.
 */

const {
  mockPostingFind,
  mockPostingExists,
  mockPostingUpdateOne,
  mockSourceFind,
  mockCycleCreate,
  mockFenceQualityDecisionSources,
  mockRecordAutomaticQualityDecision,
  mockWithQualityDecisionTransaction,
} = vi.hoisted(() => ({
  mockPostingFind: vi.fn(),
  mockPostingExists: vi.fn(),
  mockPostingUpdateOne: vi.fn(),
  mockSourceFind: vi.fn(),
  mockCycleCreate: vi.fn(),
  mockFenceQualityDecisionSources: vi.fn(),
  mockRecordAutomaticQualityDecision: vi.fn(),
  mockWithQualityDecisionTransaction: vi.fn(),
}))
vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@shared/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@shared/services/inngest', () => ({ inngest: { createFunction: vi.fn(() => ({})), send: vi.fn() } }))
vi.mock('@shared/db/models', () => ({
  JOB_SOURCE_LINEAGE_UNKNOWN: '__legacy_unknown__',
  JobPosting: { find: mockPostingFind, exists: mockPostingExists, updateOne: mockPostingUpdateOne },
  JobSourceConfig: { find: mockSourceFind },
  JobIngestCycle: { create: mockCycleCreate },
}))
vi.mock('../services/qualityDecisionService', () => ({
  fenceQualityDecisionSources: mockFenceQualityDecisionSources,
  recordAutomaticQualityDecision: mockRecordAutomaticQualityDecision,
  withQualityDecisionTransaction: mockWithQualityDecisionTransaction,
}))

import { checkApplyLink, LinkCheckAuthorityChangedError, nextApplyCheckState, nextClosedApplyCheckState, isCheckableUrl, MIN_RESTRIKE_MS } from '../services/linkCheckService'
import { createSafeLinkRequest, type LinkRequestImpl, type PinnedRequestImpl } from '../services/safeLinkNetwork'
import { pickPostingsToCheck, postingOutcome, runLinkCheckHandler } from '../jobs/linkCheckJobs'
import {
  groupApplyLinkSubjects,
  linkDispositionOf,
  nextMachineGovernance,
} from '../services/linkGovernance'

const NOW = new Date('2026-07-16T12:00:00Z')
const QUALITY_SESSION = { id: 'link-quality-session' }
const RECOVERY_LINK = {
  subject: `ls1_${'A'.repeat(43)}`,
  generation: `lg1_${'B'.repeat(43)}`,
}
const OTHER_RECOVERY_LINK = {
  subject: `ls1_${'C'.repeat(43)}`,
  generation: `lg1_${'D'.repeat(43)}`,
}
const aliveRecovery = (identity = RECOVERY_LINK) => ({ ...identity, outcome: 'alive' as const })
const unverifiableRecovery = (identity = RECOVERY_LINK) => ({
  ...identity,
  outcome: 'unverifiable' as const,
})
const decisionHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

function requestStub(status: number, bodyText = '', location?: string): LinkRequestImpl {
  return vi.fn().mockResolvedValue({ kind: 'response', status, bodyText, location }) as never
}
function unavailableStub(code: string): LinkRequestImpl {
  return vi.fn().mockResolvedValue({ kind: 'unverifiable', code }) as never
}
const nxdomainStub = vi.fn().mockResolvedValue({ kind: 'nxdomain' }) as LinkRequestImpl

// Tests must never hit live DNS: a resolver and connector are always injected.
const publicResolver = async () => [{ address: '93.184.216.34', family: 4 as const }]

function governedProvenance(
  url: string,
  governance: Record<string, unknown> = {},
): Array<Record<string, unknown>> {
  const seenAt = new Date('2026-07-01T00:00:00Z')
  const entry = {
    sourceId: 'jsearch',
    externalId: 'ext-1',
    sourceKey: 'jsearch:ext-1',
    applyUrl: url,
    applyUrlFirstSeenAt: seenAt,
    firstSeenAt: seenAt,
    lastSeenAt: seenAt,
  }
  const group = groupApplyLinkSubjects([entry])[0]
  return [{
    ...entry,
    linkGovernance: { ...group.governance, ...governance },
  }]
}

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

describe('two-alive closed-posting recovery policy', () => {
  it('requires two alive observations at least 20h apart before reopening', () => {
    const closed = nextApplyCheckState(undefined, 'dead', NOW).state
    const firstAlive = nextClosedApplyCheckState(closed, 'alive', NOW, aliveRecovery())
    expect(firstAlive.state.aliveStreak).toBe(1)
    expect(firstAlive.state).toMatchObject({
      recoverySubject: RECOVERY_LINK.subject,
      recoveryGeneration: RECOVERY_LINK.generation,
    })
    expect(firstAlive.shouldReopen).toBe(false)

    const tooSoon = nextClosedApplyCheckState(
      firstAlive.state,
      'alive',
      new Date(NOW.getTime() + MIN_RESTRIKE_MS - 1),
      aliveRecovery(),
    )
    expect(tooSoon.state.aliveStreak).toBe(1)
    expect(tooSoon.state.lastAliveAt).toEqual(NOW)
    expect(tooSoon.shouldReopen).toBe(false)

    const spaced = nextClosedApplyCheckState(
      tooSoon.state,
      'alive',
      new Date(NOW.getTime() + MIN_RESTRIKE_MS),
      aliveRecovery(),
    )
    expect(spaced.shouldReopen).toBe(true)
    expect(spaced.state.aliveStreak).toBeUndefined()
    expect(spaced.state.lastAliveAt).toBeUndefined()
    expect(spaced.state.recoverySubject).toBeUndefined()
    expect(spaced.state.recoveryGeneration).toBeUndefined()
  })

  it('preserves a recovery strike across unverifiable checks but resets it on positive death', () => {
    const firstAlive = nextClosedApplyCheckState(
      undefined,
      'alive',
      NOW,
      aliveRecovery(),
    ).state
    const unverifiable = nextClosedApplyCheckState(
      firstAlive,
      'unverifiable',
      new Date(NOW.getTime() + 3600_000),
      unverifiableRecovery(),
    )
    expect(unverifiable.state.aliveStreak).toBe(1)
    expect(unverifiable.state.lastAliveAt).toEqual(NOW)
    expect(unverifiable.state.recoverySubject).toBe(RECOVERY_LINK.subject)
    expect(unverifiable.shouldReopen).toBe(false)

    const dead = nextClosedApplyCheckState(
      unverifiable.state,
      'dead',
      new Date(NOW.getTime() + MIN_RESTRIKE_MS),
    )
    expect(dead.state.aliveStreak).toBeUndefined()
    expect(dead.state.lastAliveAt).toBeUndefined()
    expect(dead.state.recoverySubject).toBeUndefined()
    expect(dead.state.recoveryGeneration).toBeUndefined()
    expect(dead.shouldReopen).toBe(false)
  })

  it('never combines alive strikes from alternating current URL generations', () => {
    const first = nextClosedApplyCheckState(
      undefined,
      'alive',
      NOW,
      aliveRecovery(RECOVERY_LINK),
    )
    const switchedAt = new Date(NOW.getTime() + MIN_RESTRIKE_MS)
    const switched = nextClosedApplyCheckState(
      first.state,
      'alive',
      switchedAt,
      aliveRecovery(OTHER_RECOVERY_LINK),
    )

    expect(switched.shouldReopen).toBe(false)
    expect(switched.state).toMatchObject({
      aliveStreak: 1,
      lastAliveAt: switchedAt,
      recoverySubject: OTHER_RECOVERY_LINK.subject,
      recoveryGeneration: OTHER_RECOVERY_LINK.generation,
    })

    const sameLinkAgain = nextClosedApplyCheckState(
      switched.state,
      'alive',
      new Date(switchedAt.getTime() + MIN_RESTRIKE_MS),
      aliveRecovery(OTHER_RECOVERY_LINK),
    )
    expect(sameLinkAgain.shouldReopen).toBe(true)
  })

  it('does not reuse recovery strikes after reopen and a later re-close', () => {
    const firstDead = nextApplyCheckState(undefined, 'dead', NOW)
    const closed = nextApplyCheckState(
      firstDead.state,
      'dead',
      new Date(NOW.getTime() + MIN_RESTRIKE_MS),
    )
    expect(closed.shouldClose).toBe(true)

    const firstAlive = nextClosedApplyCheckState(
      closed.state,
      'alive',
      new Date(NOW.getTime() + 2 * MIN_RESTRIKE_MS),
      aliveRecovery(),
    )
    const reopened = nextClosedApplyCheckState(
      firstAlive.state,
      'alive',
      new Date(NOW.getTime() + 3 * MIN_RESTRIKE_MS),
      aliveRecovery(),
    )
    expect(reopened.shouldReopen).toBe(true)
    expect(reopened.state.aliveStreak).toBeUndefined()
    expect(reopened.state.lastAliveAt).toBeUndefined()
    expect(reopened.state.recoverySubject).toBeUndefined()
    expect(reopened.state.recoveryGeneration).toBeUndefined()

    const nextFirstDead = nextApplyCheckState(
      reopened.state,
      'dead',
      new Date(NOW.getTime() + 4 * MIN_RESTRIKE_MS),
    )
    const reclosed = nextApplyCheckState(
      nextFirstDead.state,
      'dead',
      new Date(NOW.getTime() + 5 * MIN_RESTRIKE_MS),
    )
    expect(reclosed.shouldClose).toBe(true)
    expect(reclosed.state.aliveStreak).toBeUndefined()
    expect(reclosed.state.lastAliveAt).toBeUndefined()

    const oneAlive = nextClosedApplyCheckState(
      reclosed.state,
      'alive',
      new Date(NOW.getTime() + 6 * MIN_RESTRIKE_MS),
      aliveRecovery(),
    )
    expect(oneAlive.shouldReopen).toBe(false)
    expect(oneAlive.state.aliveStreak).toBe(1)
  })
})

describe('per-link machine governance lifecycle', () => {
  it('dead demotes, unverifiable preserves that evidence, and alive clears the incident', () => {
    const source = governedProvenance('https://machine-lifecycle.example/apply')[0]
    const initial = groupApplyLinkSubjects([source])[0].governance
    const crowdAt = new Date(NOW.getTime() - 3600_000)
    const crowd = {
      ...initial,
      reportWindowStartedAt: crowdAt,
      reportCount: 3,
      crowdDemotedAt: crowdAt,
    }
    const deadAt = new Date(NOW.getTime() + 1000)
    const dead = nextMachineGovernance(crowd, 'dead', deadAt)
    expect(dead.machineDemotedAt).toEqual(deadAt)
    expect(linkDispositionOf(dead)).toBe('machine-demoted')

    const unverifiable = nextMachineGovernance(
      dead,
      'unverifiable',
      new Date(deadAt.getTime() + 1000),
    )
    expect(unverifiable.machineDemotedAt).toEqual(deadAt)
    expect(linkDispositionOf(unverifiable)).toBe('machine-demoted')

    const alive = nextMachineGovernance(
      unverifiable,
      'alive',
      new Date(deadAt.getTime() + 2000),
    )
    expect(alive.incidentVersion).toBe(initial.incidentVersion + 1)
    expect(alive.reportCount).toBe(0)
    expect(alive.crowdDemotedAt).toBeUndefined()
    expect(alive.machineDemotedAt).toBeUndefined()
    expect(linkDispositionOf(alive)).toBe('pending-verification')
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
    mockSourceFind.mockImplementation((filter: { sourceId?: { $in?: string[] } }) => ({
      select: () => ({
        lean: () => Promise.resolve((filter.sourceId?.$in ?? []).map((sourceId) => ({
          sourceId,
          health: 'active',
          controlRevision: 2,
          operationalRevision: 5,
        }))),
      }),
    }))
    mockCycleCreate.mockResolvedValue({})
    mockFenceQualityDecisionSources.mockResolvedValue(undefined)
    mockRecordAutomaticQualityDecision.mockResolvedValue({
      decisionKey: `quality:v1:${'c'.repeat(64)}`,
      inserted: true,
    })
    mockWithQualityDecisionTransaction.mockImplementation(
      (work: (session: unknown) => Promise<unknown>) => work(QUALITY_SESSION),
    )
  })

  it('caps the crowd-request lane at 50 and reserves the remaining 100 slots for due machine work', async () => {
    const crowd = Array.from({ length: 60 }, (_, index) => ({ _id: `crowd-${index}` }))
    const machine = Array.from({ length: 120 }, (_, index) => ({ _id: `machine-${index}` }))
    const cappedChain = (docs: unknown[]) => {
      const limit = vi.fn((cap: number) => ({
        lean: () => Promise.resolve(docs.slice(0, cap)),
      }))
      return {
        query: {
          select: vi.fn().mockReturnValue({
            sort: vi.fn().mockReturnValue({ limit }),
          }),
        },
        limit,
      }
    }
    const crowdQuery = cappedChain(crowd)
    const machineQuery = cappedChain(machine)
    mockPostingFind
      .mockReturnValueOnce(crowdQuery.query)
      .mockReturnValueOnce(machineQuery.query)

    const picked = await pickPostingsToCheck(NOW)

    expect(picked).toHaveLength(150)
    expect(crowdQuery.limit).toHaveBeenCalledWith(50)
    expect(machineQuery.limit).toHaveBeenCalledWith(100)
    expect(mockPostingFind).toHaveBeenCalledTimes(2)
    expect(mockPostingFind.mock.calls[0][0]).toMatchObject({
      linkCheckRequestedAt: { $type: 'date' },
    })
    expect(mockPostingFind.mock.calls[0][0]).not.toHaveProperty('provenance.brokenReportCount')
    const due = mockPostingFind.mock.calls[1][0] as { $or: Array<Record<string, unknown>> }
    expect(due.$or).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'open', 'applyCheck.status': 'dead' }),
      expect.objectContaining({ status: 'closed', closedReason: 'dead-apply-link' }),
    ]))
  })

  it('a dead-everywhere posting on its SECOND ≥20h strike closes with dead-apply-link, status-guarded; telemetry row written', async () => {
    const priorObservedAt = new Date(NOW.getTime() - 25 * 3600_000)
    const doc = {
      _id: 'p1',
      provenance: governedProvenance('https://dead.example/a'),
      applyCheck: { status: 'dead', deadStreak: 1, lastCheckedAt: priorObservedAt, lastDeadAt: priorObservedAt },
    }
    const group = groupApplyLinkSubjects(doc.provenance)[0]
    const machineInputHash = decisionHash({
      subject: group.subject,
      generation: group.generation,
      incidentVersion: group.governance.incidentVersion,
      outcome: 'dead',
    })
    const lifecycleInputHash = decisionHash({
      incidents: [{
        generation: group.generation,
        incidentVersion: group.governance.incidentVersion,
      }],
      outcome: 'dead',
      lifecycle: 'close',
    })
    mockPostingFind
      .mockReturnValueOnce(chain([doc])) // requested
      .mockReturnValueOnce(chain([])) // restrikes/recovery
      .mockReturnValueOnce(chain([])) // unchecked
      .mockReturnValueOnce(chain([])) // stale unverifiable
      .mockReturnValueOnce(chain([])) // stale alive
    const r = await runLinkCheckHandler(step, nxdomainStub, new Date(), 0)
    expect(r.closed).toBe(1)
    const [filter, update] = mockPostingUpdateOne.mock.calls[0]
    expect(filter).toMatchObject({ _id: 'p1', status: 'open' }) // guarded
    expect((update as { $set: Record<string, unknown> }).$set).toMatchObject({ status: 'closed', closedReason: 'dead-apply-link' })
    expect(mockWithQualityDecisionTransaction).toHaveBeenCalledTimes(1)
    expect(mockSourceFind).toHaveBeenCalledWith(
      { sourceId: { $in: ['jsearch'] } },
      null,
      { session: QUALITY_SESSION },
    )
    expect(mockFenceQualityDecisionSources).toHaveBeenCalledWith(
      [{ sourceId: 'jsearch', controlRevision: 2, operationalRevision: 5 }],
      QUALITY_SESSION,
    )
    expect(mockPostingUpdateOne.mock.calls[0][2]).toEqual({
      runValidators: true,
      session: QUALITY_SESSION,
    })
    expect(mockRecordAutomaticQualityDecision).toHaveBeenCalledTimes(2)
    expect(mockRecordAutomaticQualityDecision.mock.calls[0]).toEqual([
      expect.objectContaining({
        domain: 'apply-link',
        action: 'demote',
        subjectKey: `p1:${group.subject}:${group.generation}:${group.governance.incidentVersion}`,
        postingId: 'p1',
        serviceActor: 'jobs-link-check',
        inputHash: machineInputHash,
        policyRevision: `jobs-link-check:two-strike:${MIN_RESTRIKE_MS}`,
        sourceRevisions: [{ sourceId: 'jsearch', controlRevision: 2, operationalRevision: 5 }],
        occurredAt: expect.any(Date),
        evidence: expect.objectContaining({
          kind: 'apply-link',
          basis: 'machine',
          outcome: 'dead',
          generation: group.generation,
          observedAt: expect.any(Date),
          checkedOptionCount: 1,
        }),
      }),
      QUALITY_SESSION,
    ])
    expect(mockRecordAutomaticQualityDecision.mock.calls[1]).toEqual([
      expect.objectContaining({
        domain: 'apply-link',
        action: 'close',
        subjectKey: 'p1',
        postingId: 'p1',
        serviceActor: 'jobs-link-check',
        inputHash: lifecycleInputHash,
        policyRevision: `jobs-link-check:two-strike:${MIN_RESTRIKE_MS}`,
        sourceRevisions: [{ sourceId: 'jsearch', controlRevision: 2, operationalRevision: 5 }],
        occurredAt: expect.any(Date),
        evidence: expect.objectContaining({
          kind: 'apply-link',
          basis: 'machine',
          outcome: 'dead',
          generation: expect.any(String),
          observedAt: expect.any(Date),
          priorObservedAt,
          checkedOptionCount: 1,
        }),
      }),
      QUALITY_SESSION,
    ])
    // Close first clears every TTL, then current DB pin state determines
    // whether a second conditional write may stamp a new one.
    expect((update as { $unset: Record<string, unknown> }).$unset).toEqual({
      linkCheckRequestedAt: 1,
      purgeAt: 1,
    })
    expect(mockPostingUpdateOne.mock.calls[1][0]).toMatchObject({
      status: 'closed',
      closedReason: 'dead-apply-link',
      closedAt: expect.any(Date),
      userReferenced: true,
    })
    expect(mockPostingUpdateOne.mock.calls[1][0]).not.toHaveProperty('provenance')
    expect(mockPostingUpdateOne.mock.calls[2][0]).toMatchObject({
      status: 'closed',
      closedReason: 'dead-apply-link',
      closedAt: expect.any(Date),
      userReferenced: { $ne: true },
    })
    expect(mockPostingUpdateOne.mock.calls[2][0]).not.toHaveProperty('provenance')
    expect(mockPostingUpdateOne.mock.calls[2][1].$set.purgeAt).toBeInstanceOf(Date)
    expect(mockPostingUpdateOne.mock.calls[1][2]).toEqual({ session: QUALITY_SESSION })
    expect(mockPostingUpdateOne.mock.calls[2][2]).toEqual({ session: QUALITY_SESSION })
    expect(mockCycleCreate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'link-check', linkCheck: expect.objectContaining({ checked: 1, dead: 1, closedNow: 1 }) }))
  })

  it('aborts the lifecycle transaction before TTL and telemetry when decision evidence cannot be written', async () => {
    const priorObservedAt = new Date(NOW.getTime() - 25 * 3600_000)
    const doc = {
      _id: 'p-ledger-failure',
      provenance: governedProvenance('https://dead.example/a'),
      applyCheck: {
        status: 'dead',
        deadStreak: 1,
        lastCheckedAt: priorObservedAt,
        lastDeadAt: priorObservedAt,
      },
    }
    mockPostingFind
      .mockReturnValueOnce(chain([doc]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
    mockRecordAutomaticQualityDecision.mockRejectedValueOnce(new Error('ledger write failed'))

    await expect(runLinkCheckHandler(step, nxdomainStub, NOW, 0))
      .rejects.toThrow('ledger write failed')

    expect(mockWithQualityDecisionTransaction).toHaveBeenCalledTimes(1)
    expect(mockPostingUpdateOne).toHaveBeenCalledTimes(1)
    expect(mockPostingUpdateOne.mock.calls[0][2]).toEqual({
      runValidators: true,
      session: QUALITY_SESSION,
    })
    expect(mockRecordAutomaticQualityDecision).toHaveBeenCalledTimes(1)
    expect(mockRecordAutomaticQualityDecision.mock.calls[0][1]).toBe(QUALITY_SESSION)
    expect(mockCycleCreate).not.toHaveBeenCalled()
  })

  it('Codex #543 P1: the picker has a restrike bucket — dead rows past the 20h window are re-picked (strike 2 is reachable)', async () => {
    mockPostingFind
      .mockReturnValueOnce(chain([])) // requested
      .mockReturnValueOnce(chain([])) // restrikes/recovery
      .mockReturnValueOnce(chain([])) // unchecked
      .mockReturnValueOnce(chain([])) // stale unverifiable
      .mockReturnValueOnce(chain([])) // stale alive
    await runLinkCheckHandler(step, vi.fn() as never, new Date(), 0)
    expect(mockPostingFind).toHaveBeenCalledTimes(5)
    // Codex #543 r3: transient results re-enter the pool.
    const unvFilter = mockPostingFind.mock.calls[3][0] as Record<string, unknown>
    expect(unvFilter['applyCheck.status']).toBe('unverifiable')
    const machineDueFilter = mockPostingFind.mock.calls[1][0] as { $or: Array<Record<string, unknown>> }
    expect(machineDueFilter.$or).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'open',
        'applyCheck.status': 'dead',
        'applyCheck.lastDeadAt': expect.anything(),
      }),
      expect.objectContaining({
        status: 'closed',
        closedReason: 'dead-apply-link',
        'applyCheck.lastCheckedAt': expect.anything(),
      }),
    ]))
  })

  it('Codex #543 r6: a 4-URL all-dead posting is judged in ONE step — extra URLs never make it uncloseable', async () => {
    const doc = {
      _id: 'p4',
      provenance: [1, 2, 3, 4].map((i) => ({
        sourceId: 'jsearch',
        externalId: `ext-${i}`,
        sourceKey: `jsearch:ext-${i}`,
        applyUrl: `https://dead${i}.example/a`,
      })),
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
      provenance: governedProvenance('https://dead.example/a'),
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
    })
    expect(mockCycleCreate).toHaveBeenCalledWith(expect.objectContaining({
      linkCheck: expect.objectContaining({ checked: 0, closedNow: 0, casMisses: 1 }),
    }))
  })

  it('preserves the crowd request for retry when a newer report/generation wins the final CAS', async () => {
    const prevChecked = new Date(NOW.getTime() - 25 * 3600_000)
    const requestedAt = new Date(NOW.getTime() - 3600_000)
    const doc = {
      _id: 'p-race',
      provenance: governedProvenance('https://dead.example/a'),
      linkCheckRequestedAt: requestedAt,
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
    expect(mockWithQualityDecisionTransaction).toHaveBeenCalledTimes(1)
    expect(mockSourceFind).toHaveBeenCalledWith(
      { sourceId: { $in: ['jsearch'] } },
      null,
      { session: QUALITY_SESSION },
    )
    expect(mockPostingUpdateOne).toHaveBeenCalledTimes(1)
    expect(mockPostingUpdateOne.mock.calls[0][0]).toMatchObject({
      provenance: doc.provenance,
      linkCheckRequestedAt: requestedAt,
    })
    expect(mockPostingUpdateOne.mock.calls[0][1]).toMatchObject({
      $unset: { linkCheckRequestedAt: 1 },
    })
    expect(mockPostingUpdateOne.mock.calls[0][2]).toEqual({
      runValidators: true,
      session: QUALITY_SESSION,
    })
    expect(mockRecordAutomaticQualityDecision).not.toHaveBeenCalled()
    expect(mockCycleCreate).toHaveBeenCalledWith(expect.objectContaining({
      linkCheck: expect.objectContaining({
        checked: 0,
        closedNow: 0,
        requestedProcessed: 0,
        casMisses: 1,
      }),
    }))
  })

  it('checks duplicate canonical URLs once and replicates one machine result to every rung', async () => {
    const seenAt = new Date('2026-07-01T00:00:00Z')
    const provenance = [
      {
        sourceId: 'jsearch', externalId: '1', sourceKey: 'jsearch:1',
        applyUrl: 'https://dup.example/jobs/1#apply', applyUrlFirstSeenAt: seenAt,
        firstSeenAt: seenAt, lastSeenAt: seenAt,
      },
      {
        sourceId: 'greenhouse', externalId: '2', sourceKey: 'greenhouse:2',
        applyUrl: 'https://dup.example/jobs/1#details', applyUrlFirstSeenAt: seenAt,
        firstSeenAt: seenAt, lastSeenAt: seenAt,
      },
    ]
    const doc = { _id: 'p-duplicate', provenance }
    mockPostingFind
      .mockReturnValueOnce(chain([doc]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
    const request = requestStub(200, 'Apply now')

    await runLinkCheckHandler(step, request, NOW, 0)

    expect(request).toHaveBeenCalledTimes(1)
    const governed = mockPostingUpdateOne.mock.calls[0][1].$set.provenance
    expect(governed).toHaveLength(2)
    expect(governed[0].linkGovernance).toEqual(governed[1].linkGovernance)
    expect(governed[0].linkGovernance.machineOutcome).toBe('alive')
  })

  it('a report committed before the check is cleared only with the successful alive evidence write', async () => {
    const reportedAt = new Date(NOW.getTime() - 3600_000)
    const provenance = governedProvenance('https://healthy.example/a', {
      reportWindowStartedAt: reportedAt,
      reportCount: 3,
      lastReportedAt: reportedAt,
      crowdDemotedAt: reportedAt,
    })
    const doc = {
      _id: 'p-reported-first',
      status: 'open' as const,
      provenance,
      linkCheckRequestedAt: reportedAt,
    }
    mockPostingFind
      .mockReturnValueOnce(chain([doc]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))

    const result = await runLinkCheckHandler(step, requestStub(200, 'Apply now'), NOW, 0)

    expect(result.checked).toBe(1)
    const [, update] = mockPostingUpdateOne.mock.calls[0]
    const next = update.$set.provenance[0].linkGovernance
    expect(next.reportCount).toBe(0)
    expect(next.crowdDemotedAt).toBeUndefined()
    expect(next.machineDemotedAt).toBeUndefined()
    expect(next.machineOutcome).toBe('alive')
    expect(update.$unset).toMatchObject({ linkCheckRequestedAt: 1 })
    expect(mockCycleCreate).toHaveBeenCalledWith(expect.objectContaining({
      linkCheck: expect.objectContaining({
        requestedProcessed: 1,
        crowdDispositionChanged: 1,
        incidentsCleared: 1,
        casMisses: 0,
      }),
    }))
  })

  it('machine-dead soft-demotes while unverifiable preserves an existing crowd demotion', async () => {
    const deadDoc = { _id: 'p-machine-dead', provenance: governedProvenance('https://dead.example/a') }
    mockPostingFind
      .mockReturnValueOnce(chain([deadDoc]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
    await runLinkCheckHandler(step, nxdomainStub, NOW, 0)
    const deadGovernance = mockPostingUpdateOne.mock.calls[0][1].$set.provenance[0].linkGovernance
    expect(deadGovernance.machineOutcome).toBe('dead')
    expect(deadGovernance.machineDemotedAt).toBeInstanceOf(Date)
    expect(mockCycleCreate).toHaveBeenCalledWith(expect.objectContaining({
      linkCheck: expect.objectContaining({ machineDispositionChanged: 1 }),
    }))

    vi.clearAllMocks()
    mockPostingExists.mockResolvedValue({ _id: 'authorized' })
    mockPostingUpdateOne.mockResolvedValue({ matchedCount: 1 })
    mockCycleCreate.mockResolvedValue({})
    const crowdAt = new Date(NOW.getTime() - 3600_000)
    const unverifiableDoc = {
      _id: 'p-machine-unverifiable',
      provenance: governedProvenance('https://blocked.example/a', {
        reportWindowStartedAt: crowdAt,
        reportCount: 3,
        lastReportedAt: crowdAt,
        crowdDemotedAt: crowdAt,
      }),
    }
    mockPostingFind
      .mockReturnValueOnce(chain([unverifiableDoc]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
    await runLinkCheckHandler(step, requestStub(503), NOW, 0)
    const unchanged = mockPostingUpdateOne.mock.calls[0][1].$set.provenance[0].linkGovernance
    expect(unchanged.machineOutcome).toBe('unverifiable')
    expect(unchanged.crowdDemotedAt).toEqual(crowdAt)
    expect(unchanged.reportCount).toBe(3)
  })

  it('keeps retention closed after one alive recovery strike, then reopens and clears TTL after the spaced second', async () => {
    const previous = new Date(NOW.getTime() - 25 * 3600_000)
    const firstDoc = {
      _id: 'p-recovery-1',
      status: 'closed' as const,
      closedReason: 'dead-apply-link',
      provenance: governedProvenance('https://recovered.example/a', {
        machineOutcome: 'dead',
        machineCheckedAt: previous,
        machineDemotedAt: previous,
      }),
      applyCheck: { status: 'dead', deadStreak: 2, lastCheckedAt: previous, lastDeadAt: previous },
    }
    const recoveryGroup = groupApplyLinkSubjects(firstDoc.provenance)[0]
    mockPostingFind
      .mockReturnValueOnce(chain([firstDoc]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
    await runLinkCheckHandler(step, requestStub(200, 'Apply now'), NOW, 0)
    const [firstFilter, firstUpdate] = mockPostingUpdateOne.mock.calls[0]
    expect(firstFilter).toMatchObject({ status: 'closed', closedReason: 'dead-apply-link' })
    expect(firstUpdate.$set.applyCheck.aliveStreak).toBe(1)
    expect(firstUpdate.$set.applyCheck).toMatchObject({
      recoverySubject: recoveryGroup.subject,
      recoveryGeneration: recoveryGroup.generation,
    })
    expect(firstUpdate.$set.status).toBeUndefined()
    expect(firstUpdate.$unset.purgeAt).toBeUndefined()

    vi.clearAllMocks()
    mockPostingExists.mockResolvedValue({ _id: 'authorized' })
    mockPostingUpdateOne.mockResolvedValue({ matchedCount: 1 })
    mockCycleCreate.mockResolvedValue({})
    const secondDoc = {
      ...firstDoc,
      _id: 'p-recovery-2',
      applyCheck: {
        status: 'alive', deadStreak: 0, aliveStreak: 1,
        lastCheckedAt: previous, lastAliveAt: previous,
        recoverySubject: recoveryGroup.subject,
        recoveryGeneration: recoveryGroup.generation,
      },
    }
    mockPostingFind
      .mockReturnValueOnce(chain([secondDoc]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
    await runLinkCheckHandler(step, requestStub(200, 'Apply now'), NOW, 0)
    const [, reopened] = mockPostingUpdateOne.mock.calls[0]
    expect(reopened.$set).toMatchObject({ status: 'open' })
    expect(reopened.$set.applyCheck.aliveStreak).toBeUndefined()
    expect(reopened.$set.applyCheck.lastAliveAt).toBeUndefined()
    expect(reopened.$set.applyCheck.recoverySubject).toBeUndefined()
    expect(reopened.$set.applyCheck.recoveryGeneration).toBeUndefined()
    expect(reopened.$unset).toMatchObject({
      closedReason: 1,
      closedAt: 1,
      purgeAt: 1,
      linkCheckRequestedAt: 1,
    })
    expect(mockPostingUpdateOne).toHaveBeenCalledTimes(1)
    expect(mockCycleCreate).toHaveBeenCalledWith(expect.objectContaining({
      linkCheck: expect.objectContaining({ reopenedNow: 1 }),
    }))
  })

  it('does not reopen when two spaced positive observations alternate between URLs', async () => {
    const previous = new Date(NOW.getTime() - 25 * 3600_000)
    const first = governedProvenance('https://recovery-a.example/apply', {
      machineOutcome: 'alive',
      machineCheckedAt: previous,
    })[0]
    const second = {
      ...governedProvenance('https://recovery-b.example/apply', {
        machineOutcome: 'dead',
        machineCheckedAt: previous,
        machineDemotedAt: previous,
      })[0],
      sourceId: 'greenhouse',
      externalId: 'ext-2',
      sourceKey: 'greenhouse:ext-2',
    }
    const firstGroup = groupApplyLinkSubjects([first])[0]
    const secondGroup = groupApplyLinkSubjects([second])[0]
    const doc = {
      _id: 'p-alternating-recovery',
      status: 'closed' as const,
      closedReason: 'dead-apply-link',
      provenance: [first, second],
      applyCheck: {
        status: 'alive',
        deadStreak: 0,
        aliveStreak: 1,
        lastCheckedAt: previous,
        lastAliveAt: previous,
        recoverySubject: firstGroup.subject,
        recoveryGeneration: firstGroup.generation,
      },
    }
    mockPostingFind
      .mockReturnValueOnce(chain([doc]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
    const alternating = vi.fn(async (url: URL) => ({
      kind: 'response' as const,
      status: url.hostname === 'recovery-a.example' ? 404 : 200,
      bodyText: url.hostname === 'recovery-a.example' ? '' : 'Apply now',
    }))

    await runLinkCheckHandler(step, alternating as LinkRequestImpl, NOW, 0)

    const [, update] = mockPostingUpdateOne.mock.calls[0]
    expect(update.$set.status).toBeUndefined()
    expect(update.$set.applyCheck).toMatchObject({
      status: 'alive',
      aliveStreak: 1,
      recoverySubject: secondGroup.subject,
      recoveryGeneration: secondGroup.generation,
    })
    expect(update.$set.applyCheck.lastAliveAt).not.toEqual(previous)
    expect(mockCycleCreate).toHaveBeenCalledWith(expect.objectContaining({
      linkCheck: expect.objectContaining({ reopenedNow: 0 }),
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
