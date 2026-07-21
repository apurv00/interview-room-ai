import { promises as dns, type LookupAddress } from 'node:dns'
import * as http from 'node:http'
import * as https from 'node:https'
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import ipaddr from 'ipaddr.js'

const DEFAULT_DNS_TIMEOUT_MS = 4_000
const MAX_URL_LENGTH = 8_192
const MAX_ADDRESS_ATTEMPTS = 8
const IPV6_GLOBAL_UNICAST_PREFIX = ipaddr.IPv6.parse('2000::')
const TERMINAL_NETWORK_CODES = new Set([
  'BODY_TOO_LARGE',
  'PINNED_HOSTNAME_MISMATCH',
  'REMOTE_ADDRESS_MISMATCH',
  'UNSUPPORTED_CONTENT_ENCODING',
])

export interface PinnedAddress {
  address: string
  family: 4 | 6
}

export type PinnedResolveImpl = (hostname: string) => Promise<LookupAddress[]>

export type PinnedResolution =
  | { kind: 'addresses'; addresses: PinnedAddress[] }
  | { kind: 'nxdomain' }
  | { kind: 'unverifiable'; code?: string }

export type BeforePinnedRequestResult = boolean | void | { allowed: false; reason: string }

export interface PinnedHttpRequest {
  url: string | URL
  method?: 'GET' | 'POST'
  headers?: HeadersInit
  body?: string | Uint8Array
  signal: AbortSignal
  maxResponseBytes: number
  dnsTimeoutMs?: number
  beforePhysicalRequest?: () => BeforePinnedRequestResult | Promise<BeforePinnedRequestResult>
}

export interface PinnedConnectRequest {
  url: URL
  method: 'GET' | 'POST'
  headers?: HeadersInit
  body?: Uint8Array
  signal: AbortSignal
  maxResponseBytes: number
}

export interface PinnedHttpResponse {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
}

export type PinnedConnectImpl = (
  request: PinnedConnectRequest,
  address: PinnedAddress,
) => Promise<PinnedHttpResponse>

export type PinnedHttpResult =
  | ({ kind: 'response'; socketAttempts: number } & PinnedHttpResponse)
  | { kind: 'network-error'; code: string; retryable: boolean; socketAttempts: number }
  | { kind: 'authority-changed'; socketAttempts: number }
  | { kind: 'request-rejected'; reason: string; socketAttempts: number }

export type PinnedHttpRequestImpl = (request: PinnedHttpRequest) => Promise<PinnedHttpResult>

export interface PinnedHttpClientDependencies {
  resolve?: PinnedResolveImpl
  connect?: PinnedConnectImpl
  dnsTimeoutMs?: number
  maxAddressAttempts?: number
}

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code })
}

export function pinnedHttpErrorCode(error: unknown): string | undefined {
  const direct = (error as { code?: unknown } | null)?.code
  if (typeof direct === 'string') return direct
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code
  return typeof cause === 'string' ? cause : undefined
}

function hostnameWithoutBrackets(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
}

function normalizeDnsHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, '')
}

/** Global-unicast only: private, loopback, transition and special ranges fail. */
export function isGlobalUnicastAddress(address: string): boolean {
  if (!address || address.includes('%')) return false
  try {
    const parsed = ipaddr.parse(address)
    if (parsed.kind() === 'ipv4') return parsed.range() === 'unicast'
    const ipv6 = parsed as ipaddr.IPv6
    if (ipv6.isIPv4MappedAddress()) return ipv6.toIPv4Address().range() === 'unicast'
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

export function canonicalizePinnedUrl(input: string | URL): URL | null {
  const raw = String(input)
  if (!raw || raw.length > MAX_URL_LENGTH) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password || url.port || url.hash) return null

  let hostname = hostnameWithoutBrackets(url)
  if (ipaddr.isValid(hostname)) {
    if (!isGlobalUnicastAddress(hostname)) return null
  } else {
    hostname = normalizeDnsHostname(hostname)
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) return null
    try {
      url.hostname = hostname
    } catch {
      return null
    }
  }
  return url
}

async function defaultResolve(hostname: string): Promise<LookupAddress[]> {
  return dns.lookup(hostname, { all: true, verbatim: true })
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

/** Resolve once and reject the entire answer set if any address is unsafe. */
export async function resolvePinnedAddresses(
  url: URL,
  resolveImpl: PinnedResolveImpl,
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
    return pinned
      ? { kind: 'addresses', addresses: [pinned] }
      : { kind: 'unverifiable', code: 'DNS_NON_GLOBAL' }
  }

  if (signal.aborted) return { kind: 'unverifiable', code: 'ABORT_ERR' }
  let answers: LookupAddress[]
  try {
    answers = await withDnsBudget(resolveImpl(hostname), signal, timeoutMs)
  } catch (error) {
    const code = pinnedHttpErrorCode(error)
    if (code === 'ENOTFOUND' || code === 'ENODATA') return { kind: 'nxdomain' }
    return { kind: 'unverifiable', code }
  }
  if (answers.length === 0) return { kind: 'unverifiable', code: 'DNS_EMPTY' }

  const addresses: PinnedAddress[] = []
  const seen = new Set<string>()
  for (const answer of answers) {
    const pinned = pinnedAddressOf(answer)
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

export function isApprovedPinnedRemote(
  remoteAddress: string | undefined,
  addresses: readonly PinnedAddress[],
): boolean {
  return !!remoteAddress
    && isGlobalUnicastAddress(remoteAddress)
    && addresses.some((candidate) => addressesEquivalent(remoteAddress, candidate.address))
}

const BLOCKED_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'proxy-authorization',
  'transfer-encoding',
  'upgrade',
])

function safeRequestHeaders(
  url: URL,
  source: HeadersInit | undefined,
  bodyLength: number,
): Record<string, string> {
  const headers: Record<string, string> = {}
  const input = new Headers(source)
  input.forEach((value, name) => {
    if (!BLOCKED_REQUEST_HEADERS.has(name.toLowerCase())) headers[name] = value
  })
  headers.Host = url.host
  headers['Accept-Encoding'] = 'identity'
  if (bodyLength > 0) headers['Content-Length'] = String(bodyLength)
  return headers
}

/** Socket options retain original Host/SNI/certificate checks but pin lookup. */
export function buildPinnedConnectionOptions(
  request: Pick<PinnedConnectRequest, 'url' | 'method' | 'headers' | 'body'>,
  selected: PinnedAddress,
): https.RequestOptions & { autoSelectFamily: boolean } {
  const { url } = request
  const hostname = hostnameWithoutBrackets(url)
  return {
    protocol: url.protocol,
    hostname,
    port: url.protocol === 'https:' ? 443 : 80,
    path: `${url.pathname}${url.search}`,
    method: request.method,
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
    headers: safeRequestHeaders(url, request.headers, request.body?.byteLength ?? 0),
    rejectUnauthorized: true,
    servername: ipaddr.isValid(hostname) ? undefined : hostname,
  }
}

/** Read streaming bytes and reject rather than returning a truncated payload. */
export async function readCappedPinnedBody(
  stream: AsyncIterable<Uint8Array | string>,
  maxBytes: number,
  onCap: (error: Error) => void,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw codedError('INVALID_BODY_CAP')
  const chunks: Buffer[] = []
  let consumed = 0
  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
    if (chunk.length > maxBytes - consumed) {
      const error = codedError('BODY_TOO_LARGE')
      onCap(error)
      throw error
    }
    chunks.push(chunk)
    consumed += chunk.length
  }
  return Buffer.concat(chunks, consumed)
}

async function consumePinnedResponse(
  response: IncomingMessage,
  maxResponseBytes: number,
): Promise<PinnedHttpResponse> {
  const status = response.statusCode ?? 0
  if (status < 200 || status >= 300) {
    response.destroy()
    return { status, headers: response.headers, body: Buffer.alloc(0) }
  }

  const encoding = String(response.headers['content-encoding'] ?? '').trim().toLowerCase()
  if (encoding && encoding !== 'identity') {
    const error = codedError('UNSUPPORTED_CONTENT_ENCODING')
    response.destroy(error)
    throw error
  }
  const contentLength = Number(response.headers['content-length'])
  if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
    const error = codedError('BODY_TOO_LARGE')
    response.destroy(error)
    throw error
  }
  const body = await readCappedPinnedBody(
    response,
    maxResponseBytes,
    (error) => response.destroy(error),
  )
  return { status, headers: response.headers, body }
}

async function defaultPinnedConnect(
  request: PinnedConnectRequest,
  selected: PinnedAddress,
): Promise<PinnedHttpResponse> {
  const client = request.url.protocol === 'https:' ? https : http
  return new Promise<PinnedHttpResponse>((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }
    const req = client.request({
      ...buildPinnedConnectionOptions(request, selected),
      signal: request.signal,
    }, (response) => {
      if (!isApprovedPinnedRemote(response.socket.remoteAddress, [selected])) {
        const error = codedError('REMOTE_ADDRESS_MISMATCH')
        response.destroy(error)
        req.destroy(error)
        settle(() => reject(error))
        return
      }
      consumePinnedResponse(response, request.maxResponseBytes).then(
        (result) => settle(() => resolve(result)),
        (error) => settle(() => reject(error)),
      )
    })
    req.once('error', (error) => settle(() => reject(error)))
    if (request.body?.byteLength) req.write(request.body)
    req.end()
  })
}

async function requestPermission(
  check?: PinnedHttpRequest['beforePhysicalRequest'],
): Promise<'allowed' | 'authority-changed' | { rejected: string }> {
  if (!check) return 'allowed'
  try {
    const permission = await check()
    if (permission === false) return 'authority-changed'
    if (permission && typeof permission === 'object' && permission.allowed === false) {
      return { rejected: permission.reason }
    }
    return 'allowed'
  } catch {
    return 'authority-changed'
  }
}

/**
 * Resolve once, validate every DNS answer, then pin every socket to one of
 * those vetted answers. DNS itself never consumes an authority/quota claim;
 * the callback runs exactly once immediately before each connector attempt.
 */
export function createPinnedHttpClient(
  dependencies: PinnedHttpClientDependencies = {},
): PinnedHttpRequestImpl {
  const resolveImpl = dependencies.resolve ?? defaultResolve
  const connect = dependencies.connect ?? defaultPinnedConnect
  const dnsTimeoutMs = dependencies.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS
  const maxAddressAttempts = dependencies.maxAddressAttempts ?? MAX_ADDRESS_ATTEMPTS

  return async (input) => {
    const url = canonicalizePinnedUrl(input.url)
    if (!url || url.protocol !== 'https:') {
      return { kind: 'network-error', code: 'URL_REJECTED', retryable: false, socketAttempts: 0 }
    }
    const method = input.method ?? 'GET'
    const requestBodyLength = typeof input.body === 'string'
      ? Buffer.byteLength(input.body)
      : input.body?.byteLength ?? 0
    if ((method !== 'GET' && method !== 'POST') || (method === 'GET' && requestBodyLength > 0)) {
      return { kind: 'network-error', code: 'REQUEST_REJECTED', retryable: false, socketAttempts: 0 }
    }
    if (!Number.isSafeInteger(input.maxResponseBytes) || input.maxResponseBytes <= 0) {
      return { kind: 'network-error', code: 'INVALID_BODY_CAP', retryable: false, socketAttempts: 0 }
    }

    const resolution = await resolvePinnedAddresses(
      url,
      resolveImpl,
      input.signal,
      input.dnsTimeoutMs ?? dnsTimeoutMs,
    )
    if (resolution.kind !== 'addresses') {
      const code = resolution.kind === 'nxdomain' ? 'ENOTFOUND' : resolution.code ?? 'DNS_UNVERIFIABLE'
      const retryable = code !== 'DNS_NON_GLOBAL' && code !== 'DNS_EMPTY' && code !== 'ABORT_ERR'
      return { kind: 'network-error', code, retryable, socketAttempts: 0 }
    }

    let socketAttempts = 0
    let lastCode = 'CONNECTION_FAILED'
    for (const address of resolution.addresses.slice(0, maxAddressAttempts)) {
      const permission = await requestPermission(input.beforePhysicalRequest)
      if (permission === 'authority-changed') return { kind: 'authority-changed', socketAttempts }
      if (permission !== 'allowed') {
        return { kind: 'request-rejected', reason: permission.rejected, socketAttempts }
      }

      socketAttempts += 1
      try {
        const response = await connect({
          url,
          method,
          headers: input.headers,
          body: input.body instanceof Uint8Array ? input.body : input.body ? Buffer.from(input.body) : undefined,
          signal: input.signal,
          maxResponseBytes: input.maxResponseBytes,
        }, address)
        return { kind: 'response', ...response, socketAttempts }
      } catch (error) {
        lastCode = pinnedHttpErrorCode(error) ?? 'CONNECTION_FAILED'
        if (input.signal.aborted || TERMINAL_NETWORK_CODES.has(lastCode)) {
          return {
            kind: 'network-error',
            code: input.signal.aborted ? 'ABORT_ERR' : lastCode,
            retryable: false,
            socketAttempts,
          }
        }
      }
    }
    return { kind: 'network-error', code: lastCode, retryable: true, socketAttempts }
  }
}

export const pinnedHttpRequest = createPinnedHttpClient()
