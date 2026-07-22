import {
  canonicalizeCheckableLink,
  safeLinkRequest,
  type LinkRequestImpl,
} from './safeLinkNetwork'

/**
 * Apply-link liveness classifier (founder directive 2026-07-16: "check the
 * apply link if it is valid or not" — the scalable successor to reactive
 * host-blocking after the vacancy-spam recurrence; DECISIONS ruling #22).
 *
 * Policy ported from the liquidity probe's G4 rot checker, whose central
 * lesson is FALSE-POSITIVE SAFETY: many legitimate ATS/employer sites
 * bot-block with 403/406/429/999, so "didn't load" must NEVER mean "dead".
 * Dead requires a positive signal: 404/410, DNS-nonexistent, connection
 * refused, or a 200 page that says the job is gone (real rot hides behind
 * 200s). Everything ambiguous is 'unverifiable' and merely re-checked.
 */

export type LinkOutcome = 'dead' | 'alive' | 'unverifiable'

/** A posting stopped authorizing this liveness check while it was running.
 *  Callers must discard the observation rather than persist it as a link
 *  result. */
export class LinkCheckAuthorityChangedError extends Error {
  constructor() {
    super('posting authority changed during link check')
    this.name = 'LinkCheckAuthorityChangedError'
  }
}

export type BeforeLinkCheckRequest = () => boolean | void | Promise<boolean | void>

/** Same markers the probe's G4 gate uses — a 200 body announcing closure. */
export const EXPIRY_MARKERS =
  /no longer accepting applications|this job (is|has been) (closed|expired)|position (has been )?filled|job (has )?expired|vacancy (is )?closed/i

const BOT_BLOCK_STATUSES = new Set([403, 406, 429, 999])
const TIMEOUT_MS = 12_000
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECT_HOPS = 5

/** Fast shape gate used while packing the link-check queue. The authoritative
 * network boundary lives in safeLinkNetwork and repeats this canonical policy
 * before resolving and pinning every physical connection. */
export function isCheckableUrl(u: string): boolean {
  return canonicalizeCheckableLink(u) !== null
}

/** Node transport failures may carry the syscall code on error.cause. */
function causeCode(err: unknown): string | undefined {
  const cause = (err as { cause?: { code?: string } } | undefined)?.cause
  return cause?.code ?? (err as { code?: string } | undefined)?.code
}

export async function checkApplyLink(
  url: string,
  requestImpl: LinkRequestImpl = safeLinkRequest,
  beforePhysicalRequest?: BeforeLinkCheckRequest,
): Promise<LinkOutcome> {
  const initial = canonicalizeCheckableLink(url)
  if (!initial) return 'unverifiable'
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    // One total deadline covers DNS, connect/TLS, all redirects and body.
    // Every hop is independently canonicalized, resolved and connection-
    // pinned by the single request primitive; it has no second-DNS fetch API.
    let current = initial
    let status = 0
    let bodyText = ''
    let hops = 0
    const visited = new Set<string>()
    for (;;) {
      const canonical = current.toString()
      if (visited.has(canonical)) return 'unverifiable'
      visited.add(canonical)

      const result = await requestImpl(current, {
        signal: ctrl.signal,
        beforePhysicalRequest,
      })
      if (result.kind === 'authority-changed') throw new LinkCheckAuthorityChangedError()
      if (result.kind === 'nxdomain') return 'dead'
      if (result.kind === 'unverifiable') {
        return result.code === 'ECONNREFUSED' ? 'dead' : 'unverifiable'
      }
      status = result.status
      bodyText = result.bodyText
      if (!REDIRECT_STATUSES.has(status)) break
      if (!result.location) return 'unverifiable'
      if (hops >= MAX_REDIRECT_HOPS) return 'unverifiable'
      let next: URL | null
      try {
        next = canonicalizeCheckableLink(new URL(result.location, current))
      } catch {
        return 'unverifiable'
      }
      if (!next) return 'unverifiable'
      // Never let a trusted HTTPS hop opt the server into cleartext transport.
      if (current.protocol === 'https:' && next.protocol === 'http:') return 'unverifiable'
      hops += 1
      current = next
    }
    if (status === 404 || status === 410) return 'dead'
    if (BOT_BLOCK_STATUSES.has(status) || status >= 500) return 'unverifiable'
    if (status >= 200 && status < 300) {
      return EXPIRY_MARKERS.test(bodyText) ? 'dead' : 'alive'
    }
    // Other 3xx/4xx shapes (redirect loops surfaced as 3xx, 401, 451…):
    // no positive death signal — recheck later.
    return 'unverifiable'
  } catch (err) {
    if (err instanceof LinkCheckAuthorityChangedError) throw err
    const code = causeCode(err)
    // DNS-nonexistent and refused connections are POSITIVE dead signals
    // (the vacancy-spam hosts were exactly this class). Timeouts and
    // resets are transient — unverifiable.
    if (code === 'ENOTFOUND' || code === 'ECONNREFUSED') return 'dead'
    return 'unverifiable'
  } finally {
    clearTimeout(timer)
  }
}

export interface ApplyCheckState {
  status?: LinkOutcome
  deadStreak?: number
  lastCheckedAt?: Date
  lastDeadAt?: Date
  /** Recovery evidence for a posting closed by the dead-link checker. Two
   * spaced alive observations are required before the lifecycle may reopen. */
  aliveStreak?: number
  lastAliveAt?: Date
  /** Exact current link whose positive evidence owns the recovery streak.
   * Both fields are required together; partial or stale legacy state fails
   * clean and cannot contribute to reopening. */
  recoverySubject?: string
  recoveryGeneration?: string
}

export interface ApplyRecoveryObservation {
  subject: string
  generation: string
  outcome: LinkOutcome
}

/** Two-strike close policy: a posting is closable only after TWO dead
 *  checks at least MIN_RESTRIKE_MS apart — a DNS flake or host outage must
 *  never kill a real job. Alive resets the streak; unverifiable changes
 *  nothing but the timestamp. */
export const MIN_RESTRIKE_MS = 20 * 3600 * 1000

function withoutRecoveryEvidence(state: ApplyCheckState): ApplyCheckState {
  const next = { ...state }
  delete next.aliveStreak
  delete next.lastAliveAt
  delete next.recoverySubject
  delete next.recoveryGeneration
  return next
}

export function nextApplyCheckState(
  prev: ApplyCheckState | undefined,
  outcome: LinkOutcome,
  now: Date
): { state: ApplyCheckState; shouldClose: boolean } {
  // Recovery strikes belong only to the current CLOSED lifecycle. Once the
  // posting is open, no transition may carry them into a later closure.
  const base = withoutRecoveryEvidence({ ...prev, status: outcome, lastCheckedAt: now })
  if (outcome === 'alive') return { state: { ...base, deadStreak: 0, lastDeadAt: undefined }, shouldClose: false }
  if (outcome === 'unverifiable') {
    // A timeout/bot-block on a pending RESTRIKE is a non-event: keep the
    // 'dead' status so the picker's restrike bucket still sees the row —
    // overwriting it dropped strike-1 postings from the pool permanently
    // (Codex #543 round 2).
    const status = prev?.status === 'dead' ? 'dead' : 'unverifiable'
    return { state: { ...base, status }, shouldClose: false }
  }
  // dead — the streak advances only across the restrike window, and
  // lastDeadAt moves ONLY when the streak advances: an hourly dead
  // re-check must not keep resetting the clock and push the second
  // strike forever out of reach.
  const prevStreak = prev?.deadStreak ?? 0
  const prevDeadAt = prev?.lastDeadAt ? new Date(prev.lastDeadAt).getTime() : undefined
  if (prevStreak === 0 || prevDeadAt === undefined) {
    return { state: { ...base, deadStreak: 1, lastDeadAt: now }, shouldClose: false }
  }
  if (now.getTime() - prevDeadAt >= MIN_RESTRIKE_MS) {
    const deadStreak = prevStreak + 1
    return { state: { ...base, deadStreak, lastDeadAt: now }, shouldClose: deadStreak >= 2 }
  }
  return { state: { ...base, deadStreak: prevStreak, lastDeadAt: prev!.lastDeadAt }, shouldClose: false }
}

/** Recovery policy for a posting already closed by `dead-apply-link`.
 *
 * Recovery deliberately mirrors the close policy: one live response is not
 * enough to resurrect a temporarily redirected or intermittently healthy
 * destination. Unverifiable observations preserve a prior live strike just
 * as they preserve a prior dead strike; a positive dead observation resets
 * recovery evidence. The caller remains responsible for fencing the lifecycle
 * to `closedReason: 'dead-apply-link'` before acting on `shouldReopen`.
 */
export function nextClosedApplyCheckState(
  prev: ApplyCheckState | undefined,
  outcome: LinkOutcome,
  now: Date,
  recoveryObservation?: ApplyRecoveryObservation,
): { state: ApplyCheckState; shouldReopen: boolean } {
  if (outcome === 'dead') {
    const next = nextApplyCheckState(prev, outcome, now)
    return {
      state: next.state,
      shouldReopen: false,
    }
  }
  if (outcome === 'unverifiable') {
    const next = nextApplyCheckState(prev, outcome, now).state
    const sameRecoveryLink =
      recoveryObservation?.outcome === 'unverifiable' &&
      typeof prev?.recoverySubject === 'string' &&
      typeof prev?.recoveryGeneration === 'string' &&
      recoveryObservation.subject === prev.recoverySubject &&
      recoveryObservation.generation === prev.recoveryGeneration
    return {
      // Unlike an open transition, an ambiguous recovery observation must
      // preserve the current closed lifecycle's first positive strike only
      // when the SAME current link remained ambiguous. A removed, replaced,
      // or positively dead recovery link cannot lend its strike to a sibling.
      state: {
        ...next,
        ...(sameRecoveryLink && prev?.aliveStreak !== undefined
          ? { aliveStreak: prev.aliveStreak }
          : {}),
        ...(sameRecoveryLink && prev?.lastAliveAt !== undefined
          ? { lastAliveAt: prev.lastAliveAt }
          : {}),
        ...(sameRecoveryLink ? {
          recoverySubject: prev!.recoverySubject,
          recoveryGeneration: prev!.recoveryGeneration,
        } : {}),
      },
      shouldReopen: false,
    }
  }

  const base: ApplyCheckState = {
    ...prev,
    status: 'alive',
    deadStreak: 0,
    lastCheckedAt: now,
    lastDeadAt: undefined,
  }
  // A posting may have several apply URLs. Recovery evidence belongs to one
  // exact subject:generation, never merely to "some URL was alive". If the
  // currently alive link differs, it starts its own first strike.
  if (!recoveryObservation || recoveryObservation.outcome !== 'alive') {
    return { state: withoutRecoveryEvidence(base), shouldReopen: false }
  }
  const sameRecoveryLink =
    recoveryObservation.subject === prev?.recoverySubject &&
    recoveryObservation.generation === prev?.recoveryGeneration
  const prevStreak = sameRecoveryLink ? prev?.aliveStreak ?? 0 : 0
  const prevAliveAt = sameRecoveryLink && prev?.lastAliveAt
    ? new Date(prev.lastAliveAt).getTime()
    : undefined
  if (prevStreak === 0 || prevAliveAt === undefined) {
    return {
      state: {
        ...base,
        aliveStreak: 1,
        lastAliveAt: now,
        recoverySubject: recoveryObservation.subject,
        recoveryGeneration: recoveryObservation.generation,
      },
      shouldReopen: false,
    }
  }
  if (now.getTime() - prevAliveAt >= MIN_RESTRIKE_MS) {
    const aliveStreak = prevStreak + 1
    const shouldReopen = aliveStreak >= 2
    const state = {
      ...base,
      aliveStreak,
      lastAliveAt: now,
      recoverySubject: recoveryObservation.subject,
      recoveryGeneration: recoveryObservation.generation,
    }
    return {
      state: shouldReopen ? withoutRecoveryEvidence(state) : state,
      shouldReopen,
    }
  }
  const shouldReopen = prevStreak >= 2
  const state = {
    ...base,
    aliveStreak: prevStreak,
    lastAliveAt: prev!.lastAliveAt,
    recoverySubject: recoveryObservation.subject,
    recoveryGeneration: recoveryObservation.generation,
  }
  return {
    state: shouldReopen ? withoutRecoveryEvidence(state) : state,
    shouldReopen,
  }
}
