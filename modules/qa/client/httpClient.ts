import type { RouteCallRecord } from '../agent/types'

export interface HttpClientOptions {
  baseUrl: string
  sessionCookie: string
  defaultHeaders?: Record<string, string>
}

export class QaHttpClient {
  private readonly baseUrl: string
  private readonly cookie: string
  private readonly defaultHeaders: Record<string, string>
  readonly routeLog: RouteCallRecord[] = []

  constructor(opts: HttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.cookie = opts.sessionCookie
    this.defaultHeaders = opts.defaultHeaders ?? {}
  }

  async request<T = unknown>(args: {
    phase: RouteCallRecord['phase']
    method: string
    route: string
    body?: unknown
    questionIndex?: number
    requestSummary?: Record<string, unknown>
  }): Promise<{ status: number; ok: boolean; data: T; durationMs: number; rawText: string }> {
    const url = `${this.baseUrl}${args.route.startsWith('/') ? args.route : `/${args.route}`}`
    const started = Date.now()
    let status = 0
    let rawText = ''
    let data: T = {} as T
    let error: string | undefined

    try {
      const res = await fetch(url, {
        method: args.method,
        headers: {
          'Content-Type': 'application/json',
          Cookie: this.cookie,
          ...this.defaultHeaders,
        },
        body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
      })
      status = res.status
      rawText = await res.text()
      try {
        data = rawText ? (JSON.parse(rawText) as T) : ({} as T)
      } catch {
        data = { raw: rawText } as T
      }

      const record: RouteCallRecord = {
        phase: args.phase,
        method: args.method,
        route: args.route.split('?')[0],
        status,
        durationMs: Date.now() - started,
        ok: res.ok,
        questionIndex: args.questionIndex,
        requestSummary: args.requestSummary,
        responseSummary: summarizeResponse(data),
        error: res.ok ? undefined : rawText.slice(0, 500),
      }
      this.routeLog.push(record)
      return { status, ok: res.ok, data, durationMs: record.durationMs, rawText }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      const record: RouteCallRecord = {
        phase: args.phase,
        method: args.method,
        route: args.route.split('?')[0],
        status: status || 0,
        durationMs: Date.now() - started,
        ok: false,
        questionIndex: args.questionIndex,
        requestSummary: args.requestSummary,
        error,
      }
      this.routeLog.push(record)
      throw err
    }
  }

  async requestSse(args: {
    phase: RouteCallRecord['phase']
    method: string
    route: string
    body?: unknown
    requestSummary?: Record<string, unknown>
  }): Promise<{ events: Array<{ event: string; data: unknown }>; durationMs: number; status: number }> {
    const url = `${this.baseUrl}${args.route.startsWith('/') ? args.route : `/${args.route}`}`
    const started = Date.now()
    const res = await fetch(url, {
      method: args.method,
      headers: {
        'Content-Type': 'application/json',
        Cookie: this.cookie,
        Accept: 'text/event-stream',
        ...this.defaultHeaders,
      },
      body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
    })
    const rawText = await res.text()
    const events = parseSse(rawText)
    const record: RouteCallRecord = {
      phase: args.phase,
      method: args.method,
      route: args.route.split('?')[0],
      status: res.status,
      durationMs: Date.now() - started,
      ok: res.ok,
      requestSummary: args.requestSummary,
      responseSummary: { eventCount: events.length, lastEvent: events.at(-1)?.event },
      error: res.ok ? undefined : rawText.slice(0, 500),
    }
    this.routeLog.push(record)
    return { events, durationMs: record.durationMs, status: res.status }
  }

  drainRouteLog(fromIndex = 0): RouteCallRecord[] {
    return this.routeLog.slice(fromIndex)
  }
}

function summarizeResponse(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object') return { type: typeof data }
  const o = data as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of [
    'sessionId',
    'question',
    'overall_score',
    'status',
    'error',
    'isFallback',
    'pass_probability',
    'jobId',
    'pathwayGenerationStatus',
    'questions',
  ]) {
    if (key in o) out[key] = o[key]
  }
  if (Array.isArray(o.questions)) out.questionsCount = o.questions.length
  return out
}

function parseSse(raw: string): Array<{ event: string; data: unknown }> {
  const events: Array<{ event: string; data: unknown }> = []
  const blocks = raw.split('\n\n')
  for (const block of blocks) {
    if (!block.trim()) continue
    let event = 'message'
    let dataStr = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      if (line.startsWith('data:')) dataStr += line.slice(5).trim()
    }
    if (!dataStr) continue
    try {
      events.push({ event, data: JSON.parse(dataStr) })
    } catch {
      events.push({ event, data: dataStr })
    }
  }
  return events
}

export async function verifyAuth(client: QaHttpClient): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await client.request<{ sessions?: unknown[] }>({
      phase: 'setup',
      method: 'GET',
      route: '/api/interviews?limit=1',
    })
    if (res.status === 401) return { ok: false, detail: 'Unauthorized — check QA_SESSION_COOKIE' }
    return { ok: res.ok, detail: res.ok ? 'Session cookie valid' : `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}
