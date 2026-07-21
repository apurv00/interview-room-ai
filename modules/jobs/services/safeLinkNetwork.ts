import { promises as dns, type LookupAddress } from 'node:dns'
import * as http from 'node:http'
import * as https from 'node:https'
import type { IncomingMessage } from 'node:http'
import ipaddr from 'ipaddr.js'

/**
 * Network boundary for attacker-influenced apply URLs.
 *
 * URL validation and a DNS preflight are not enough: a normal fetch resolves
 * the hostname again when it opens the socket, which leaves a DNS-rebinding
 * gap. This module resolves once, rejects the entire answer set unless every
 * address is global unicast, and supplies only a vetted address to the actual
 * connection while retaining the original hostname for Host/SNI/cert checks.
 */

export const LINK_DNS_TIMEOUT_MS = 4_000
export const LINK_BODY_CAP_BYTES = 100_000

const USER_AGENT = 'InterviewPrepGuruBot/1.0 (+https://www.interviewprep.guru/jobs-bot)'
const MAX_URL_LENGTH = 8_192
const MAX_PINNED_ADDRESS_ATTEMPTS = 8
const IPV6_GLOBAL_UNICAST_PREFIX = ipaddr.IPv6.parse('2000::')

export interface PinnedAddress {
  address: string
  family: 4 | 6
}

export type LinkResolveImpl = (hostname: string) => Promise<LookupAddress[]>

export interface PinnedHttpResponse {
  status: number
  location?: string
  bodyText: string
}

export type PinnedRequestImpl = (
  url: URL,
  address: PinnedAddress,
  signal: AbortSignal,
) => Promise<PinnedHttpResponse>

export type LinkRequestResult =
  | ({ kind: 'response' } & PinnedHttpResponse)
  | { kind: 'nxdomain' }
  | { kind: 'unverifiable'; code?: string }
  | { kind: 'authority-changed' }

export type LinkNetworkAuthorityCheck = () => boolean | void | Promise<boolean | void>

export interface LinkRequestOptions {
  signal: AbortSignal
  beforePhysicalRequest?: LinkNetworkAuthorityCheck
}

export type LinkRequestImpl = (url: URL, options: LinkRequestOptions) => Promise<LinkRequestResult>

export interface SafeLinkRequestDependencies {
  resolve?: LinkResolveImpl
  requestPinned?: PinnedRequestImpl
  dnsTimeoutMs?: number
}

function hostnameWithoutBrackets(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
}

function normalizeDnsHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, '')
}

/** Global-unicast allow policy. All transition/special-purpose IPv6 ranges
 * are rejected. IPv4-mapped IPv6 is allowed only when the embedded IPv4 is
 * itself global unicast. */
export function isGlobalUnicastAddress(address: string): boolean {
  if (!address || address.includes('%')) return false
  try {
    const parsed = ipaddr.parse(address)
    if (parsed.kind() === 'ipv4') return parsed.range() === 'unicast'
    const ipv6 = parsed as ipaddr.IPv6
    if (ipv6.isIPv4MappedAddress()) return ipv6.toIPv4Address().range() === 'unicast'
    // ipaddr's default bucket is named "unicast" even for currently
    // unallocated space. IPv6 global unicast is 2000::/3; require both.
    return ipv6.range() === 'unicast' && ipv6.match(IPV6_GLOBAL_UNICAST_PREFIX, 3)
  } catch {
    return false
  }
}

function pinnedAddressOf(answer: LookupAddress): PinnedAddress | null {
  if (!isGlobalUnicastAddress(answer.address)) return null
  try {
    const parsed = ipaddr.parse(answer.address)
    const family = parsed.kind() === 'ipv4' ? 4 : 6
    if (answer.family !== family) return null
    return {
      address: parsed.kind() === 'ipv4'
        ? parsed.toString()
        : (parsed as ipaddr.IPv6).toRFC5952String(),
      family,
    }
  } catch {
    return null
  }
}

/** Canonical request policy: absolute credential-free HTTP(S), no fragments,
 * default scheme ports only, and only global-unicast IP literals. */
export function canonicalizeCheckableLink(input: string | URL): URL | null {
  const raw = String(input)
  if (!raw || raw.length > MAX_URL_LENGTH) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  // WHATWG normalizes an explicitly supplied default port to ''. Anything
  // left here is a non-default port and is outside this outbound allowlist.
  if (url.port) return null
  url.hash = ''

  let hostname = hostnameWithoutBrackets(url)
  const literal = ipaddr.isValid(hostname)
  if (!literal) {
    hostname = normalizeDnsHostname(hostname)
    if (!hostname) return null
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) return null
    try {
      url.hostname = hostname
    } catch {
      return null
    }
  } else if (!isGlobalUnicastAddress(hostname)) {
    return null
  }
  return url
}

async function defaultResolve(hostname: string): Promise<LookupAddress[]> {
  return dns.lookup(hostname, { all: true, verbatim: true })
}

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code })
}

function errorCode(error: unknown): string | undefined {
  const direct = (error as { code?: unknown } | null)?.code
  if (typeof direct === 'string') return direct
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code
  return typeof cause === 'string' ? cause : undefined
}

function withDnsBudget<T>(promise: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = () => finish(() => reject(codedError('ABORT_ERR')))
    const timer = setTimeout(() => finish(() => reject(codedError('DNS_TIMEOUT'))), timeoutMs)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    )
  })
}

type PinnedResolution =
  | { kind: 'addresses'; addresses: PinnedAddress[] }
  | { kind: 'nxdomain' }
  | { kind: 'unverifiable'; code?: string }

async function resolvePinnedAddresses(
  url: URL,
  resolveImpl: LinkResolveImpl,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<PinnedResolution> {
  const hostname = hostnameWithoutBrackets(url)
  if (ipaddr.isValid(hostname)) {
    const parsed = ipaddr.parse(hostname)
    const answer: LookupAddress = {
      address: parsed.kind() === 'ipv4'
        ? parsed.toString()
        : (parsed as ipaddr.IPv6).toRFC5952String(),
      family: parsed.kind() === 'ipv4' ? 4 : 6,
    }
    const pinned = pinnedAddressOf(answer)
    return pinned ? { kind: 'addresses', addresses: [pinned] } : { kind: 'unverifiable' }
  }

  let answers: LookupAddress[]
  try {
    answers = await withDnsBudget(resolveImpl(hostname), signal, timeoutMs)
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOTFOUND' || code === 'ENODATA') return { kind: 'nxdomain' }
    return { kind: 'unverifiable', code }
  }
  if (answers.length === 0) return { kind: 'unverifiable', code: 'DNS_EMPTY' }

  const addresses: PinnedAddress[] = []
  const seen = new Set<string>()
  for (const answer of answers) {
    const pinned = pinnedAddressOf(answer)
    // One non-global, malformed, or family-mismatched answer poisons the set.
    if (!pinned) return { kind: 'unverifiable', code: 'DNS_NON_GLOBAL' }
    const key = `${pinned.family}:${pinned.address}`
    if (!seen.has(key)) {
      seen.add(key)
      addresses.push(pinned)
    }
  }
  return addresses.length
    ? { kind: 'addresses', addresses }
    : { kind: 'unverifiable', code: 'DNS_EMPTY' }
}

function addressesEquivalent(left: string, right: string): boolean {
  try {
    return ipaddr.process(left).toString() === ipaddr.process(right).toString()
  } catch {
    return false
  }
}

function isApprovedRemote(remoteAddress: string | undefined, addresses: readonly PinnedAddress[]): boolean {
  return !!remoteAddress
    && isGlobalUnicastAddress(remoteAddress)
    && addresses.some((candidate) => addressesEquivalent(remoteAddress, candidate.address))
}

/** Byte-bound reader kept separate so the security limit is testable without
 * opening a real socket. `onCap` must tear down the underlying response. */
export async function readCappedLinkBody(
  stream: AsyncIterable<Uint8Array | string>,
  onCap: () => void,
): Promise<string> {
  const chunks: Buffer[] = []
  let consumed = 0
  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
    const remaining = LINK_BODY_CAP_BYTES - consumed
    if (remaining > 0) {
      const accepted = chunk.subarray(0, remaining)
      chunks.push(accepted)
      consumed += accepted.length
    }
    if (consumed >= LINK_BODY_CAP_BYTES) {
      onCap()
      break
    }
  }
  return Buffer.concat(chunks, consumed).toString('utf8')
}

async function consumeResponse(res: IncomingMessage): Promise<PinnedHttpResponse> {
  const status = res.statusCode ?? 0
  const rawLocation = res.headers.location
  const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation

  // Redirect and non-success bodies are irrelevant to classification. Destroy
  // instead of draining an attacker-controlled stream.
  if (status < 200 || status >= 300) {
    res.destroy()
    return { status, location, bodyText: '' }
  }

  const contentEncoding = String(res.headers['content-encoding'] ?? '').trim().toLowerCase()
  if (contentEncoding && contentEncoding !== 'identity') {
    res.destroy()
    throw codedError('UNSUPPORTED_CONTENT_ENCODING')
  }

  const bodyText = await readCappedLinkBody(res, () => res.destroy())
  return { status, location, bodyText }
}

/** Open one request through a lookup callback that can return only the first
 * vetted address. The original hostname remains in request options, so HTTPS
 * still validates the certificate and sends SNI for that hostname. */
export function buildPinnedRequestOptions(
  url: URL,
  selected: PinnedAddress,
): https.RequestOptions & { autoSelectFamily: boolean } {
  const hostname = hostnameWithoutBrackets(url)
  return {
    protocol: url.protocol,
    hostname,
    port: url.protocol === 'https:' ? 443 : 80,
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    agent: false,
    family: selected.family,
    autoSelectFamily: false,
    lookup: (lookupHostname, _options, callback) => {
      if (normalizeDnsHostname(lookupHostname) !== normalizeDnsHostname(hostname)) {
        callback(codedError('PINNED_HOSTNAME_MISMATCH'), '', 4)
        return
      }
      callback(null, selected.address, selected.family)
    },
    headers: {
      Host: url.host,
      'User-Agent': USER_AGENT,
      Accept: 'text/html,*/*',
      'Accept-Encoding': 'identity',
    },
    rejectUnauthorized: true,
    // SNI is a DNS hostname, never the pinned address. IP-literal HTTPS
    // still receives normal IP-SAN certificate validation without SNI.
    servername: ipaddr.isValid(hostname) ? undefined : hostname,
  }
}

async function defaultPinnedRequest(
  url: URL,
  selected: PinnedAddress,
  signal: AbortSignal,
): Promise<PinnedHttpResponse> {
  const client = url.protocol === 'https:' ? https : http

  return new Promise<PinnedHttpResponse>((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }
    const requestOptions = {
      ...buildPinnedRequestOptions(url, selected),
      signal,
    }
    const req = client.request(requestOptions, (res) => {
      if (!isApprovedRemote(res.socket.remoteAddress, [selected])) {
        const error = codedError('REMOTE_ADDRESS_MISMATCH')
        res.destroy(error)
        req.destroy(error)
        settle(() => reject(error))
        return
      }
      consumeResponse(res).then(
        (response) => settle(() => resolve(response)),
        (error) => settle(() => reject(error)),
      )
    })
    req.once('error', (error) => settle(() => reject(error)))
    req.end()
  })
}

async function authorityStillAllows(check?: LinkNetworkAuthorityCheck): Promise<boolean> {
  if (!check) return true
  try {
    return (await check()) !== false
  } catch {
    return false
  }
}

/** Build a single request primitive that owns both resolution and connection.
 * Tests may inject a resolver and a pinned connector, but there is no API for
 * an independent fetch that can silently perform a second DNS lookup. */
export function createSafeLinkRequest(
  dependencies: SafeLinkRequestDependencies = {},
): LinkRequestImpl {
  const resolveImpl = dependencies.resolve ?? defaultResolve
  const requestPinned = dependencies.requestPinned ?? defaultPinnedRequest
  const dnsTimeoutMs = dependencies.dnsTimeoutMs ?? LINK_DNS_TIMEOUT_MS

  return async (inputUrl, options) => {
    const url = canonicalizeCheckableLink(inputUrl)
    if (!url) return { kind: 'unverifiable', code: 'URL_REJECTED' }
    if (!(await authorityStillAllows(options.beforePhysicalRequest))) return { kind: 'authority-changed' }

    const resolution = await resolvePinnedAddresses(url, resolveImpl, options.signal, dnsTimeoutMs)
    // Bind DNS-derived outcomes too. A revoke landing during NXDOMAIN,
    // SERVFAIL, timeout, or a poisoned answer set must discard that stale
    // observation even though no socket will be opened.
    if (!(await authorityStillAllows(options.beforePhysicalRequest))) return { kind: 'authority-changed' }
    if (resolution.kind !== 'addresses') return resolution

    let refusedAttempts = 0
    let lastNonRefusedCode: string | undefined
    // A CDN/dual-stack hostname may return one temporarily unavailable
    // address alongside a live one. Try a bounded subset of the already-
    // vetted set; never re-resolve, and authority-gate every socket attempt.
    const attemptedAddresses = resolution.addresses.slice(0, MAX_PINNED_ADDRESS_ATTEMPTS)
    for (let index = 0; index < attemptedAddresses.length; index += 1) {
      const address = attemptedAddresses[index]
      // The post-DNS check above authorizes attempt zero. Every fallback is a
      // new physical request and therefore receives a fresh authority read.
      if (index > 0 && !(await authorityStillAllows(options.beforePhysicalRequest))) return { kind: 'authority-changed' }
      try {
        const response = await requestPinned(url, address, options.signal)
        return { kind: 'response', ...response }
      } catch (error) {
        const code = errorCode(error)
        if (code === 'ECONNREFUSED') refusedAttempts += 1
        else lastNonRefusedCode = code
        if (options.signal.aborted) return { kind: 'unverifiable', code: code ?? 'ABORT_ERR' }
      }
    }
    const exhaustedEntireSet = attemptedAddresses.length === resolution.addresses.length
    return exhaustedEntireSet && refusedAttempts === attemptedAddresses.length
      ? { kind: 'unverifiable', code: 'ECONNREFUSED' }
      : { kind: 'unverifiable', code: lastNonRefusedCode ?? 'ADDRESS_ATTEMPT_CAP' }
  }
}

export const safeLinkRequest = createSafeLinkRequest()
