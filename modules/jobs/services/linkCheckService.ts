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

/** Same markers the probe's G4 gate uses — a 200 body announcing closure. */
export const EXPIRY_MARKERS =
  /no longer accepting applications|this job (is|has been) (closed|expired)|position (has been )?filled|job (has )?expired|vacancy (is )?closed/i

const BOT_BLOCK_STATUSES = new Set([403, 406, 429, 999])
const TIMEOUT_MS = 12_000
const BODY_SNIFF_CAP = 100_000
const UA = 'InterviewPrepGuruBot/1.0 (+https://www.interviewprep.guru/jobs-bot)'

/** SSRF guard — this service fetches attacker-controlled URLs from our
 *  backend. http(s) only, and never loopback/private/link-local targets.
 *  Hostname-level checks (IP-literal ranges + localhost); DNS-rebinding is
 *  out of scope for a GET-and-discard liveness probe. */
export function isCheckableUrl(u: string): boolean {
  let url: URL
  try {
    url = new URL(u)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const h = url.hostname.toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '[::1]') return false
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])]
    if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0) {
      return false
    }
  }
  if (h.startsWith('[')) return false // IPv6 literals: skip outright (rare as legit apply hosts)
  return true
}

/** Node fetch failures carry the syscall code on error.cause. */
function causeCode(err: unknown): string | undefined {
  const cause = (err as { cause?: { code?: string } } | undefined)?.cause
  return cause?.code ?? (err as { code?: string } | undefined)?.code
}

function isPrivateV4(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
}

function isPrivateAddress(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower.includes(':')) {
    // IPv6: loopback, link-local, unique-local, and v4-mapped private.
    if (lower === '::1' || lower === '::') return true
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    return mapped ? isPrivateV4(mapped[1]) : false
  }
  return isPrivateV4(ip)
}

export type ResolveImpl = (hostname: string) => Promise<Array<{ address: string }>>

async function defaultResolve(hostname: string): Promise<Array<{ address: string }>> {
  const dns = await import('dns')
  return dns.promises.lookup(hostname, { all: true })
}

/** DNS-level SSRF check (Codex #543 round 2): the literal-IP guard is
 *  bypassable by an attacker-controlled HOSTNAME whose A record points at
 *  169.254.169.254 etc. Every hostname is resolved and EVERY returned
 *  address must be public before any fetch. Resolution failures return
 *  'dead' semantics upstream via the fetch itself (ENOTFOUND) — here they
 *  just fail open to the fetch, which cannot connect anywhere private
 *  because we re-reject on the resolved answer. TOCTOU rebinding between
 *  this check and the connect is documented out of scope for a
 *  GET-and-discard liveness probe. */
export async function resolvesToPublicAddress(url: string, resolveImpl: ResolveImpl = defaultResolve): Promise<boolean> {
  const host = new URL(url).hostname
  // IP literals were already screened by isCheckableUrl — re-screen anyway.
  if (/^[\d.]+$/.test(host) || host.includes(':')) return !isPrivateAddress(host.replace(/^\[|\]$/g, ''))
  let answers: Array<{ address: string }>
  try {
    answers = await resolveImpl(host)
  } catch {
    return true // NXDOMAIN etc. — let fetch surface ENOTFOUND as the dead signal
  }
  if (!answers.length) return true
  return answers.every((a) => !isPrivateAddress(a.address))
}

const MAX_REDIRECT_HOPS = 5

export async function checkApplyLink(
  url: string,
  fetchImpl: typeof fetch = fetch,
  resolveImpl?: ResolveImpl
): Promise<LinkOutcome> {
  if (!isCheckableUrl(url)) return 'unverifiable'
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    // Manual redirect handling (Codex #543 P1): auto-follow validates only
    // the ORIGINAL URL — a public host 302ing to 169.254.169.254 or
    // 127.0.0.1 would make the backend fetch a private target. Every hop
    // re-passes BOTH guards: URL shape (isCheckableUrl) and DNS answer
    // (resolvesToPublicAddress — an attacker HOSTNAME can A-record to a
    // private IP; Codex #543 round 2). Uncheckable hop = unverifiable.
    let current = url
    let res: Response
    let hops = 0
    for (;;) {
      if (!(await resolvesToPublicAddress(current, resolveImpl))) return 'unverifiable'
      res = await fetchImpl(current, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
      })
      if (res.status < 300 || res.status >= 400) break
      const loc = res.headers?.get?.('location')
      if (!loc) return 'unverifiable' // redirect with no target — no death signal
      let next: string
      try {
        next = new URL(loc, current).toString()
      } catch {
        return 'unverifiable'
      }
      if (!isCheckableUrl(next)) return 'unverifiable' // SSRF: never follow into private space
      if (++hops > MAX_REDIRECT_HOPS) return 'unverifiable' // loop — no death signal
      current = next
    }
    if (res.status === 404 || res.status === 410) return 'dead'
    if (BOT_BLOCK_STATUSES.has(res.status) || res.status >= 500) return 'unverifiable'
    if (res.ok) {
      // Expiry sniff on the first slice of the body only.
      let text = ''
      try {
        text = (await res.text()).slice(0, BODY_SNIFF_CAP)
      } catch {
        /* unreadable body — the 200 itself is the signal */
      }
      return EXPIRY_MARKERS.test(text) ? 'dead' : 'alive'
    }
    // Other 3xx/4xx shapes (redirect loops surfaced as 3xx, 401, 451…):
    // no positive death signal — recheck later.
    return 'unverifiable'
  } catch (err) {
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
}

/** Two-strike close policy: a posting is closable only after TWO dead
 *  checks at least MIN_RESTRIKE_MS apart — a DNS flake or host outage must
 *  never kill a real job. Alive resets the streak; unverifiable changes
 *  nothing but the timestamp. */
export const MIN_RESTRIKE_MS = 20 * 3600 * 1000

export function nextApplyCheckState(
  prev: ApplyCheckState | undefined,
  outcome: LinkOutcome,
  now: Date
): { state: ApplyCheckState; shouldClose: boolean } {
  const base: ApplyCheckState = { ...prev, status: outcome, lastCheckedAt: now }
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
